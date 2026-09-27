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
  /**
   * Candidates the file or byte budget left unread — counted, for the line the
   * CLI says on stderr. Zero when the budget read everything it was offered.
   */
  readonly leftOut: number
  /**
   * How many of `leftOut` were signal files — manifests, ownership, catalogue,
   * chart, container and deployment files — so the line on stderr never says
   * they were all read when a workspace monorepo holds more than the budget.
   */
  readonly signalsLeftOut: number
  /**
   * Every `catalog-info*.yaml`/`.yml` the repository keeps, read whole and
   * OUTSIDE the budget: what `init` compares a Component with, and the `before`
   * of the diff it previews. Not on `ProjectSnapshot`, so never sent to a
   * model: a file the budget left out is still a declaration the repository
   * holds, and a capped read of it would preview a creation over it.
   */
  readonly declarations: readonly Declaration[]
}

/**
 * A catalog-info file: its bytes, or why they could not be taken whole — in
 * which case nobody can say what it declares, and nothing is previewed over it.
 */
export type Declaration = (
  | { readonly path: string; readonly text: string }
  | { readonly path: string; readonly unreadable: string }
) & {
  /**
   * The folder below the root, nearest first, that holds its own package
   * manifest and so is a workspace of its own — absent when there is none.
   * A catalog-info in one describes that workspace, not the repository.
   */
  readonly workspace?: string
}
