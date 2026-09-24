# idp-agent

[![ci](https://github.com/pcaboor/idp-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/pcaboor/idp-agent/actions/workflows/ci.yml)
[![licence](https://img.shields.io/badge/licence-Apache--2.0-blue.svg)](LICENSE)

Turn a natural-language intent into versioned infrastructure declarations that are
reviewed, then merged.

```bash
git clone https://github.com/pcaboor/idp-agent && cd idp-agent
pnpm install && pnpm test     # 934 tests, no API key, no network, no cost
```

That is the whole setup. The suite never reaches a model, and it never will: that is a
constraint of the design, not a stage the project is passing through.

## What it does today

Stages 0 to 4 of 7 are shipped: two read-only commands over a fictional information system
of 33 entities, a question mode, a scaffolder for the declarations repository — and a
**preview**. An intent becomes a plan, the plan is signed, gated, re-checked against the
repository as it is now, and what comes out is a unified diff.

**Stage 4 writes nothing, and that is the whole of it.** No branch, no merge request, no
byte changed in either repository — the test suite and `pnpm smoke` both hash every path
and every byte around a full run rather than taking it on trust. Writing arrives at stage
5 and the merge request at stage 6, because the merge is the act of authorisation and
there is no sense owning a write before something can review it.

Not published yet. From a clone:

```bash
pnpm build && node dist/cli/bin.js show billing-db-prod
```

```
resource:default/billing-db-prod

  kind         Resource
  type         database
  owner        group:default/tiger
  environment  prod

depends on
  resource:default/mysql-prod-01  prod

used by
  resource:default/billing-api-billing-db-prod  prod
  resource:default/reporting-billing-db-prod    prod

reached by services
  component:default/billing-api
  component:default/reporting-worker
```

That last section answers *which services are connected to the billing database* by
walking access declarations, with no model involved.

```bash
idp-agent graph [--env <env>] [--type <type>] [--kind Component|Resource] [--repo <dir>]
idp-agent show <name-or-reference> [--repo <dir>]
idp-agent ask "<question>" [--repo <dir>]        # needs IDP_PROVIDER and IDP_MODEL
idp-agent validate <directory>                   # what the generated CI runs
idp-agent init platform <dir> --owner @org/team  # the only command that writes
idp-agent plan --from <plan.json> --repo <dir>   # no model, and none is possible
idp-agent plan "<intent>" --repo <dir> [--json]  # needs IDP_PROVIDER and IDP_MODEL
idp-agent init [--repo <dir>]                    # the catalog-info.yml it would write
```

`ask` puts a model in front of the same graph. It chooses which questions to ask; the
engine answers them and prints the result, and a reference the tools never returned is
refused rather than printed. **No provider is configured by default** — set `IDP_PROVIDER`
(anthropic, mistral or openai) and `IDP_MODEL` to the model you want.

`plan` is the stage 4 gesture, and it has two forms that meet at one renderer. `--from`
reads a `Plan` out of a file and calls no model at all — `examples/` holds three, one per
outcome — which is how the deterministic half is exercised with nothing configured.
`plan "<intent>"` drafts one instead: an Inspector reads the repository you are standing
in, an Architect proposes into a typed buffer, and five gates judge what it proposed —
shape, provenance, policy, a Reviewer that never sees the Architect's reasoning, and a
re-check against the repository. Three attempts, then a clean stop.

The two `--repo` flags are two different repositories: `plan --repo` is the declarations
repository the preview is decided against, `init --repo` the application repository being
declared. `graph`, `show` and `ask` take the first kind: `--repo` names a declarations
repository to read. Without it they read the fictional demo SI, and say so on stderr.

A value nobody can vouch for is **asked about, never guessed** — that is exit 3, and it is
the most common thing to see on a repository that holds no entities yet.

(`idp-agent` and the short alias `idpa` are the names the `bin` entry declares; they
work today through `pnpm link --global`.)

Exit codes: `0` succeeded · `1` the answer is negative — nothing matched, the repository
does not conform, or a gate refused the plan · `2` the arguments were refused, or no model
is configured · `3` the request was understood and this build will not act on it, which
includes a plan holding a value nobody can vouch for. An ambiguous name resolves nothing
rather than picking the first candidate.

## What it is really about

The repository demonstrates **how to build a reliable multi-agent system**:
deterministic orchestration, structural guardrails, a closed repair loop, and tests
that reproduce without an API key. Platform GitOps is the application domain, not the
subject.

It builds on a declarative reconciliation system shipped to production — CI/CD
triggered on `catalog-info.yml`, a central IaC repository, provisioning through an API
gateway, firewall automation and ticketing — and adds the multi-agent orchestration
layer that system never had.

The doctrine that follows from running such a system is written down in
[`docs/design.md`](docs/design.md) §4, and it is not negotiable. Three examples:

- **The merge is the act of authorisation.** The CLI opens a merge request; it never
  writes to the main branch.
- **Textual surgery, never a reparse.** A reviewer must see an added line, not a
  reformatted file.
- **Declare, never infer.** What is unknown is reported as unknown. An automaton
  reports; it does not delete.

## Where it is going

| # | Stage | State |
|---|---|---|
| 0 | Foundations — schemas, serialiser, paths, invariants | done |
| 1 | Read-only — `graph`, `show <entity>` | done |
| 2 | Question mode — Supervisor, recordings | done |
| 3 | `init platform` + `validate` | done |
| 4 | Preview only — Inspector, Architect, `Plan`, diff; writes nothing | done |
| 5 | Write + local branch — atomicity, idempotence | |
| 6 | GitHub merge request — real forge, negative token test | |
| 7 | Polish — Ink TUI, asciinema, npm publish | |

The order is imposed by the doctrine: read first, validate before the first write,
preview before the merge request. Writing arrives only at stage 5, by which point
validation has been refusing correctly for three stages.

## Requirements

Node >= 22, pnpm 10. No Docker, no database, no API key.

## Documentation

| File | For |
|---|---|
| [`AGENTS.md`](AGENTS.md) | a coding agent, or anyone, opening the repository cold |
| [`docs/design.md`](docs/design.md) | the full specification: doctrine, architecture, journeys |
| [`docs/plans/`](docs/plans) | the per-stage implementation plans, task by task |
| [`docs/reviews/`](docs/reviews) | dated code reviews: what was found, at which commit |
| [`SECURITY.md`](SECURITY.md) | the threat model, and what is *not* guaranteed |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | three commands and the rules the CI enforces |

## Licence

Apache-2.0 — the licence of Backstage, Kubernetes and Terraform. Its explicit patent
grant is what lets a company's legal team adopt the project without friction.
