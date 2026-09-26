/** One zod issue, as much of it as a reason reads. */
interface Issue {
  readonly path: readonly PropertyKey[]
  readonly message: string
  readonly code?: string
  readonly values?: readonly unknown[]
}

/**
 * Why a document was refused, in a form a reader can act on.
 *
 * Zod puts the offending field in the issue's path and not in its message, so
 * `issues[0].message` alone says something is wrong without saying what. The
 * dotted path is the half a reader needs — the same form `findUnknowns` reports
 * for a Plan, and the same form a policy violation carries.
 *
 * Handed the `input` it parsed — the reader does, a proposal's callers do not —
 * it also tells a field nobody wrote from one written wrong. Zod words both
 * alike: an absent `spec.lifecycle` was reported as "Invalid option: expected
 * one of …", which reads as a bad value in a file that holds none. An absent
 * field reads `<path>: required`, and for a closed set the values it accepts
 * (`spec.lifecycle: required — experimental, production or deprecated`); so
 * does one written with no value (`lifecycle:`, or `~`), which YAML reads as
 * null. Only zod's own two words for a value of the wrong shape are replaced;
 * a reason a schema words itself — an API's absent definition — is kept as it
 * is.
 *
 * It lives in `core/` because three callers need it: both repository readers in
 * `context/`, and `parseDocuments`, which reads back the bytes a plan would
 * write. It was written twice before, once per reader, which is two places for
 * the wording to drift and one of the defects Stage 1 already paid for.
 */
export function reasonOf(error: { issues: readonly Issue[] }, input?: unknown): string {
  const issue = error.issues[0]
  if (issue === undefined) return 'invalid entity'
  const where = issue.path.map(String).join('.')
  const message = absentAt(issue, input) ? required(issue) : issue.message
  return where === '' ? message : `${where}: ${message}`
}

/** The codes zod words with its own message for a value of the wrong shape. */
const SHAPE_CODES = new Set(['invalid_type', 'invalid_value'])

function absentAt(issue: Issue, input: unknown): boolean {
  if (input === undefined || issue.path.length === 0) return false
  if (issue.code === undefined || !SHAPE_CODES.has(issue.code)) return false
  let value: unknown = input
  for (const key of issue.path) {
    if (value === null || typeof value !== 'object') return false
    value = (value as Record<PropertyKey, unknown>)[key]
  }
  // `lifecycle:` with nothing after it parses to null: a field left empty,
  // which holds no value to call invalid.
  return value === undefined || value === null
}

function required(issue: Issue): string {
  const values = issue.code === 'invalid_value' ? (issue.values ?? []) : []
  if (values.length === 0) return 'required'
  const words = values.map(String)
  const last = words.pop()
  return `required — ${words.length === 0 ? last : `${words.join(', ')} or ${last}`}`
}
