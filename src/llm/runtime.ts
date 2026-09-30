import { createHash } from 'node:crypto'
import {
  APICallError,
  RetryError,
  ToolChoiceViolationError,
  generateText,
  jsonSchema,
  tool,
  wrapLanguageModel,
  zodSchema,
  type ModelMessage,
  type Schema,
  type ToolSet,
} from 'ai'
import type {
  AgentName,
  GenerateOptions,
  GenerateRequest,
  ModelToolSpec,
  GenerateResult,
  LlmClient,
  ModelToolCall,
  TokenUsage,
  Transcript,
} from './client.js'
import type { OpenRecording, TurnRecord } from './recording.js'
import {
  ModelOutputLimitError,
  ModelRefusalError,
  ModelTimeoutError,
  ProviderCallError,
  summarise,
  type Callee,
  type ProviderFailure,
} from './failures.js'
import { DEFAULT_TIMEOUT_SECONDS, KEY_VARIABLES, modelFor, type ModelChoice } from './providers.js'
import { objectRooted, type JsonSchema } from './tool-schema.js'

/**
 * One of the two files that import the model SDK — `providers.ts` is the other
 * (design § 10, and llm/README.md). The rule is about the folder: it is what
 * lets `llm/client.ts` stay free of the SDK — `agents/` imports that file, and
 * the architecture rule walks the closure through it.
 */

const sha256 = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

/**
 * A request's digest in each scheme a turn may have been recorded under, each
 * prefixed with its name. Compared, never keyed on: keying on it would
 * invalidate every recording on a comma. `recording.ts` compares a turn with
 * the one in its own scheme.
 *
 *   sent:sha256:  the request as a provider is shown it — the system prompt,
 *                 the transcript, the tool choice, and each tool's name,
 *                 description and advertised JSON Schema. What a turn is
 *                 recorded under since 2026-09-30.
 *   sha256:       the request as the agents built it, each tool's parameters
 *                 as Zod holds them. Blind to what a model reads of a field —
 *                 `.describe` lives in a registry, a `max` or a `regex`
 *                 stringifies as `{}` — and moved by a Zod upgrade that sends
 *                 the same bytes (tests-6, wip-diff-12). Every turn recorded
 *                 before 2026-09-30 holds it, and it cannot be recomputed in
 *                 the other scheme from the tape: a turn stores neither its
 *                 tools nor its tool choice, and its transcript was stored by
 *                 reference, grown past what was sent. So it is still
 *                 computed, and such a turn keeps the verdict it had, stale or
 *                 fresh, until it is recorded again.
 */
async function digestsOf(request: GenerateRequest): Promise<readonly [string, string]> {
  return [`sent:sha256:${sha256(await sentOf(request))}`, `sha256:${sha256(request)}`]
}

/** What a provider is sent of a request, as far as it is the request's to say. */
async function sentOf(request: GenerateRequest): Promise<unknown> {
  return {
    agent: request.agent,
    system: request.system,
    transcript: request.transcript,
    toolChoice: request.toolChoice,
    tools: await Promise.all(
      request.tools.map(async (spec) => ({
        name: spec.name,
        description: spec.description,
        inputSchema: await advertisedSchema(spec),
      })),
    ),
  }
}

/** The provider-normalised content parts, as the SDK returns and we store them. */
interface TextPart {
  type: 'text'
  text: string
}
interface ToolCallPart {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  input: unknown
}
type ContentPart = TextPart | ToolCallPart | { type: string }

const isText = (part: ContentPart): part is TextPart => part.type === 'text'
const isToolCall = (part: ContentPart): part is ToolCallPart => part.type === 'tool-call'

function readContent(content: unknown[]): { text: string; toolCalls: ModelToolCall[] } {
  const parts = content as ContentPart[]
  return {
    text: parts
      .filter(isText)
      .map((part) => part.text)
      .join(''),
    toolCalls: parts.filter(isToolCall).map((part) => ({
      id: part.toolCallId,
      name: part.toolName,
      args: part.input,
    })),
  }
}

/**
 * The token counts a provider reported, and only those. A count it did not
 * report stays absent rather than becoming 0, and a result with no count at
 * all has no usage: an old recording, or a provider that says nothing.
 */
export function usageOf(raw: unknown): TokenUsage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const read = (key: string): number | undefined => {
    const value = (raw as Record<string, unknown>)[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }
  const inputTokens = read('inputTokens')
  const outputTokens = read('outputTokens')
  const totalTokens = read('totalTokens')
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  }
}

