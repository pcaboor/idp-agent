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
 * `snapshot.ts` re-exports them all, so the reader stays the single import
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

/**
 * How the files a snapshot holds were chosen, before any rule judged them.
 *
 *   git   the directory is in a git repository, and only the files git TRACKS
 *         were candidates: an untracked `.env`, a local override or a build
 *         artefact is named in `skipped` and never opened;
 *   walk  git says the directory is in no repository — a fresh project, a
 *         directory a test made — so every file the walk reached was a
 *         candidate, under the same name, content and size rules;
 *   none  nothing was read, and `skipped` says why: a repository whose tracked
 *         files git could not list, or a root that is not a directory.
 */
export type Selection = 'git' | 'walk' | 'none'

/**
 * What `readProject` returns: a snapshot, and how its files were chosen.
 *
 * `selection` is for the CLI, which says it on stderr, and for nobody else. It
 * is not on `ProjectSnapshot`, which is what the Inspector is handed, so no
 * field carries it to a model: what the plan-mode recordings were sent is what
 * a run still sends.
 */
export interface ProjectRead extends ProjectSnapshot {
  readonly selection: Selection
}
