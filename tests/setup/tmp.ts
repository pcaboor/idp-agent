/**
 * Every temporary file the suite makes lives in one directory, created for the
 * run and removed when it ends — not by each test remembering to clean up.
 *
 * The tests call `mkdtemp(path.join(tmpdir(), …))` and leave the result
 * behind, and vitest leaves the transformed modules it hands its forks
 * (`<nanoid>/ssr/<sha1>`, one directory per run that it never removes). Each
 * full run left 243 entries and 19 MB in the shared temp directory; on one
 * laptop they reached 79,410 entries and 6.7 GB and filled the disk in the
 * middle of a merge.
 *
 * The fix is one place rather than seventeen: `TMPDIR` — and `TMP` and
 * `TEMP`, which `os.tmpdir()` reads on Windows — points at the run directory,
 * so `os.tmpdir()` answers it everywhere. It has to be set when the config is
 * loaded, not in `setup()`: vitest picks its own temp directory when it is
 * constructed, which is after the config and before any global setup. The
 * forks take `process.env` as it stands when they start, and the CLI they
 * spawn inherits it from them, so nothing a test starts can miss it.
 * `tests/unit/temp-directory.test.ts` fails if any of that stops being true.
 */
import { chmodSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** Recognisably this suite's, and whose: the pid is the process that removes it. */
const PREFIX = 'idp-agent-test-'
const TEMP_VARIABLES = ['TMPDIR', 'TMP', 'TEMP'] as const
/** Exactly what `mkdtemp` makes of `ownName()`, and nothing else. */
const RUN_DIRECTORY = /^idp-agent-test-(\d+)-[A-Za-z0-9]{6}$/

const ownName = (): string => `${PREFIX}${process.pid}-`

/**
 * Creates the run directory and points the temp variables at it. Called once
 * from `vitest.config.ts`; a second load of the config in the same process —
 * watch mode reloads it — keeps the directory it already has.
 */
export function enterRunDirectory(): string {
  const current = tmpdir()
  if (path.basename(current).startsWith(ownName())) return current
  const run = mkdtempSync(path.join(current, ownName()))
  for (const name of TEMP_VARIABLES) process.env[name] = run
  return run
}

/**
 * Removes a tree some tests made unreadable on purpose. A directory of mode
 * 000 cannot be listed, so `rm -r` stops at it; its mode is restored first.
 * Files need nothing — unlinking one is a right over its directory — and a
 * symbolic link is never followed: a test that links to a directory outside
 * the run must not have that directory's mode changed, or its content removed.
 */
export function removeTree(dir: string): void {
  const reopen = (current: string): void => {
    chmodSync(current, 0o700)
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) reopen(path.join(current, entry.name))
    }
  }
  try {
    reopen(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
}

/** `EPERM` is a live process of another user: running, and not ours to judge. */
const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Removes the run directories of runs that never reached their teardown — a
 * killed process, a crash — and only those: a directory whose process is still
 * alive belongs to a suite running now, in this worktree or another one.
 */
export function removeAbandonedRuns(parent: string): void {
  for (const name of readdirSync(parent)) {
    const pid = Number(RUN_DIRECTORY.exec(name)?.[1])
    if (!Number.isInteger(pid) || pid === process.pid || isRunning(pid)) continue
    removeTree(path.join(parent, name))
  }
}

/** globalSetup: nothing to set up that the config has not already done. */
export default function setup(): () => void {
  const run = tmpdir()
  if (!path.basename(run).startsWith(ownName())) {
    throw new Error(
      `the suite's temp directory is ${run}, not a run directory of this process. ` +
        'vitest.config.ts must call enterRunDirectory() before vitest starts.',
    )
  }
  removeAbandonedRuns(path.dirname(run))
  // Only a directory this process created: a suite started from inside
  // another one's run directory removes its own, never its parent's.
  return () => removeTree(run)
}
