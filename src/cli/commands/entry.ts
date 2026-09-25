import type { EventSink } from '../../agents/events.js'
import { classified, type AskOptions } from './ask.js'
import type { CommandResult } from './result.js'

/**
 * `idpa "<phrase>"` — the daily gesture of §7.4, typed from anywhere: a
 * question about the SI or an intent to change it, and the phrase does not
 * say which. The Supervisor does, once, and each answer takes the road of the
 * command that forces it:
 *
 *   QUESTION  `ask`'s road, to the byte — the same summary, the same Analyst,
 *             the same output and exit codes (`classified`).
 *   MUTATION  `plan "<intent>"`'s road, which `change` runs: `cli/index.ts`
 *             builds it, because it needs what only `main` holds — the
 *             declarations repository, the directory to inspect, the terminal
 *             to ask a question on.
 *
 * `ask` and `plan` stay, as the commands that force a road: `plan` previews
 * without asking the Supervisor, and `ask` asks it and only answers — a change
 * is declined there, pointing here.
 *
 * The phrase is classified against the SI the read road resolved, which is
 * the declarations repository whenever one is found at all — `--repo`, the
 * working directory, `IDP_REPO`, the personal file — so a change is decided
 * against what it was classified against. Only the demo SI differs, and a
 * change is never previewed against it: `change` refuses that, after the one
 * turn that found out it was a change.
 *
 * `--json` is the plan road's report, and a question has no JSON form: taken
 * as one, it is answered as `ask` answers, and one line on stderr, after the
 * classification that decided it, says the flag did nothing — a script
 * piping to a JSON parser learns why from the line, not from the parser.
 */
export async function runEntry(
  options: AskOptions & {
    readonly json: boolean
    readonly change: () => Promise<CommandResult>
  },
): Promise<CommandResult> {
  const emit: EventSink = options.json
    ? (event) => {
        options.emit(event)
        if (event.type === 'classified' && event.classification === 'QUESTION') {
          options.err('--json applies to a change; a question is answered as text\n')
        }
      }
    : options.emit
  return classified({ ...options, emit }, options.change)
}
