# context/

`ContextProvider` (`provider.ts`) is the only seam between this tool and wherever the SI is
described: `readonly name`, and `load(): Promise<LoadResult>`. It exists because that source
changes on a schedule the rest of the code must not feel — fixtures in stages 1-2, `iac-fs` from
stage 4, `backstage-http` for the read commands and questions from its slice 1 (design.md § 3,
ADR-0011). Three implementations exist, and `cli/` constructs each; the third,
`BackstageProvider`, for a configured catalogue, is below. `FixtureProvider`
reads the demo SI, a directory laid out exactly like an IaC repository. `IacFsProvider`
(`iac-fs/provider.ts`) reads a user's declarations repository through `readRepository`, so
`ask`, `graph` and `show` given `--repo` see the files `plan` and `validate` see, and a rejection's
`source` is the file's repository-relative path. `isDeclarationsRepository` (beside it, in
`iac-fs/snapshot.ts`) is how those three decide the working directory is one: a witnessed folder
directly under `catalog/` or `dependencies/`, read at the root and never walked, and not through
a symbolic link, which `readRepository` would not follow either. `isApplicationRepository`, beside it, is how
a change decides the working directory is a service's to inspect: a `catalog-info.yaml`/`.yml`
or a package manifest (`APPLICATION_MARKERS`, or a `*.csproj`) as a regular file at the root,
and not a declarations repository.

`LoadResult` pairs `entities` — the read model, `CatalogueEntity`: the Components and Resources
this tool writes and the Backstage APIs it only reads, each file's APIs after its other entities
— with `rejected: Rejection[]` — one `{ source, reason }` for every document `entitySchema` or
`apiSchema` refused — a Component, a Resource or an API missing what Backstage requires of one,
or anything that looks like a failed entity — or the parser faulted (a duplicate key or an
unclosed bracket, with its line and column; an alias bomb, which the parser stops on without a
position) — and with `ignored`, the same `source` and `reason` plus the `kind` and the reference,
for every document this tool does not model: a Location, a Group Backstage would refuse, a
`mkdocs.yml` beside the entities. Those are part of a real catalogue, so they are set aside
rather than refused, `main` counts them in one line, and a reference to one is not called
dangling. `organisation`, absent when there is none, is the Groups, Users, Systems and Domains
read — beside the entities, never among them — and `judged`, which only `BackstageProvider`
sets, the organisation kinds a catalogue read whole: a reference to one of them is judged
against what was read, and a folder's Group files are never the whole organisation.
Both readers go through `core/`'s `parseDocuments`, the one reader of entity documents
(`readDocuments` for the YAML, then `readValue` for each value, the half a catalogue's items
will meet too), and `iac-fs` also rejects a file it cannot open — no permission, a link to
nothing — rather than ending `validate` on a stack trace. Throwing would lose every valid entity
because of one bad one; swallowing is what the catalogue does — it ignores duplicates in silence
(design.md § 4.4) and reports nothing for what it could not ingest — and a tool that inherits
the failure mode it exists to prevent is worth nothing.
A reference two documents declare is read as its first declaration, whole — fields, edges
and dangling references — as the catalogue resolves a duplicate and as a plan amends one;
the second stays in `all()`, for `validate` to report.
`EntityGraph.danglingReferences()` obeys the same rule: reported, never pruned — and shown
where the relations it breaks are shown, never resolved by guess. The graph keeps, per
entity, each reference it declares in `dependsOn`, `dependencyOf` or `providesApis` that
resolves to nothing — no entity, no document set aside — as an `Unresolved`: who declares
it, the field, the reference as the reader normalised it, and `sameName`, the entities whose
name is its own under another kind or namespace (an exact name; none, one or several).
`unresolvedOf(ref, field?)` reads an entity's, and `unresolvedConsumersOf(ref)` the
services the rights and objects on `consumersOf`'s walk name and nothing declares — a
service that walk cannot reach, since nothing is there. Only `component:` references: what
`consumersOf` would list if they resolved; a missing Resource would be walked through, and
stays on its right's own `dependencyOf`. `danglingReferences()` is that
list flattened, so the summary, `graph`, the overview, `show`'s card and the Analyst's rows
share one definition. No edge is added and no query answers differently: a
`component:default/payments-api` beside a `resource:default/payments-api` is named, not
corrected.

