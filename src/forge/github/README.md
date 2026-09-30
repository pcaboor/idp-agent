# `forge/github/` — the GitHub half of a submission

Stage 6's road to a pull request, opened with the person's own git and gh
([`docs/stage-6-brief.md`](../../../docs/stage-6-brief.md)). This build holds no GitHub
credential: gh reads its own login and git pushes with the person's, and nothing here reads,
stores or sends either. It is built task by task ([`docs/plans/stage-6-github.md`](../../../docs/plans/stage-6-github.md));
so far it reads, and `idpa protection` is the one command that reaches it.

## What lives here

| file | what it is |
|---|---|
| `road.ts` | `readRoad(git, { local })` — the road a submission takes, read before anything is read on GitHub: the branch HEAD names, the remote it tracks and the branch on it, both URLs the person's own git prints, and, on the GitHub road only, the clone's own configuration refused by key and scope (§ 7, § 13) |
| `identity.ts` | `readIdentity(gh, road, purpose?)` — who gh is: installed, at least `GH_MINIMUM_VERSION`, logged in to github.com, and as a person (§ 5, § 9); two gh calls |
| `api.ts` | `githubClient`, the one caller of `ghIn` in `src/`; `githubApi`, one typed method per route (`user()`, and § 8's `repository()`, `rules(base)`, `ruleset(id)`, `branch(base)`, `ref(branch)`), each answer's status held to its route, one page only, and its body to `core/github/answers.ts`; `GitHubAnswerError`, a failure in this build's words; the call budget |
| `preflight.ts` | `readProtection(api, road)` — § 8's reads, in order: the repository, stopping there when it is archived, renamed or not the account's to push to; the rules for the base; each ruleset that supplies a required rule, at most ten; the branch, only when none does — judged by `core/github/protection.ts`. `preflight(api, road, base)` adds the base's ref: whether GitHub's base is at the clone's commit |
| `open.ts` | `openGitHub({ repo, env, gh?, local, purpose? })` — the clone's root, the road, and on GitHub's road gh's identity and the API: what `idpa protection` opens, and every submission will |
| `limits.ts` | `GITHUB_LIMITS` — what one run may spend (§ 15): 48 gh calls, which the brief's figures add up to exactly |

## How it decides

The pure half is `core/github/`: the URL's five forms, the grammars, the configuration's scope
check, gh's version, the fields read of each answer. This folder only reads, through the two
launchers of `process/`, and hands what it read to those functions. Every value read from a
clone's configuration — a branch, a remote's name, a base — is held to its grammar before it
reaches a process or a sentence, and a value outside one is refused without being quoted.

A refusal the person can fix by typing something — a detached HEAD, a URL carrying a
credential, a fork set-up, a refused configuration key, gh missing, logged out, too old or not
a person — is a `ForgeInputError`, exit 2, before anything is written and before any model. An
answer GitHub failed to give is a `GitHubAnswerError`, exit 1, which names the route and the
status and never GitHub's or gh's words.

## What may not

What `forge/` may not, and one more: `forge/github/` is the one folder that loads the gh
launcher (*only forge/github/ loads the gh launcher*), and `githubClient` the one caller of
`ghIn`, so every gh call passes the road, the identity check and the budget. It imports
`core/`, `process/` and `node:path` only — no package, no disk, no network, no `fetch` — and
names no GitHub credential (*nothing in src/ reads a GitHub credential from the
environment*) and no door the launchers' grammars refuse (*nothing in src/ names a door the
allow-list refuses*). The rules are in `tests/architecture/dependencies.test.ts`.
