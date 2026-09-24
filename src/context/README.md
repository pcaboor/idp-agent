# context/

`ContextProvider` (`provider.ts`) is the only seam between this tool and wherever the SI is
described: `readonly name`, and `load(): Promise<LoadResult>`. It exists because that source
changes on a schedule the rest of the code must not feel — fixtures in stages 1-2, `iac-fs` from
stage 4, `backstage-http` at MVP (design.md § 3). `FixtureProvider`, the only implementation
today, reads a directory laid out exactly like an IaC repository, so it already has stage 4's shape.

`LoadResult` pairs `entities` with `rejected: Rejection[]` — one `{ source, reason }` for every
document `entitySchema` refused, or the parser faulted (a duplicate key or an unclosed bracket,
with its line and column; an alias bomb, which the parser stops on without a position). Both
readers go through `core/`'s `parseDocuments`, the one reader of entity documents, and `iac-fs`
also rejects a file it cannot open — no permission, a link to nothing — rather than ending
`validate` on a stack trace. Throwing would lose every valid entity because of one bad one;
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

`project-fs/snapshot.ts` reads the other repository: the **application** one, the one a service
lives in. `readProject(root)` returns the text of what it read and a `skipped` entry, with a
reason, for every single thing it did not — a file dropped without a word is a file the user
believes was read. It exists here rather than in `agents/` because no module reachable from an
agent may import a filesystem, and everything it returns is on its way to a model at a third
party: hence the exclusion list (`.env*`, key material, credential files, `.git/`, `node_modules/`
and hidden directories bar `.github`), the content test for a PEM header behind an innocent name,
the `lstat`-then-`realpath` symlink refusal, and three caps — 200 files, 64 KB each, 1 MB in total.
`truncated` is true only when a cap stopped the read, never when one file was skipped.

`context/` may reach the network later — `backstage/` will be an HTTP client. `core/` never may,
and `tests/architecture/dependencies.test.ts` fails the build if that slips.
