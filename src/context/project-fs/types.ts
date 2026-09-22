/**
 * The shape of an application-repository snapshot, and **types only** — the
 * same discipline, for the same reason, as `llm/client.ts`.
 *
 * `agents/inspector.ts` is handed a `ProjectSnapshot` and has to name its type.
 * The architecture test walks the transitive import closure of `agents/`, so
 * naming it through `snapshot.ts` would put `node:fs/promises` inside that
 * closure and break the guarantee SECURITY.md makes — not because an agent
 * would then read a disk, but because nothing would stop the next one.
 *
 * `snapshot.ts` re-exports all three, so the reader stays the single import
 * site for anyone who wants the bytes as well as the shape.
 */

export interface ProjectFile {
  /** Project-relative, POSIX separators whatever the platform. */
  readonly path: string
  readonly text: string
}

/** Never omitted, never silent: see `NEVER IGNORE IN SILENCE` in `snapshot.ts`. */
export interface SkippedFile {
  readonly path: string
  /** Human-readable, non-empty, and never naming a path outside the project. */
  readonly reason: string
}

export interface ProjectSnapshot {
  /**
   * The real root: what containment was actually decided against. It is an
   * absolute path on the user's machine, and it is the one field of this object
   * that must never reach a model — `agents/tools/project-tools.ts` reads
   * `files` and `skipped` and nothing else.
   */
  readonly root: string
  readonly files: readonly ProjectFile[]
  readonly skipped: readonly SkippedFile[]
  /**
   * True only when a cap STOPPED the harvest — the file cap, the total-byte
   * cap, or the directory budget — so that candidates exist which are neither
   * read nor named. A single oversized or binary file leaves this false: it is
   * named in `skipped`, and the rest of the project was read.
   */
  readonly truncated: boolean
}
