# context/

`ContextProvider` (`provider.ts`) is the only seam between this tool and wherever the SI is
described: `readonly name`, and `load(): Promise<LoadResult>`. It exists because that source
changes on a schedule the rest of the code must not feel — fixtures in stages 1-2, `iac-fs` from
stage 4, `backstage-http` at MVP (design.md § 3). `FixtureProvider`, the only implementation
today, reads a directory laid out exactly like an IaC repository, so it already has stage 4's shape.

`LoadResult` pairs `entities` with `rejected: Rejection[]` — one `{ source, reason }` for every
document `entitySchema` refused. Throwing would lose every valid entity because of one bad one;
swallowing is what the catalogue does — it ignores duplicates in silence (design.md § 4.4)
and reports nothing for what it could not ingest — and a tool that inherits the failure mode
it exists to prevent is worth nothing.
`EntityGraph.danglingReferences()` obeys the same rule: reported, never pruned.

`EntityGraph.from(entities)` indexes them by `refOf(entity)` (`kind:default/name`) and answers
read-only questions: `get`, `search` over `SearchCriteria` (env read from `ENV_ANNOTATION`), and
three dependency queries. An edge counts whichever side declared it — `spec.dependsOn` on the
consumer, or `spec.dependencyOf` on a Resource — so `dependenciesOf(a)` contains `b` exactly when
`dependantsOf(b)` contains `a`: exact transposes, held by a test. Both are one declared hop over
present entities only, and `dependenciesOf` returns own declarations in file order, then derived
edges sorted. `consumersOf` is the multi-hop walk: breadth-first to the `Component`s behind the
accesses, with a visited set, because a hand-edited repository does contain cycles.

`context/` may reach the network later — `backstage/` will be an HTTP client. `core/` never may,
and `tests/architecture/dependencies.test.ts` fails the build if that slips.
