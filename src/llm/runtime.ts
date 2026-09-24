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
import { objectRooted } from './tool-schema.js'

/**
 * One of the two files that import the model SDK — `providers.ts` is the other
 * (design § 10, and llm/README.md). The rule is about the folder: it is what
 * lets `llm/client.ts` stay free of the SDK — `agents/` imports that file, and
 * the architecture rule walks the closure through it.
 */

/** Compared, never keyed on: keying on it would invalidate every recording on a comma. */
const digestOf = (value: unknown): string =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`

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

function toMessages(transcript: Transcript[]): ModelMessage[] {
  return transcript.map((entry): ModelMessage => {
    if (entry.role === 'user') return { role: 'user', content: entry.text }
    if (entry.role === 'assistant') {
      return {
        role: 'assistant',
        content: [
          ...(entry.text === '' ? [] : [{ type: 'text' as const, text: entry.text }]),
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
  })
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
 * a recording's digest is taken over, and reshaping it would stale every tape
 * that carries the tool. The advertised JSON Schema is not in that digest.
 */
function advertised(spec: ModelToolSpec): Schema<unknown> {
  const derived = zodSchema(spec.parameters)
  const { validate } = derived
  // Always set for a Zod schema. Without it the SDK would accept any call.
  if (validate === undefined) throw new Error(`tool "${spec.name}": no validator for its schema`)
  return jsonSchema(async () => objectRooted(await derived.jsonSchema, spec.name), { validate })
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
 * Runs `call` with an abort signal that fires after `seconds`, and gives up on
 * it then whether or not the call honours the signal.
 *
 * The abort reason is a `TimeoutError` by name, which the SDK reads as an
 * abort: it neither wraps it nor retries it. The race is what makes the bound
 * hold for a fetch that ignores its signal — the answer is the timeout error
 * either way, and the request is released either way.
 *
 * The signal is an argument of the call, never a field of the request: the
 * recording digest is taken over the request, and a timeout that entered it
 * would stale every tape.
 */
async function within<T>(
  seconds: number,
  callee: Callee,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const expiry = new ModelTimeoutError(callee, seconds)
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new DOMException(expiry.message, 'TimeoutError'))
      reject(expiry)
    }, seconds * 1000)
  })
  try {
    return await Promise.race([call(controller.signal), expired])
  } catch (error) {
    throw controller.signal.aborted ? expiry : error
  } finally {
    clearTimeout(timer)
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
  /** Seconds one live call may take, retries included. Replay has no clock. */
  timeout?: number
}): LlmClient {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_SECONDS

  // Counted here, per agent, never derived from content: that is what makes
  // (scenario, agent, turn) a key a changed prompt cannot invalidate.
  const turns = new Map<string, number>()

  return {
    async generate(request: GenerateRequest): Promise<GenerateResult> {
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
        const record = options.tape.replay(key, digestOf(request))
        spend()
        return usable(fromRecord(record), record)
      }

      const choice = options.choice
      if (choice === undefined) {
        throw new Error('recording needs a configured model: set IDP_PROVIDER and IDP_MODEL')
      }

      // No temperature: it is rejected outright by several current models, and
      // determinism here comes from the recording, not from sampling settings.
      // No maxOutputTokens either: see src/llm/README.md. What bounds a call is
      // the timeout, and the SDK's two retries of a 429 or a 5xx happen inside it.
      let last: APICallError | undefined
      const response = await within(timeout, choice, (abortSignal) =>
        generateText({
          model: watched(choice, (error) => void (last = error)),
          system: request.system,
          messages: toMessages(request.transcript),
          tools: toTools(request.tools),
          toolChoice: toToolChoice(request.toolChoice),
          abortSignal,
        }),
      ).catch((error: unknown) => {
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

      options.tape?.record(key, {
        ...key,
        provider: choice.provider,
        model: choice.model,
        digest: digestOf(request),
        recordedAt: response.response.timestamp.toISOString(),
        call: { system: request.system, transcript: request.transcript },
        result: {
          content: response.content,
          finishReason: response.finishReason,
          ...withUsage(usage),
        },
      })
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
