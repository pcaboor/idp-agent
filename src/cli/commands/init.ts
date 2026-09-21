import { loadTemplates } from '../../scaffold/templates.js'
import { scaffoldLayout } from '../../scaffold/layout.js'
import { writeScaffold, type FileIO } from '../../scaffold/write.js'
import type { CommandResult } from './result.js'

/**
 * Printed on every run, including the one that writes nothing. The second
 * reader of a repository is as entitled to it as the first, and a tool that
 * only admits its limits once has not admitted them.
 */
const BRANCH_PROTECTION = `Branch protection is set in the forge, not here. Required on the default branch:
  · require a pull request before merging — 1 approval
  · require review from Code Owners
  · dismiss stale approvals on a new push
  · no force push, no branch deletion
  · include administrators
This build cannot verify these. The live check — that the token which opens a
request cannot merge it — arrives at stage 6.`

export interface InitPlatformOptions {
  /** Absolute, already through assertInsideRepo. */
  readonly root: string
  /** A forge handle, already validated. */
  readonly owner: string
  readonly version: string
}

export async function runInitPlatform(
  options: InitPlatformOptions,
  io?: FileIO,
): Promise<CommandResult> {
  const files = scaffoldLayout(
    { owner: options.owner, version: options.version },
    await loadTemplates(),
  )
  const report = await writeScaffold(options.root, files, io)

  const listed = [...report.written, ...report.kept].sort()
  return {
    text: [
      `wrote ${report.written.length} · kept ${report.kept.length}`,
      ...listed.map((file) => `  ${report.written.includes(file) ? '+' : '=' } ${file}`),
      '',
      BRANCH_PROTECTION,
    ].join('\n'),
    found: true,
  }
}

/**
 * A tested refusal, not a stub. §7.3 needs the Inspector to read the
 * application's repository and propose() to turn what it found into an
 * entity; both arrive at stage 4.
 */
export function runInit(): CommandResult {
  return {
    text: '',
    found: false,
    unsupported: true,
  }
}

export const INIT_DEFERRED =
  'per-application init arrives at stage 4: it inspects the repository and proposes a ' +
  'catalog-info.yml through propose(), which does not exist yet'
