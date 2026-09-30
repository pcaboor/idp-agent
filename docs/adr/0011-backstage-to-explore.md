# ADR-0011 — Backstage to explore: one snapshot per run; the model's words never become a request

**Date** 2026-09-28 · **Status** accepted; amended by [0013](0013-a-catalogue-read-in-part-says-so.md) and [0014](0014-a-kept-catalogue-is-read-again.md)

## Context

Every answer came from YAML on a disk: the demo SI, or a declarations repository. The
questions people ask of an information system — who owns `billing-api`, what breaks if
`mysql-prod-01` fails — are answered across every service repository, and the one place that
has read them all is the company's Backstage (`docs/backstage-http-brief.md` § 1). Reading it
over HTTP brings a new reach: a company's token, a company's catalogue, and every team's
unreviewed catalog-info in front of a model. The owner was first told the agents would query
it on demand (§ 6).

## Decision

With a catalogue configured (`IDP_BACKSTAGE_URL`, or `backstage:` in the personal
`config.yml`), the read commands and a question read it **once per run, before any model is
called**, into the graph a folder of YAML fills. Each item goes through **the same reader** as
a file (`readValue`), which reads `spec` and never the catalogue's derived `relations`. **One
transport** (`context/backstage/transport.ts`) is the only code that sends the token, from
`IDP_BACKSTAGE_TOKEN` alone, to the configured origin alone, on two `GET` routes, never
through a redirect nor into a child process; `tests/contract/key-reach.test.ts` proves it on
every provider. A read the catalogue could not give **whole is refused** (exit 1), never
answered from. And **the declarations repository decides**: nothing read over HTTP reaches a
plan's signature, policies, re-check or Reviewer.

## Rejected alternatives

**Lazy queries per tool call** — the model's words would become requests to the company's
Backstage, tools would turn async, and the overview, dangling detection and the commentary
check would lose the whole graph they need. **Backstage deciding writes** — it lags the
repository and ignores duplicates in silence (ADR-0003). **The catalogue in the prompt** —
unbounded, beside tools that already return bounded, witnessed rows. **Reading `relations[]`**
— a processor can add an edge nobody declared. **Every kind read whole** — Users are most of
a catalogue; the others are read as references. **`@backstage/catalog-client`** — it enforces
none of the bounds and exposes the write routes. **Backstage's MCP server or actions** —
alpha. **`GET /entities`** — deprecated, one unpaged array. **The search plugin** — an index,
not the catalogue of record. **A URL from `.idp-agent.yml`, an entity or the command line** —
each lets someone other than the person aim the token. **A silent fall back** to the
repository or the demo — an answer about something else. **A disk cache in this slice** —
company data at rest; slice 2 decides it.

## Consequences

No model output ever becomes a request, and the agents' closure stays network-free. The
graph a question is answered from is the one the engine re-reads, within a run. The cost is
the catalogue read on every run — every `idpa "<change>"` included, since a phrase is
classified from the read source — until slice 2's cache; `idpa plan` and `--repo` decide a
change without it. The Supervisor's and the Analyst's summary lists at most 30 values per
vocabulary list, the most frequent, since a catalogue's owners are unbounded. Catalogue
content reaches the model provider, and MLflow when tracing is on, which `SECURITY.md` and the
README state.