`graph/overview.ts`'s `overviewOf(graph, unread)` is the data behind `ask`'s `overview` answer,
computed here and rendered in `cli/`: exact counts by kind, type, environment (undeclared, or
blank, counted apart), owner, system (none counted apart) and tag, every entity that describes
itself with its description as the file wrote it, the rights and the level each states, the
objects by the services and then the rights reaching them — walked as `consumersOf` walks, since
a declarations repository's grants name services declared elsewhere — every dangling reference,
what the reader set aside and rejected — and, only where there are any, the Backstage APIs and
how many a service provides. Exact where `summary.ts` buckets — that one is a prompt, this is
read by a person — and every list sorted count first, then name.

`graph/summary.ts`'s `summariseGraph` is that prompt's data: the counts in buckets, the
dangling references exactly, the vocabulary — every kind, type, environment and owner in use,
which the gates read whole — and `counts`, how many entities state each value. The Supervisor's
and the Analyst's summary is handed the counts, and past 30 values a list shows the 30 most
frequent and how many more (`shownVocabulary` in `agents/summary.ts`), since a company
catalogue's owners are unbounded; the Architect's is handed none, and shows every value.

`EntityGraph.from(entities, aside, organisation)` indexes them by `refOf(entity)`
(`kind:default/name`) and answers read-only questions: `get`, `search` over `SearchCriteria`
(env read from `ENV_ANNOTATION`), and three dependency queries. The organisation is an index
of its own beside them — never in `all()`, `get()` or `search()`, so nothing built from those
sees a Group — which `node()` and `nodes()` read with the entities, and `ownedBy`,
`membersOf`, `groupsOf`, `childrenOf`, `parentsOf`, `partsOf` and `wholeOf` answer, each
membership read from both ends. Its references naming nothing are a list of their own,
`unresolvedOrganisationOf(ref, field)`, and only for the kinds `OrganisationRead.judged` names:
`danglingReferences()` and `unresolvedOf` are the write model's three fields, unchanged. An edge counts whichever side declared it — `spec.dependsOn` on the
consumer, or `spec.dependencyOf` on a Resource — so `dependenciesOf(a)` contains `b` exactly when
`dependantsOf(b)` contains `a`: exact transposes, held by a test. Both are one declared hop over
present entities only, and `dependenciesOf` returns own declarations in file order, then derived
edges sorted. `consumersOf` is the multi-hop walk: breadth-first to the `Component`s behind the
accesses, with a visited set, because a hand-edited repository does contain cycles.
An API is a node like any other: a right that `dependsOn` `api:…` resolves to it, so
`consumersOf` finds its consumers through the rights over it. Providing one is a relation of
its own, not a dependency either way: `providedApisOf(component)` reads `spec.providesApis`,
one declared hop in file order, and `providersOf(api)` is its exact transpose, sorted. A
`providesApis` naming nothing is a dangling reference, as a `dependsOn` one is.
`spec.consumesApis` is never read (design §4.1): consumption is the right — but it is
counted: every field of an entity or an API the read model does not read (`relations`,
`spec.consumesApis`, `metadata.uid`) is in `LoadResult.unread` (`unreadFieldsOf`), and the
read commands say them on one `not read:` line, as the documents set aside are said. A
`title`, the `labels` and a Component's `subcomponentOf` are read, and `show` prints them.
A title or a label is text, as Backstage requires: one that is not (`tier: 1`) refuses its
entity, as a number among the annotations does, where it was stripped before and the
entity loaded. `plan` builds its graph without the API nodes, puts their references among
the documents set aside and strips each Component's `providesApis`, so a change is decided
against the write model: an API is a reference that resolves, and a `providesApis` naming an
API declared elsewhere is no dangling reference in the summary the Architect reads. What does differ from before: an API missing
what Backstage requires is refused rather than set aside, so a right over it dangles there,
as `validate` says.

