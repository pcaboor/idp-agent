import { createHash } from 'node:crypto'
import { generateText, tool, type ModelMessage, type ToolSet } from 'ai'
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

/**
 * The only file that imports the model SDK (design § 10), which is what lets
 * `llm/client.ts` stay free of it — `agents/` imports that file, and the
 * architecture rule walks the closure through it.
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
 */
export function toTools(specs: ModelToolSpec[]): ToolSet {
  return Object.fromEntries(
    specs.map((spec) => [
      spec.name,
      tool({ description: spec.description, inputSchema: spec.parameters }),
    ]),
  )
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
