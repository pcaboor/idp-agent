/**
 * What a model call that cannot succeed turns into.
 *
 * Each is one line a person can act on — what happened, with which provider
 * and model, and what to change — and `cli/index.ts` maps each to exit 1. The
 * alternative was what the SDK gives: a provider's raw message, several lines
 * of it, or nothing at all for five minutes while a socket waits.
 *
 * No SDK import here, on purpose: `cli/` reads these classes, and the SDK's own
 * errors are translated into them in `runtime.ts`, the one file that sees them.
 *
 * Only one of these messages may read as a refused tool choice — `agents/
 * forced-turn.ts` retries a forced turn as an open one when an error says
 * `tool_choice`, `required tool` or `forced tool`, and retrying a timeout or a
 * refused key doubles the wait for the same failure. That one is kind
 * `tool-choice`, which says `forced tool` in its own words: `runtime.ts`
 * decides it on the provider's whole message, so the fallback does not hang on
 * the provider naming the tool choice inside the first `SUMMARY_LIMIT`
 * characters. The rest are fixed sentences, or carry words that cannot name
 * it: a plain refusal is one whose message did not, and a lost connection's
 * are the SDK's own.
 */

/** Who was called, as every message names it: `openai gpt-6-luna`. */
export interface Callee {
  provider: string
  model: string
}

/**
 * The model comes from IDP_MODEL, or from a tape, and is in every line below:
 * printed as it came, a value carrying an escape would reach the terminal.
 */
const nameOf = (callee: Callee): string => printable(`${callee.provider} ${callee.model}`)

/** The common ancestor, so a caller can tell a model failure from a bug. */
export class ModelCallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/** The call was aborted when IDP_TIMEOUT expired. Never retried. */
export class ModelTimeoutError extends ModelCallError {
  constructor(
    callee: Callee,
    readonly seconds: number,
  ) {
    super(
      `${nameOf(callee)} did not answer within ${seconds} s; ` +
        'set IDP_TIMEOUT=<seconds> to wait longer',
    )
  }
}

/** The turn stopped on its output limit having produced nothing usable. */
export class ModelOutputLimitError extends ModelCallError {
  constructor(callee: Callee) {
    super(`${nameOf(callee)}: the model hit its output limit before answering`)
  }
}

/** The provider's content filter stopped the turn. */
export class ModelRefusalError extends ModelCallError {
  constructor(callee: Callee) {
    super(`${nameOf(callee)}: the provider refused to answer`)
  }
}

/**
 * Which HTTP failure it was. A closed union, so the sentence for each is
 * written once, in `sentenceOf`, and a new kind is a compile error there.
 */
export type ProviderFailure =
  | { kind: 'key'; status: number; variable: string }
  | { kind: 'quota'; status: number }
  | { kind: 'rate'; status: number }
  | { kind: 'provider'; status: number }
  | { kind: 'context'; status: number }
  | { kind: 'tool-choice'; status: number; summary: string }
  | { kind: 'refused'; status: number; summary: string }
  | { kind: 'unreadable'; status: number }
  | { kind: 'unreachable'; summary: string }

const reason = (summary: string): string => (summary === '' ? '' : `: ${summary}`)

function sentenceOf(failure: ProviderFailure): string {
  switch (failure.kind) {
    case 'key':
      return `the key was refused (HTTP ${failure.status}); check ${failure.variable}`
    case 'quota':
      return `the account is out of quota (HTTP ${failure.status})`
    case 'rate':
      return `rate limited (HTTP ${failure.status})`
    case 'provider':
      return `the provider failed (HTTP ${failure.status})`
    case 'context':
      return `the request is longer than the model's context window (HTTP ${failure.status})`
    case 'tool-choice':
      // `forced tool` is what `agents/forced-turn.ts` reads: keep it.
      return (
        `the model does not take a forced tool choice (HTTP ${failure.status})` +
        reason(failure.summary)
      )
    case 'refused':
      return `the request was refused (HTTP ${failure.status})${reason(failure.summary)}`
    case 'unreadable':
      // Nothing was refused: the SDK could not read what came back. No summary,
      // because its message quotes the body, and the body is the model's answer.
      return `the provider's answer could not be read (HTTP ${failure.status})`
    case 'unreachable':
      return `could not reach the provider${reason(failure.summary)}`
    default: {
      const _exhaustive: never = failure
      return _exhaustive
    }
  }
}

/** The provider answered with an HTTP error, or could not be reached at all. */
export class ProviderCallError extends ModelCallError {
  constructor(
    callee: Callee,
    readonly failure: ProviderFailure,
  ) {
    super(`${nameOf(callee)}: ${sentenceOf(failure)}`)
  }
}

/** Long enough to carry a provider's reason, short enough to stay one line. */
const SUMMARY_LIMIT = 120

/**
 * Escape sequences, as `cli/render/plain.ts` reads them — a CSI complete or cut
 * short, a string sequence up to its terminator, any other two-byte escape —
 * then every remaining control. Removed here and not by `plain`, because `llm/`
 * does not import `cli/` and the line is built here.
 */
const SEQUENCE =
  // eslint-disable-next-line no-control-regex -- removing them is the point
  /\u001B\[[0-?]*[ -/]*[@-~]?|\u001B[\]PX^_][^\u0007\u001B]*(?:\u0007|\u001B\\)?|\u001B./g
// eslint-disable-next-line no-control-regex -- removing them is the point
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/g
/** `sk-…`, `pk-…`, and a long unbroken run of letters and digits, which is a Mistral key. */
const KEY_SHAPED = /\b(?:sk|pk|rk)[-_][\w*.-]{6,}|\b[A-Za-z0-9]{32,}\b/g

/**
 * A provider's own words, made fit for one line of a terminal: sequences and
 * controls gone, whitespace collapsed, anything shaped like a key masked, and
 * cut at `SUMMARY_LIMIT`. A provider has echoed part of the key it refused
 * before now; a line that ends up in a CI log must not repeat it.
 */
export function summarise(text: string): string {
  const flat = printable(text).replace(KEY_SHAPED, '[redacted]')
  return flat.length <= SUMMARY_LIMIT ? flat : `${flat.slice(0, SUMMARY_LIMIT - 1).trimEnd()}…`
}

/** Sequences and controls gone, whitespace collapsed: one line, and inert. */
function printable(text: string): string {
  return text.replace(SEQUENCE, ' ').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
}
