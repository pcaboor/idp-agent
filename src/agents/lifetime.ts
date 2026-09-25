import type { AgentName } from '../llm/client.js'
import type { EventSink } from './events.js'

/**
 * An agent's lifetime on the stream: `agent:start` before its first turn and
 * `agent:end` after its last, on every path out — a return, a refusal, a
 * throw.
 *
 * Each agent used to emit its own start and no end. The Architect, the
 * Inspector and the Reviewer emit `stopped` before rethrowing a provider
 * failure, and that event once stood in for the end the stream never had.
 * It stays, because it says why; this is what closes the agent.
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