`graph/relations.ts`'s `relationsOf(graph, ref, relation, options)` is every relation of one
entity, computed from the declarations and never inferred: `depends-on` and `impacts`, every
hop along `dependenciesOf` and `dependantsOf`, transitively; `consumes`, what a consumer
reaches through its rights — the objects each right is over, and onward when a depth is
asked; `consumed-by`, the services behind an object, walked as `consumersOf` walks;
`provides` and `provided-by`, one declared hop of `providesApis`; and `between`, every simple
path where one of two entities depends on the other, whichever it is. Where there is none,
`shared` holds the nearest entities both reach (`Meeting`): what both depend on, or what
depends on both, each with the shortest path from either end — two services one right
names meet at the right, two consumers of a database at the database and not again at its
host. Apart from both, `nearMisses` holds any declaration on the way that names nothing and
carries the other end's name: it reaches nothing, so it is never counted as a path. Each row is a path of `Step`s from the
entity asked about: every entity with its kind, type and environment, a right with what it
grants (`Grant`: whether its type states a level, and the level declared), and a reference
declared nowhere as its last step, the `Unresolved` the graph already keeps. It defines no
edge, right, level or dangling reference of its own — it composes `dependenciesOf`,
`dependantsOf`, `providedApisOf`, `providersOf`, `natureOf`, `levelledOf`, `declaredLevel`
and `unresolvedOf` — and `relations.test.ts` holds `consumed-by` to `consumersOf` and
`unresolvedConsumersOf` for every entity of four repositories. Breadth-first with a visited
set: every declared edge from an entity walked through is a row when the relation lists its
end, so a consumer with two rights over one object is two rows; an edge back onto its own
path is not followed. The cycles are found on the edges the walk followed, depth-first, and
reported as the path from the entity asked about that closes on itself — not on the walk's
paths, since two entities reached along two branches and depending on each other close on
neither. Bounded by a depth and a row count (`RELATION_LIMITS`), `between` by a budget of
steps too, and each bound says when it was reached (`stopped`, `total`, `exhausted`; each
`Bounded` list its own `total`). Ordered by depth, then the reference reached, then
the path, so the answer does not depend on the order files were read in. `cli/`'s
`relations` prints it and the Analyst's `get_relations` returns it; neither computes.

The organisation is walked by the same `walked`, six relations of its own
(`ORGANISATION_RELATIONS`, beside `RELATIONS`, which does not change): `owns`, what names a
Group or a User as owner (`ownedBy`), down a Group's child Groups (`childrenOf`), which are
walked through and not listed; `owned-by`, the owner and the Groups above it (`parentsOf`);
`member-of`, a User's Groups (`groupsOf`) or a Group's parents, and theirs; `has-member`, a
Group's Users (`membersOf`) and child Groups, and theirs; `part-of`, what a node's `system`,
`domain` or `subdomainOf` names (`wholeOf`), upward; `has-part`, what names a System or a
Domain (`partsOf`), downward. Each is asked of the kinds it starts from and computes no row
of another, as `provides` of a database does, and `relationsOf` resolves its subject with
`graph.node(ref)`, so an entity relation of a Group is empty rather than unknown, even where
a `dependsOn` names the Group; both of `between`'s ends are entities. Each follows only the
kinds its edges are of: a Group's hierarchy runs from a Group to Groups, a member is a User,
an owner a Group or a User, a whole a System or a Domain. The reader keeps a reference's own
kind, so a Group's `children` naming a User, or its `parent` naming one, resolves to a node
and is no edge of any walk: no row, and not dangling either. A step of an organisation node
carries its kind and its type when it states one, never an environment or a right. A judged
reference naming nothing ends its path as a dangling one does (`unresolvedOrganisationOf`);
a judged one naming a document set aside ends it on that reference, `setAside` — in the
catalogue, not read — and never declared nowhere; an unjudged one no node carries is no row,
and what the subject declares of it for the first hop is `named`, with whether the source
holds that kind at all (`unreadOrganisationOf`, `holdsKind`). The Analyst's `get_relations`
still asks of an entity alone until Task 3.3 decides what it is shown of the organisation.

`project-fs/snapshot.ts` reads the other repository: the **application** one, the one a service
lives in. `readProject(root)` returns the text of what it read and a `skipped` entry, with a
reason, for every single thing it did not — a file dropped without a word is a file the user
believes was read. It exists here rather than in `agents/` because no module reachable from an
agent may import a filesystem, and everything it returns is on its way to a model at a third
party: hence only the files git tracks when the directory is in a git repository (`git ls-files`,
with no shell and none of the repository's own commands; an untracked path is counted, never
named), the exclusion list (`.env*`, key
material, credential files, `.git/`, `node_modules/` and hidden directories bar `.github`), the
content test of `project-fs/secrets.ts` — key material, a known issuer's token, a secret assigned
a literal, every match examined, escaped and base64 text decoded — the `lstat`-then-`realpath` symlink refusal, and three caps —
200 files, 64 KB each, 1 MB in total. The caps are spent on the service's signal files first —
its manifests, `package.json` before any other, CODEOWNERS, catalog-info, charts, Dockerfiles,
compose files and deployment YAML, a README — the shallower first, then the rest by depth; the
files are still handed over in path order, so a repository under the caps sends what it always
sent. `truncated` is true only when a cap stopped the read, never when one file was skipped, and
`leftOut` counts what the caps left unread — `signalsLeftOut`, how many of those were signal
files; `selection` says whether the files were git's, a walk's outside git, or none.
`declarations` holds every `catalog-info*.yaml`/`.yml`, read whole and outside the caps — the
root's from the disk, tracked or not — each with the workspace it sits in, a folder with a
package manifest of its own, for `init` to compare with and diff against. Only the CLI reads
these, and none of them reaches a model. Its one child process, `git`, runs in the environment
`spawned-environment.ts` builds: the process's, without `IDP_BACKSTAGE_TOKEN` or any other
`IDP_BACKSTAGE_*` variable and without any `*_API_KEY`, which `git` in an inspected repository — its hooks and its configuration are its
author's — has no use for. `spawnedEnvironment` is the one builder of a child process's
environment, and the architecture rules hold every call that starts a process to it.

