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
 * The phrase is classified against what the run reads (`sourceOf`), and a
 * change is decided against `plan`'s chain (`declarationsFor`) — `--repo`, the
 * working directory, `IDP_REPO`, the personal file — resolved apart, never
 * derived from the read. The two are one repository unless a Backstage
 * catalogue is read: the phrase is then classified from the catalogue, and a
 * change is still decided against the repository, which the Architect, the
 * gates and the Reviewer alone are shown. A change with a catalogue and no
 * repository, or against the demo SI, is refused: `change` refuses that,
 * after the one turn that found out it was a change.
 *
 * `--json` is the plan road's report, and a question has no JSON form: taken
 * as one, it is answered as `ask` answers, and one line on stderr, after the
 * classification that decided it, says the flag did nothing — a script
 * piping to a JSON parser learns why from the line, not from the parser.
 *
 * `--submit` (stage 6, D8 lifted): a change is submitted as `plan "<intent>"
 * --submit` submits one — `change` is handed the forge `main` opened, and the
 * base's rules were read before the Supervisor — and a question is refused
 * after the Supervisor's one word, exit 3, as `ask` declines a change: the
 * request is understood, and this build does not submit a question. The
 * Analyst is never called, and the `--json` line is not said: nothing is
 * answered, as text or otherwise. The Supervisor is sent exactly what it is
 * sent without the flag.
 */
export async function runEntry(
  options: AskOptions & {
    readonly json: boolean
    readonly change: () => Promise<CommandResult>
    /** `--submit`: a question is refused rather than answered; a change is `change`'s to submit. */
    readonly submit?: boolean
  },
): Promise<CommandResult> {
  const refusing = options.submit === true
  const emit: EventSink =
    options.json && !refusing
      ? (event) => {
          options.emit(event)
          if (event.type === 'classified' && event.classification === 'QUESTION') {
            options.err('--json applies to a change; a question is answered as text\n')
          }
        }
      : options.emit
  return classified(
    { ...options, emit },
    options.change,
    refusing
      ? async () => {
          // Understood, and declined: --submit submits a change. The mirror of
          // `runAsk`'s refusal of a change, exit 3 in prose and in --json alike.
          options.err(`${QUESTION_NOT_SUBMITTED}\n`)
          return { text: '', found: false, unsupported: true }
        }
      : undefined,
  )
}

/** A question put to `--submit`: refused after the Supervisor's one word, exit 3, as `ask` declines a change. */
export const QUESTION_NOT_SUBMITTED =
  'that is a question, and --submit submits a change: ask it again without --submit. ' +
  'Nothing was answered, and nothing was written.'