/** Omitted rather than set to undefined: exactOptionalPropertyTypes draws the distinction. */
const withUsage = (usage: TokenUsage | undefined): { usage?: TokenUsage } =>
  usage === undefined ? {} : { usage }

const fromRecord = (record: TurnRecord): GenerateResult => ({
  ...readContent(record.result.content),
  finishReason: record.result.finishReason,
  ...withUsage(usageOf(record.result.usage)),
})

/**
 * The transcript as the SDK takes it, with no assistant message that is empty.
 *
 * An agent keeps a turn where the model said nothing and called nothing — it
 * counts it, and asks again — and that turn used to be sent back as an
 * assistant message with no content: `[]` to Anthropic, whose Messages API
 * refuses one anywhere but last, and `""` with no tool call to Mistral. It is
 * dropped here, and so is a text that is only whitespace, which Anthropic
 * refuses as a text block too. Dropping one leaves the user messages either
 * side of it adjacent; they become one message holding both texts, in order —
 * what `@ai-sdk/anthropic` does itself with consecutive user messages
 * (`groupIntoBlocks`), done here so every provider is sent one shape.
 *
 * The recording digest is taken over the transcript, never over these
 * messages, so a tape holding such a turn would replay unchanged.
 */
export function toMessages(transcript: Transcript[]): ModelMessage[] {
  const messages: ModelMessage[] = []
  for (const entry of transcript) {
    const message = messageOf(entry)
    if (message === undefined) continue
    const last = messages.at(-1)
    if (message.role === 'user' && last?.role === 'user') {
      messages[messages.length - 1] = {
        role: 'user',
        content: [...textParts(last.content), ...textParts(message.content)],
      }
      continue
    }
    messages.push(message)
  }
  return messages
}

/** A user message's content as parts; this file only ever writes text. */
const textParts = (content: string | readonly unknown[]): { type: 'text'; text: string }[] =>
  typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : (content as { type: 'text'; text: string }[])

/** One entry, or nothing for an assistant turn that said and called nothing. */
function messageOf(entry: Transcript): ModelMessage | undefined {
  if (entry.role === 'user') return { role: 'user', content: entry.text }
  if (entry.role === 'assistant') {
    const said = entry.text.trim() !== ''
    if (!said && entry.toolCalls.length === 0) return undefined
    return {
      role: 'assistant',
      content: [
        ...(said ? [{ type: 'text' as const, text: entry.text }] : []),
        ...entry.toolCalls.map((call) => ({
          type: 'tool-call' as const,
          toolCallId: call.id,
          toolName: call.name,
          input: call.args,
        })),
      ],
    }
  }
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: entry.id,
        toolName: entry.name,
        output: { type: 'json', value: entry.result as never },
      },
    ],
  }
}

/**
 * Declared without `execute`: the hand-written loop runs the tools, the SDK
 * only reports the calls (design § 3, low-level mode).
 *
 * `strict: false`, always, and said rather than left to a default. OpenAI's
 * Responses API treats a function tool sent with no `strict` as strict, and
 * strict decoding makes the model fill every property: measured with
 * gpt-6-luna, a search that needed no environment went out with `env: ""`,
 * then `"default"`, then `"*"`, and matched nothing each time — the model even
 * reported that the tool "requires an environment". Every schema here has
 * optional fields, which strict mode cannot express; the agents' own parse is
 * what validates a call. Anthropic ignores the flag on a model without strict
 * tools, with a warning, and Mistral's default is already false.
 */
export function toTools(specs: ModelToolSpec[]): ToolSet {
  return Object.fromEntries(
    specs.map((spec) => [
      spec.name,
      tool({ description: spec.description, inputSchema: advertised(spec), strict: false }),
    ]),
  )
}

/**
 * The SDK's own schema for a spec, with its two halves kept apart on purpose.
 *
 * What a provider is SHOWN goes through `objectRooted`, because a union at the
 * root is refused outright by Anthropic. What the SDK checks a call against is
 * its validator for the Zod schema, untouched — but that check only cleans a
 * valid call: an invalid one comes back flagged, `readContent` does not read
 * the flag, and the agent receives the arguments as sent. The gate is each
 * terminal tool's agent re-parsing them against its own schema and handing a
 * failure back; that, not this validator, is what makes the looser flat
 * advertisement safe.
 *
 * Here and not in the agents' schemas: `spec.parameters` is part of the request
 * the old scheme's digest is taken over, and reshaping it would stale every tape
 * recorded under it that carries the tool. The advertised JSON Schema is what
 * the new scheme digests (`digestsOf`), so a change here stales a turn
 * recorded since.
 */
