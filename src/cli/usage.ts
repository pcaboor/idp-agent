import type { EventSink } from '../agents/events.js'
import type {
  GenerateOptions,
  GenerateRequest,
  GenerateResult,
  LlmClient,
  TokenUsage,
} from '../llm/client.js'

/**
 * What one run cost, as far as its providers said (product-gap-10): how many
 * model calls returned, and for each direction the tokens summed over the
 * calls that reported a count — with how many did, because a sum over some
 * of them read as the whole would understate the run.
 */
export interface RunUsage {
  readonly calls: number
  readonly input: Tally
  readonly output: Tally
}

interface Tally {
  readonly tokens: number
  readonly reported: number
}

/**
 * The client, with each call that returned put on the stream as a `usage`
 * event and counted for the line the run ends on.
 *
 * It relays and never decides, as `traced` does: the request goes through as
 * it came, the options with it, and a failure is rethrown untouched. A call
 * that threw returned no count, and is not one of the calls the line counts.
 */
export function counted(
  client: LlmClient,
  emit: EventSink,
): { client: LlmClient; usage(): RunUsage } {
  let calls = 0
  const input = { tokens: 0, reported: 0 }
  const output = { tokens: 0, reported: 0 }
  const add = (tally: typeof input, count: number | undefined): void => {
    if (count === undefined) return
    tally.tokens += count
    tally.reported += 1
  }
  return {
    client: {
      async generate(request: GenerateRequest, options?: GenerateOptions): Promise<GenerateResult> {
        const result = await client.generate(request, options)
        calls += 1
        add(input, result.usage?.inputTokens)
        add(output, result.usage?.outputTokens)
        emit({ type: 'usage', agent: request.agent, ...withUsage(result.usage) })
        return result
      },
    },
    usage: () => ({ calls, input: { ...input }, output: { ...output } }),
  }
}

/** Omitted rather than set to undefined: exactOptionalPropertyTypes draws the distinction. */
const withUsage = (usage: TokenUsage | undefined): { usage?: TokenUsage } =>
  usage === undefined ? {} : { usage }

const plural = (count: number, word: string): string =>
  `${String(count)} ${word}${count === 1 ? '' : 's'}`

/**
 * The line a run ends on, on stderr, or `undefined` for a run that made no
 * model call. A count no call reported is said to be missing, never printed
 * as 0: a tape recorded before usage was stored holds none, and neither does
 * a provider that says nothing.
 */
export function usageLine(usage: RunUsage): string | undefined {
  if (usage.calls === 0) return undefined
  const calls = `· ${plural(usage.calls, 'model call')}`
  if (usage.input.reported === 0 && usage.output.reported === 0) {
    return `${calls}; no token count was reported`
  }
  const whole = (tally: Tally): boolean => tally.reported === usage.calls
  const part = (tally: Tally, direction: string): string =>
    tally.reported === 0
      ? `no ${direction} count was reported`
      : whole(tally)
        ? plural(tally.tokens, `${direction} token`)
        : `${String(tally.tokens)} ${direction} tokens, of the ${String(tally.reported)} that ` +
          'reported them'
  const joint = whole(usage.input) && whole(usage.output) ? ', ' : '; '
  return `${calls}: ${part(usage.input, 'input')}${joint}${part(usage.output, 'output')}`
}
