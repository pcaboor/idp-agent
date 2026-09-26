import { checkRepository, type Violation } from '../../core/validate/rules.js'
import { readRepository } from '../../context/iac-fs/snapshot.js'
import type { RepositorySnapshot } from '../../core/validate/rules.js'
import { oneLine } from '../render/plain.js'
import type { CommandResult } from './result.js'

/**
 * What the generated CI workflow runs. The catalogue ingests a duplicate in
 * silence and lets the first source win; this is what refuses it (design 4.4).
 *
 * A warning does not fail the build. A dangling reference is reported and
 * never pruned, but a repository mid-migration is not broken — and a red
 * build here would push people to delete the declaration, which is the one
 * thing that rule forbids.
 */
export async function runValidate(
  root: string,
  read: (root: string) => Promise<RepositorySnapshot> = readRepository,
): Promise<CommandResult> {
  const snapshot = await read(root)
  const violations = checkRepository(snapshot)

  // The APIs read are entities too: validated for what the reader requires of
  // one, and counted with the kinds this tool writes.
  const entities = snapshot.files.reduce(
    (total, file) => total + file.entities.length + file.apis.length,
    0,
  )
  const errors = violations.filter((violation) => violation.severity === 'error')

  // A path and a message both carry what a file wrote — its name, a key the
  // schema faulted — and a CI log is a terminal too. Cleaned and flattened,
  // never cut: the line is what somebody fixes the file from.
  const whole = (text: string): string => oneLine(text, Number.POSITIVE_INFINITY)
  const line = (violation: Violation): string =>
    `${violation.severity.padEnd(7)} ${whole(violation.file)}: ${whole(violation.message)}`

  const summary = `${entities} entities in ${snapshot.files.length} files, ${errors.length} violations`

  return {
    text: [...violations.map(line), ...(violations.length > 0 ? [''] : []), summary].join('\n'),
    found: errors.length === 0,
  }
}
