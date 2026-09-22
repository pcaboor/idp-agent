/**
 * Why a document was refused, in a form a reader can act on.
 *
 * Zod puts the offending field in the issue's path and not in its message, so
 * `issues[0].message` alone says something is wrong without saying what. The
 * dotted path is the half a reader needs — the same form `findUnknowns` reports
 * for a Plan, and the same form a policy violation carries.
 *
 * It lives in `core/` because three callers need it: both repository readers in
 * `context/`, and `parseDocuments`, which reads back the bytes a plan would
 * write. It was written twice before, once per reader, which is two places for
 * the wording to drift and one of the defects Stage 1 already paid for.
 */
export function reasonOf(error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[]
}): string {
  const issue = error.issues[0]
  if (issue === undefined) return 'invalid entity'
  const where = issue.path.map(String).join('.')
  return where === '' ? issue.message : `${where}: ${issue.message}`
}