`backstage/` is where `context/` reaches the network (`backstage-http`, slice 1 of
`docs/backstage-http-brief.md`), and `backstage/transport.ts` is its one way out: the only code
that sends a catalogue token. `catalogueTransport` is handed the base URL, the token as a
value and a `catalogueFetch` — none read from the environment or the global here — and sends
`GET` on the two routes of `CATALOGUE_REQUESTS` alone, to the base's origin and path, checked
again once the URL is built (`catalogueUrl`) and before the header exists; with
`redirect: 'error'`, a 3xx, a response marked redirected or one from another address refused
unread; every body counted while it streams, per response and per run, and every request
bounded in time, its body included; a 429 waited for only when it says how long, within the
bounds of `backstage/limits.ts`, which holds every bound of the note's § 6. A failure is a
`CatalogueReadError` over the closed `CatalogueFailure`, its message the failure and the
origin alone: no body, header, cause or token.

`backstage/provider.ts`'s `BackstageProvider` builds the transport under one
`AbortSignal.timeout` for the whole load, and returns a whole catalogue as a `LoadResult` or
throws a `CatalogueReadError`: nothing partial. `backstage/load.ts`'s `loadCatalogue` asks
`entity-facets?facet=kind` once — a kind the kind grammar refuses ends the load, since a
filter is never built from other text — then reads Components, Resources and APIs whole,
always; then Groups, Users, Systems and Domains, those the facets name and only when they name
one, for the fields the read model reads of them and nothing else (`ORGANISATION_FIELDS`: no
annotation, no title, no profile), under a ceiling of their own (`organisationEntities`); and
every other kind the facets name as refs (`fields`). Each next page sends the
cursor, the same `limit` and `fields`, and never `filter`, as Backstage's own client does;
a cursor seen twice, an item with no string `metadata.uid`, an item of a kind its read's
filters did not name (a server that ignores `filter` would pass whole entities off as refs),
a page that is not the envelope,
fewer distinct uids than the first page's `totalItems` (repeats or not: Backstage pages by a
key an update does not change) and either ceiling of `limits.ts` each end the load, with
their `CatalogueFailure`. A uid served twice, in one read or across two, is kept once and
counted in `LoadResult.census`, whose `served` is the distinct uids of every read, beside
the pages, bytes and time. The organisation kinds the facets named are `judged`. `backstage/translate.ts`'s `prePass`
then takes off what the catalogue added (`relations`, `status`, `metadata.uid`,
`metadata.etag`) and sets aside what it accepted and this tool does not model — a
Component or Resource whose namespace is anything but `default` exactly (`DEFAULT`, or a
namespace that is not text, would shadow its namesake), a `backstage.io/v1beta1` one, a name
in upper case, a lifecycle or a Resource type this tool does not write, an item nested past
64 or holding a `__proto__` or `constructor` key — as an `Ignored` marked `prePass`, so the
graph's `aside` set takes it as it takes a Group. Everything else goes through `readValue`,
the file road's reader; entities are ordered by `backstage.io/managed-by-location`, then
ref, which is the file road's order wherever a location holds one entity, and a rejection's
`source` is its ref and that location. `tests/unit/backstage-provider.test.ts` proves the
demo SI served by the fake (`tools/fake-backstage.ts`) reads as its files do, and
`pnpm demo:backstage` runs the built binary against that fake on a loopback port.

Nothing in `context/` names `fetch` or a
global way out or imports a network module, only the transport calls the `catalogueFetch` it is handed, and nothing reachable
from `agents/` is in `backstage/` — three rules of `tests/architecture/dependencies.test.ts`, which
read the source for the word because `fetch` needs no import. `core/` never reaches the network,
and the same file fails the build if that slips.
