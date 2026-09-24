import { createHash } from 'node:crypto'
import {
  generateText,
  jsonSchema,
  tool,
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
  Transcript,
} from './client.js'
import type { OpenRecording, TurnRecord } from './recording.js'
import { modelFor, type ModelChoice } from './providers.js'
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

const fromRecord = (record: TurnRecord): GenerateResult => ({
  ...readContent(record.result.content),
  finishReason: record.result.finishReason,
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
}): LlmClient {
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
        return fromRecord(record)
      }

      const choice = options.choice
      if (choice === undefined) {
        throw new Error('recording needs a configured model: set IDP_PROVIDER and IDP_MODEL')
      }

      // No temperature: it is rejected outright by several current models, and
      // determinism here comes from the recording, not from sampling settings.
      const response = await generateText({
        model: modelFor(choice),
        system: request.system,
        messages: toMessages(request.transcript),
        tools: toTools(request.tools),
        toolChoice: toToolChoice(request.toolChoice),
      })

      spend()

      if (options.mode === 'live') {
        return { ...readContent(response.content), finishReason: response.finishReason }
      }

      options.tape?.record(key, {
        ...key,
        provider: choice.provider,
        model: choice.model,
        digest: digestOf(request),
        recordedAt: response.response.timestamp.toISOString(),
        call: { system: request.system, transcript: request.transcript },
        result: { content: response.content, finishReason: response.finishReason },
      })
      return { ...readContent(response.content), finishReason: response.finishReason }
    },
  }
}
