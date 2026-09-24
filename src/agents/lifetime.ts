import type { AgentName } from '../llm/client.js'
import type { EventSink } from './events.js'

/**
 * An agent's lifetime on the stream: `agent:start` before its first turn and
 * `agent:end` after its last, on every path out — a return, a refusal, a
 * throw.
 *
 * Each agent used to emit its own start and no end, and two of them emitted a
 * `refused` before rethrowing a provider failure so the stream would not show
 * an agent that began and never ended. That patch is kept — the refusal says
 * why — and this is the end it was standing in for.
 */
export async function asAgent<T>(
  agent: AgentName,
  emit: EventSink,
  run: () => Promise<T>,
): Promise<T> {
  emit({ type: 'agent:start', agent })
  let threw = true
  try {
    const value = await run()
    threw = false
    return value
  } finally {
    emit({ type: 'agent:end', agent, threw })
  }
}
