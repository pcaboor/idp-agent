# `forge/github/` — the GitHub half of a submission

Stage 6's road to a pull request, opened with the person's own git and gh
([`docs/stage-6-brief.md`](../../../docs/stage-6-brief.md)). This build holds no GitHub
credential: gh reads its own login and git pushes with the person's, and nothing here reads,
stores or sends either. It is built task by task ([`docs/plans/stage-6-github.md`](../../../docs/plans/stage-6-github.md)):
`idpa protection` reaches the reads; the forge, which pushes and opens a pull request, is
reached by `plan --from … --submit` through `forge/open.ts`, and is proved offline, against the
fake gh and a bare repository on disk.

## What lives here

| file | what it is |
|---|---|
| `road.ts` | `readRoad(git, { local })` — the road a submission takes, read before anything is read on GitHub: the branch HEAD names, the remote it tracks and the branch on it, both URLs the person's own git prints, and, on the GitHub road only, the clone's own configuration refused by key and scope (§ 7, § 13) |
| `identity.ts` | `readIdentity(gh, road, purpose?)` — who gh is: installed, at least `GH_MINIMUM_VERSION`, logged in to github.com, and as a person (§ 5, § 9); two gh calls |
| `api.ts` | `githubClient`, the one caller of `ghIn` in `src/`; `githubApi`, one typed method per route (`user()`, § 8's `repository()`, `rules(base)`, `ruleset(id)`, `branch(base)`, `ref(branch)`, and the forge's `commit(sha)`, `pulls(branch)` and `openPullRequest(input)`, the one write, at most once per API whatever the first answered), each answer's status held to its route, one page only, and its body to `core/github/answers.ts`; `GitHubAnswerError`, a failure in this build's words; the call budget, `calls()` |
| `preflight.ts` | `readProtection(api, road)` — § 8's reads, in order: the repository, stopping there when it is archived, renamed or not the account's to push to; the rules for the base; each ruleset that supplies a required rule, at most ten; the branch, only when none does — judged by `core/github/protection.ts`. `preflight(api, road, base)` adds the base's ref: whether GitHub's base is at the clone's commit. `readRules(api, road)` is items 2 and 3 alone, what the forge reads again at the moment of acting and before the pull request |
| `push.ts` | `pushChange` — step 10, the person's own `git push` of the very commit the local forge cut, create-only, a push that did not say "created" read back, with step 11's waits, before anything is concluded, and a remote's refusal called a ruleset only where GitHub's words say so; `classifyPushFailure`, git's stderr read into a `PushFailure` and one engine sentence each, git's words never repeated |
| `forge.ts` | `openGitHubForge` — the GitHub forge: the local forge's `base` and `diverges`; `recognise`, which reads the local branch, then the branch on GitHub, its commit and the pull requests from it (§ 14); `submit`, which re-reads the road, the clone's configuration, the rules, the base, the branch on GitHub and the pull requests from it at the moment of acting, cuts the local branch, pushes, reads the branch back, reads the rules once more and opens one pull request whose body the engine writes (`core/github/pull-request.ts`), with the note that read calls for when the rules let its author merge it alone (`created.note`) |
| `open.ts` | `openGitHub({ repo, env, gh?, local, purpose? })` — the clone's root, the road, and on GitHub's road gh's identity and the API: what `idpa protection` opens, and every submission, through `forge/open.ts` |
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

## What the forge may not do

No merge, no approval, no close, no deletion, and no push but the create-only one, of one
commit, to one ref under `refs/heads/idp-agent/`, at the URL the remote printed — never to a
remote's name; and never a ref name from a caller: the branch is the clearance's, which the
engine computed from its bytes. It writes nothing on either side before the re-check passes,
and opens nothing before the branch reads back at the commit it pushed. The base's rules
refuse nothing (the owner's decision of 2026-10-01): whether a pull request's author may merge
it alone is the company's rule, so the rules read at step 11 decide the note in the body —
`note: on this repository the author may merge without another person's review`, or the
`base-unguarded` line — never whether to open; what refuses the push itself (§ 8 item 1) is
the CLI's preflight's, and the push's. `tests/unit/github-forge.test.ts` holds § 14's rows,
the re-check and every failure of the push and the pull request;
`tests/unit/merge-refused.test.ts` tries every door as the account that opened the pull
request, against the fake gh: a merge, an approval and a write to a base judged by its model,
every other door refused as a vector this build never sends, and the author's merge answering
200 wherever the note says it may; `tests/unit/hostile-clone.test.ts` refuses a clone
configured to redirect the push; `tests/invariants/github-forge.test.ts` fails every call of a
submission in turn, and opens the pull request on every shape of rules the fake models, the
note said exactly where `judgeProtection` does not hold and true where it is said.

## What may not

What `forge/` may not, and one more: `forge/github/` is the one folder that loads the gh
launcher (*only forge/github/ loads the gh launcher*), and `githubClient` the one caller of
`ghIn`, so every gh call passes the road, the identity check and the budget. It imports
`core/`, `process/` and `node:path` only — no package, no disk, no network, no `fetch` — and
names no GitHub credential (*nothing in src/ reads a GitHub credential from the
environment*) and no door the launchers' grammars refuse (*nothing in src/ names a door the
allow-list refuses*). The rules are in `tests/architecture/dependencies.test.ts`.
