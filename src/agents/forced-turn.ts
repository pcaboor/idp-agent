import type {
  AgentName,
  GenerateResult,
  LlmClient,
  ModelToolSpec,
  Transcript,
} from '../llm/client.js'

/**
 * One turn of a bounded agent loop, with the last one forced onto the terminal
 * tool.
 *
 * Extracted at the third agent and not the second, which is what `inspector.ts`
 * asked for in as many words: a shape generalised from a sample of two encodes
 * the sample. The Analyst, the Inspector and the Architect differ in what they
 * read, what they count as progress and what they do with the terminal call —
 * they do not differ in this, and it is the part nobody should be writing out a
 * third time.
 *
 * What this does NOT cover, and deliberately: the loop itself. Whether a turn
 * was barren, what a terminal call means once it parses, and which events are
 * emitted stay in each agent, because those are the three places the three
 * agents actually disagree.
 */
/**
 * Turns granted back when a terminal call is REFUSED rather than absent.
 *
 * Design 6.1 allows three repair attempts, and without this the loops had none
 * where they matter: a terminal call rejected on the forced turn pushed its
 * error into a transcript that was never sent again. Each agent's headline
 * case — a proposal the schema refuses, handed back so the model can fix the
 * field the error names — was unrecoverable exactly when the loop was about to
 * end.
 *
 * A refusal is not a barren turn. The model DID answer, in the terminal
 * channel, and was told precisely what was wrong with it; spending one more
 * turn on that is the repair loop. Spending one on a model that keeps reading
 * without concluding is not, and that is what maxBarrenTurns is for.
 */
export const MAX_REPAIRS = 3

export async function takeTurn(turn: {
  client: LlmClient
  agent: AgentName
  system: string
  transcript: Transcript[]
  tools: ModelToolSpec[]
  /** The tool the last turn forces, so a loop cannot fall off its bound silently. */
  terminal: string
  last: boolean
}): Promise<GenerateResult> {
  const { client, agent, system, transcript, tools, terminal, last } = turn
  const request = { agent, system, transcript, tools }

  if (!last) return client.generate({ ...request, toolChoice: 'auto' })

  try {
    return await client.generate({ ...request, toolChoice: { tool: terminal } })
  } catch (error) {
    if (!refusesForcedTool(error)) throw error
    // Forcing a tool is model-dependent: some providers reject `tool_choice`
    // with a 400, and the SDK throws when a forced call does not come back.
    // Neither is a reason to lose the run, so the forced turn degrades to an
    // open choice with the instruction spelled out instead. A failure that is
    // not about the tool choice is re-thrown: it is not ours to swallow.
    return client.generate({
      ...request,
      system: `${system}\n\nThis is your last turn. Call the "${terminal}" tool now.`,
      toolChoice: 'auto',
    })
  }
}

const refusesForcedTool = (error: unknown): boolean =>
  error instanceof Error && /required tool|tool_choice|tool choice|forced tool/i.test(error.message)