function advertised(spec: ModelToolSpec): Schema<unknown> {
  const { validate } = zodSchema(spec.parameters)
  // Always set for a Zod schema. Without it the SDK would accept any call.
  if (validate === undefined) throw new Error(`tool "${spec.name}": no validator for its schema`)
  return jsonSchema(() => advertisedSchema(spec), { validate })
}

/** The JSON Schema a provider is shown for a spec: one function, so the digest reads what is sent. */
async function advertisedSchema(spec: ModelToolSpec): Promise<JsonSchema> {
  return objectRooted(await zodSchema(spec.parameters).jsonSchema, spec.name)
}

export function toToolChoice(
  choice: GenerateRequest['toolChoice'],
): 'auto' | 'none' | { type: 'tool'; toolName: string } {
  return typeof choice === 'string' ? choice : { type: 'tool', toolName: choice.tool }
}

/**
 * A turn the agents cannot use, said as such instead of handed back.
 *
 * A turn that stopped on its output limit with nothing in it — no text, no
 * call — would otherwise reach an agent as a barren turn, which it counts and
 * asks again, and the next attempt hits the same limit. A content filter is the
 * provider declining; asking again is asking to be declined again. Both end the
 * run with a line that says which.
 *
 * A turn that hit the limit and still produced a call is returned: the call may
 * be cut short, and the agent's own parse of it is what refuses a broken one.
 */
function usable(result: GenerateResult, callee: Callee): GenerateResult {
  if (result.finishReason === 'content-filter') throw new ModelRefusalError(callee)
  if (
    result.finishReason === 'length' &&
    result.text.trim() === '' &&
    result.toolCalls.length === 0
  ) {
    throw new ModelOutputLimitError(callee)
  }
  return result
}

/**
 * Runs `call` with an abort signal that fires after `seconds`, or when the
 * caller's `stop` does, and gives up on it then whether or not the call
 * honours the signal.
 *
 * The abort reason is a `TimeoutError` by name, which the SDK reads as an
 * abort: it neither wraps it nor retries it. The race is what makes the bound
 * hold for a fetch that ignores its signal — the answer is the timeout error
 * either way, and the request is released either way. A caller's stop is the
 * same abort with the caller's reason, and the call rejects with that reason:
 * it is the caller's to say why, and not a failure of the model.
 *
 * The signal is an argument of the call, never a field of the request: the
 * recording digest is taken over the request, and a timeout that entered it
 * would stale every tape.
 */
async function within<T>(
  seconds: number,
  callee: Callee,
  call: (signal: AbortSignal) => Promise<T>,
  stop?: AbortSignal,
): Promise<T> {
  stop?.throwIfAborted()
  const controller = new AbortController()
  const expiry = new ModelTimeoutError(callee, seconds)
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new DOMException(expiry.message, 'TimeoutError'))
      reject(expiry)
    }, seconds * 1000)
  })
  let onStop: (() => void) | undefined
  const stopped = new Promise<never>((_, reject) => {
    if (stop === undefined) return
    onStop = () => {
      controller.abort(stop.reason)
      reject(stop.reason as Error)
    }
    stop.addEventListener('abort', onStop, { once: true })
  })
  try {
    return await Promise.race([call(controller.signal), expired, stopped])
  } catch (error) {
    if (stop?.aborted === true) throw stop.reason
    throw controller.signal.aborted ? expiry : error
  } finally {
    clearTimeout(timer)
    if (onStop !== undefined) stop?.removeEventListener('abort', onStop)
  }
}

const CONTEXT = /context[_ ]length|context window|maximum context|prompt is too long/i
/**
 * What a provider says about an empty account — OpenAI's code and sentence,
 * Anthropic's credit balance — and never a bare word such as `billing`: the
 * message can quote the request, and the request is a catalogue whose demo
 * services are called billing-api and billing-db.
 */
const QUOTA = /insufficient_quota|exceeded your current quota|credit balance is too low/i
/** The words `agents/forced-turn.ts` falls back on, read here on the whole message. */
const TOOL_CHOICE = /required tool|tool_choice|tool choice|forced tool/i

/**
 * The provider's own code and type, as each adapter parsed them out of the
 * error body: `error.code` and `error.type` for OpenAI and Anthropic, the same
 * at the top level for Mistral. Read instead of the raw body, which is the
 * request echoed back as often as it is the provider's reason.
 */
