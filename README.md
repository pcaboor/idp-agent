# idp-agent

[![ci](https://github.com/pcaboor/idp-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/pcaboor/idp-agent/actions/workflows/ci.yml)
[![licence](https://img.shields.io/badge/licence-Apache--2.0-blue.svg)](LICENSE)

Turn a natural-language intent into versioned infrastructure declarations that are
reviewed, then merged.

```bash
git clone https://github.com/pcaboor/idp-agent && cd idp-agent
pnpm install && pnpm test     # 129 tests, no API key, no network, no cost
```

That is the whole setup. The suite never reaches a model, and it never will: that is a
constraint of the design, not a stage the project is passing through.

## What it does today

Stages 0 and 1 of 7 are shipped: two read-only commands over a fictional information
system of 33 entities. No AI, no network, no writes.

Not on npm yet — publishing is stage 7. Until then:

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
idp-agent graph [--env <env>] [--type <type>] [--kind Component|Resource]
idp-agent show <name-or-reference>
```

(`idp-agent` and the short alias `idpa` are the names the `bin` entry declares; they
work today through `pnpm link --global`.)

Exit codes: `0` succeeded · `1` the query resolved nothing · `2` the arguments were
refused. An ambiguous name resolves nothing rather than picking the first candidate.

## What it is really about

The repository demonstrates **how to build a reliable multi-agent system**:
deterministic orchestration, structural guardrails, a closed repair loop, and tests
that reproduce without an API key. Platform GitOps is the application domain, not the
subject.

It builds on a declarative reconciliation system shipped to production at Orange — CI/CD
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
| 2 | Question mode — Supervisor, cassettes | next |
| 3 | `init` — scaffold, CI, CODEOWNERS, witnesses | |
| 4 | Preview only — Inspector, Architect, `Plan`, diff; writes nothing | |
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
| [`SECURITY.md`](SECURITY.md) | the threat model, and what is *not* guaranteed |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | three commands and the rules the CI enforces |

## Licence

Apache-2.0 — the licence of Backstage, Kubernetes and Terraform. Its explicit patent
grant is what lets a company's legal team adopt the project without friction.
