import type { GenerateRequest, GenerateResult, LlmClient } from '../llm/client.js'
import type { TraceBuilder } from './builder.js'

/**
 * The same client, reporting each call to a trace.
 *
 * It relays and never decides: the request goes through as it came, the
 * result comes back as it went, and a failure is recorded and then rethrown
 * as the very same error. Wrapping whichever client the session opened — live,
 * recorded, replayed or scripted — is what makes a replayed run traced like a
 * live one.
 */
export function traced(
  client: LlmClient,
  builder: Pick<TraceBuilder, 'modelCallStarted' | 'modelCallEnded'>,
): LlmClient {
  return {
    async generate(request: GenerateRequest): Promise<GenerateResult> {
      const handle = builder.modelCallStarted(request)
      let result: GenerateResult
      try {
        result = await client.generate(request)
      } catch (thrown) {
        builder.modelCallEnded(handle, { error: thrown })
        throw thrown
      }
      builder.modelCallEnded(handle, { result })
      return result
    },
  }
}