function codesOf(data: unknown): string {
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const top = record(data)
  const nested = record(top['error'])
  return [top['code'], top['type'], nested['code'], nested['type']]
    .filter((field) => typeof field === 'string')
    .join(' ')
}

/**
 * An HTTP failure, read from the status first and the provider's words only
 * where the status cannot tell: a 400 is a context overflow, an empty account,
 * a refused tool choice or anything else depending on what the provider said —
 * its message and its error code, never the body around them. Only the last
 * two carry those words, summarised — see `failures.ts` for why.
 *
 * Below 400 nothing was refused: the SDK throws the same error, with the
 * response's own status, when a 200 does not parse.
 */
function failureOf(error: APICallError, variable: string): ProviderFailure {
  const status = error.statusCode
  if (status === undefined) return { kind: 'unreachable', summary: summarise(error.message) }
  if (status < 400) return { kind: 'unreadable', status }
  if (status === 401 || status === 403) return { kind: 'key', status, variable }
  const said = `${error.message} ${codesOf(error.data)}`
  if (status === 429) return QUOTA.test(said) ? { kind: 'quota', status } : { kind: 'rate', status }
  if (status >= 500) return { kind: 'provider', status }
  if (QUOTA.test(said)) return { kind: 'quota', status }
  if (CONTEXT.test(said)) return { kind: 'context', status }
  if (TOOL_CHOICE.test(error.message)) {
    return { kind: 'tool-choice', status, summary: summarise(error.message) }
  }
  return { kind: 'refused', status, summary: summarise(error.message) }
}

/**
 * The SDK's HTTP error — alone, or as the last of its retries — as one line.
 *
 * A forced turn that came back without its tool is thrown by the SDK before the
 * finish reason is ever returned, and `forced-turn.ts` retries it as an open
 * turn, which is right for a model that ignored the choice and wrong for one
 * that was cut off or filtered: the open turn hits the same wall. So that error
 * is judged like a returned turn first. Anything else is passed through
 * unchanged, the forced-tool miss included — `forced-turn.ts` reads its message.
 *
 * `last` is the last HTTP failure of the call, if it had one. A timeout that
 * fires while the SDK waits to retry a 429 or a 5xx, or a host it cannot
 * reach, fires on a provider that did answer, or never could: that failure is
 * what happened, and "did not answer" would send the user to raise a timeout
 * the provider was never going to meet.
 */
function translated(error: unknown, choice: ModelChoice, last: APICallError | undefined): unknown {
  if (ToolChoiceViolationError.isInstance(error)) {
    usable({ ...readContent(error.content), finishReason: error.finishReason }, choice)
    return error
  }
  const call =
    error instanceof ModelTimeoutError
      ? last
      : RetryError.isInstance(error)
        ? error.lastError
        : error
  if (!APICallError.isInstance(call)) return error
  return new ProviderCallError(choice, failureOf(call, KEY_VARIABLES[choice.provider]))
}

/**
 * The adapter, with every attempt's HTTP failure handed to `seen`.
 *
 * The SDK retries inside `generateText`, around the model, and says nothing of
 * an attempt until the last one fails — which, on a timeout, it never does.
 * Wrapping the model is the one place each attempt passes through. It changes
 * nothing the provider is sent, and nothing the recording digest is taken over.
 */
function watched(choice: ModelChoice, seen: (error: APICallError) => void) {
  return wrapLanguageModel({
    model: modelFor(choice),
    middleware: {
      wrapGenerate: async ({ doGenerate }) => {
        try {
          return await doGenerate()
        } catch (error) {
          if (APICallError.isInstance(error)) seen(error)
          throw error
        }
      },
    },
  })
}

/**
 * How many times the SDK sends a failed call again — a 429, a 5xx, a host it
 * could not reach — inside the timeout. Its own default, stated, because the
 * retry line counts against it.
 */
const SDK_RETRIES = 2

/** What an agent's calls ask of a provider beyond the request itself. */
export interface AgentCall {
  /** How much the model may reason before it answers, where it can be told. */
  readonly effort?: 'low'
}

/**
 * Per agent, the call settings that are not part of what it asks.
 *
 * The Supervisor answers one word, QUESTION or MUTATION: on the owner's
 * diagnostic run gpt-6-luna spent 22 reasoning tokens on it. Every other agent
 * calls with the provider's defaults, as before.
 *
 * Here and not in `GenerateRequest`: the recording digest is taken over the
 * request, and a setting that entered it would stale every tape the Supervisor
 * is in. Replay builds no adapter and sends nothing, so it never reads this.
 */
