# `process/` — the one place a process is started

A leaf of two modules. `context/project-fs` reads a repository through it (`git ls-files`),
and the local forge (`forge/local/`) writes one through it (ADR-0010) — though no command
reaches the forge until `--submit`. Neither may start a process of
its own: the launcher is shared so that every hardening line below applies to every call or
to none.

## What lives here

| file | what it is |
|---|---|
| `environment.ts` | `spawnedEnvironment` — a child's environment: the process's, without any `*_API_KEY` and without any `IDP_BACKSTAGE_*` variable, whatever their case — and `BACKSTAGE_TOKEN_VARIABLE`, the name it keeps out |
| `git.ts` | `gitIn` — **the only module in `src/` that starts a process**; `gitEnvironment`, `HARDENING`, `GIT_LIMITS`, `GitError` |

## What every git call carries

Each line answers something that was measured, and `tests/unit/process-git.test.ts` plants
its reason in a real repository and proves the line holds:

- `spawnedEnvironment()` minus every `GIT_*` variable — no provider key and no catalogue
  token reaches git or anything git runs (ADR-0011); an inherited `GIT_DIR` cannot send
  `git -C <repo>` to another repository, `GIT_CONFIG_PARAMETERS` cannot undo the overrides,
  and `GIT_AUTHOR_*`/`GIT_COMMITTER_*` cannot choose who commits;
- `-c core.hooksPath=/dev/null` — a repository's hooks are its owner's code, and they never
  run inside a call of ours;
- `-c core.fsmonitor=false`, `-c core.untrackedCache=false` — a configured fsmonitor is a
  command line, and `ls-files` runs it;
- `-c user.useConfigOnly=true` — git never guesses an identity from the login and host
  names: one is configured, or `commit-tree` refuses (D13);
- started from Node's own directory, never a repository's, which it reaches by `-C` and an
  absolute path — a `git` planted at a repository's root never runs;
- a timeout and an output cap (`GIT_LIMITS`), past which nothing is read;
- `execFile`, no shell.

What it does not do is sandbox git: the user's global configuration is read, because their
identity lives there.

## What may not

Nothing here imports anything of ours, nor any package: `node:` built-ins and each other
only, because anything this leaf imported would be reachable from both of its importers.
`tests/architecture/dependencies.test.ts` holds that (*process/ imports nothing of ours, and
only node: built-ins*), holds `git.ts` to being the only module importing `child_process`
(*only the named modules write, and only one starts a process*), holds its one call to an
environment that starts from `spawnedEnvironment` and names what it is handed nowhere else
(*every process src/ starts is given spawnedEnvironment*), and holds its importers to the
two above (*only context/project-fs and forge/ load the git launcher*): `gitIn` runs any
git command, so `show HEAD:.env` from any other module would go around project-fs's secret
exclusions. A type may be named anywhere; `environment.ts` starts nothing and may be
imported by anyone. `core/` may not import this folder, directly or through anything else.