export const AGENT_CALLS: Partial<Record<AgentName, AgentCall>> = {
  supervisor: { effort: 'low' },
}

/**
 * An agent's call settings, as the one provider and model it calls understand
 * them.
 *
 *   openai     `store: false`, on every agent's call. Left unsent it is true
 *              on the Responses API, and the conversation — the files the
 *              Inspector read from the user's repository among it — is kept
 *              at OpenAI for nothing: no call here refers back to a stored
 *              one (gap-provider-matrix-6). Then `reasoningEffort`, and
 *              `reasoningSummary: null` — to a model that takes a low effort
 *              (`takesLowEffort`), and nothing to any other. The summary is
 *              held off because the adapter asks for a detailed one whenever
 *              an effort is set, and a summary is output nobody here reads.
 *   anthropic  nothing. Extended thinking is off unless it is asked for, which
 *              is the low effort wanted, and a budget is not a level. It keeps
 *              no conversation to opt out of.
 *   mistral    nothing. Its adapter's effort is `high` or `none`, on the models
 *              that take one; there is no low.
 */
export function providerOptionsOf(
  choice: ModelChoice,
  call: AgentCall | undefined,
): Record<string, Record<string, string | boolean | null>> | undefined {
  switch (choice.provider) {
    case 'openai':
      return call?.effort !== undefined && takesLowEffort(choice.model)
        ? { openai: { store: false, reasoningEffort: call.effort, reasoningSummary: null } }
        : { openai: { store: false } }
    case 'anthropic':
    case 'mistral':
      return undefined
    default: {
      const exhaustive: never = choice.provider
      return exhaustive
    }
  }
}

/**
 * Whether an OpenAI model is sent a low reasoning effort — by the shape of its
 * id, since no model is named here, and in doubt not.
 *
 * First the adapter's own rule for a model that reasons
 * (`getOpenAILanguageModelCapabilities` in `@ai-sdk/openai`, not exported): an
 * o-series id, or gpt-N with N ≥ 5 but a chat variant with no minor version.
 * The adapter drops an effort for any other model, which would refuse it, and
 * says so as a Node warning on stderr in every run — so it is not handed one.
 *
 * Then the ids that rule classes as reasoning and that take no low effort,
 * which the adapter sends one to regardless: it checks the level only from
 * gpt-6 on. A chat variant, with a minor version or not, reasons at its own
 * setting; a pro variant takes only `high`; a deep-research one only `medium`;
 * the first o1 previews, `o1-mini` and `o1-preview`, no effort at all. Sent
 * nothing, each reasons at its default, as every agent did before.
 */
function takesLowEffort(model: string): boolean {
  const oSeries = /^o(\d+)(?:-(.+))?$/.exec(model)
  const gpt = /^gpt-(\d+)(?:\.(\d+))?(?:-(.+))?$/.exec(model)
  let variant: string
  if (oSeries !== null) {
    variant = oSeries[2] ?? ''
    if (oSeries[1] === '1' && /^(mini|preview)(-|$)/.test(variant)) return false
  } else if (gpt !== null && Number(gpt[1]) >= 5) {
    variant = gpt[3] ?? ''
    if (variant.startsWith('chat')) return false
  } else {
    return false
  }
  return !/(^|-)pro(-|$)/.test(variant) && !/(^|-)deep-research(-|$)/.test(variant)
}

/**
 * replay — read a recorded turn, build no adapter, read no credential.
 * record — call the model and write the turn down.
 * live   — call the model and write nothing. This is a real run of the CLI;
 *          it has no scenario to replay and no reason to record one.
 */
export type ClientMode = 'replay' | 'record' | 'live'

export function createClient(options: {
  tape?: OpenRecording
  mode: ClientMode
  choice?: ModelChoice
  /**
   * The agents that call another model than `choice`, on its provider:
   * `agentModelsOf` (IDP_SUPERVISOR_MODEL). A recorded turn names the model it
   * was made against, so replay reads neither.
   */
  models?: Partial<Record<AgentName, ModelChoice>>
  /** Seconds one live call may take, retries included. Replay has no clock. */
  timeout?: number
  /**
   * Where a retry is said, one line each, while the SDK waits to send the call
   * again. Absent says nothing, as before. Replay never retries.
   */
  notice?: (line: string) => void
}): LlmClient {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_SECONDS

  // Counted here, per agent, never derived from content: that is what makes
  // (scenario, agent, turn) a key a changed prompt cannot invalidate.
  const turns = new Map<string, number>()

  return {
    async generate(request: GenerateRequest, call?: GenerateOptions): Promise<GenerateResult> {
      // Before a turn is read or a request built: a stopped run spends no
      // turn number, so the tape it replays is not shifted by it.
      call?.signal?.throwIfAborted()
      // The number is spent only once the call succeeds. A refused forced tool
      // choice is retried as an open one, which is two physical calls for one
      // logical turn while recording and one while replaying — a failed call
      // that consumed a number would punch a hole in the recording and shift
      // every later turn by one.
      const turn = turns.get(request.agent) ?? 0
      const key = { agent: request.agent, turn }
      const spend = (): void => void turns.set(request.agent, turn + 1)

      if (options.mode === 'replay') {
        // No adapter is built and no credential is read: a contributor replays
        // a recording made against a model they have no key for.
        if (options.tape === undefined) throw new Error('replay needs a recording')
        const record = options.tape.replay(key, await digestsOf(request))
        spend()
        return usable(fromRecord(record), record)
      }

      if (options.choice === undefined) {
        throw new Error('recording needs a configured model: set IDP_PROVIDER and IDP_MODEL')
      }
      // The model this agent calls, which is what a failure names and a tape
      // records: IDP_MODEL's, unless the agent was given one of its own.
      const choice = options.models?.[request.agent] ?? options.choice
      const providerOptions = providerOptionsOf(choice, AGENT_CALLS[request.agent])
      // Taken before the call, of the request as it is sent: an agent grows its
      // transcript once the call returns, and a transcript stored by reference
      // showed every turn the last one's (agents-llm-9).
      const taken =
        options.mode === 'record'
          ? { digest: (await digestsOf(request))[0], transcript: structuredClone(request.transcript) }
          : undefined

      // No temperature: it is rejected outright by several current models, and
      // determinism here comes from the recording, not from sampling settings.
      // No maxOutputTokens either: see src/llm/README.md. What bounds a call is
      // the timeout, and the SDK's two retries of a 429 or a 5xx happen inside it.
      //
      // Each attempt that failed is seen here, and one the SDK will send again
      // is said: it retried in silence, and a run sat waiting on a 429 with no
      // line saying why (review, runtime-probe-13). The last failure is not
      // said — the run ends on it, in the error below.
      let last: APICallError | undefined
      let attempts = 0
      const seen = (error: APICallError): void => {
        last = error
        attempts += 1
        if (options.notice === undefined || !error.isRetryable || attempts > SDK_RETRIES) return
        const said = new ProviderCallError(choice, failureOf(error, KEY_VARIABLES[choice.provider]))
        options.notice(
          `${said.message}; retrying the ${request.agent}'s call ` +
            `(attempt ${attempts + 1} of ${SDK_RETRIES + 1})`,
        )
      }
      const response = await within(timeout, choice, (abortSignal) =>
        generateText({
          model: watched(choice, seen),
          maxRetries: SDK_RETRIES,
          system: request.system,
          messages: toMessages(request.transcript),
          tools: toTools(request.tools),
          toolChoice: toToolChoice(request.toolChoice),
          ...(providerOptions !== undefined ? { providerOptions } : {}),
          abortSignal,
        }),
        call?.signal,
      ).catch((error: unknown) => {
        // The caller's own reason, as it gave it: nothing failed at the provider.
        if (call?.signal?.aborted === true) throw error
        throw translated(error, choice, last)
      })

      spend()
      const usage = usageOf(response.usage)

      if (options.mode === 'live') {
        return usable(
          {
            ...readContent(response.content),
            finishReason: response.finishReason,
            ...withUsage(usage),
          },
          choice,
        )
      }

      if (taken !== undefined) {
        options.tape?.record(key, {
          ...key,
          provider: choice.provider,
          model: choice.model,
          digest: taken.digest,
          recordedAt: response.response.timestamp.toISOString(),
          call: { system: request.system, transcript: taken.transcript },
          result: {
            content: response.content,
            finishReason: response.finishReason,
            ...withUsage(usage),
          },
        })
      }
      // Recorded, then judged like a live turn. A run that fails here never
      // saves its tape — the command writes it only after a run that succeeded
      // — and replay judges every turn again, so a tape holding one fails too.
      return usable(
        {
          ...readContent(response.content),
          finishReason: response.finishReason,
          ...withUsage(usage),
        },
        choice,
      )
    },
  }
}
