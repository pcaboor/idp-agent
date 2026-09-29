# core/

The deterministic half of the tool: every export is a constant, a schema, or a pure function of its arguments — no
file system, no network, no model, no clock. `tests/architecture/dependencies.test.ts`
enforces it: `core/` imports neither `agents/` nor `llm/`, nor `http`, `net`, `tls` or any
fetch client; nothing from `context/`, `cli/`, `scaffold/`, `forge/` or `process/`; and
nothing reachable from it, however many hops away, reads or writes. `node:path` is
arithmetic on strings, not an I/O door.

The boundary exists because the agent drafts and the engine signs: a model picks a name, an
owner, a `dependsOn`, but nothing it proposes reaches a repository without crossing here,
and nothing here can be steered by what it validates. Hence the property tests run keyless.

- **Schemas** — `entitySchema`, `planSchema`, `operationSchema`, `PLAN_LIMITS`, `findUnknowns`,
  `isApplicable`, `RESOURCE_TYPES` behind `natureOf`/`folderOf`, and `.idp-agent.yml`'s
  `repositoryConfigSchema` with the serialiser `init --submit` will write it with
  (`schemas/config.ts`; `cli/config.ts` reads the file). The trust boundary: `Operation`
  is closed, so what is unmodelled cannot be requested, and an `{ unknown }` is never filled in.
  `entitySchema` reads Backstage's short references (`owner: team-a`) and yields the full
  `kind:namespace/name`, filling in only Backstage's own defaults; a proposal takes the full
  form only. It also keeps what an entity says it is — `metadata.links` and `spec.system`
  beside the description and tags — so `show` can print them; no proposal schema has a field
  for either. A system is refused only where Backstage refuses it (not a non-empty string):
  one these rules read is written in full (`system:<namespace>/<name>`, System the default
  kind), and one they cannot — an upper-case name, a namespace that cannot complete it — is
  kept as written, because a field that is only printed must not take its entity out of
  every command. Before it was read, zod stripped it, so a system that is not a string now
  rejects an entity that read before: one the catalogue itself would refuse.
  The read model is wider than the write model (design §4.1): `apiSchema` reads Backstage's
  `kind: API` — a type, a lifecycle, an owner and a definition, as Backstage requires, and
  refused with a reason without one — and keeps of the definition only the literal
  `declared`, so no reader downstream has its text to print or send. `CatalogueEntity` is
  `Entity | Api`, the read model's entities; the write side takes `Entity` and never meets an
  API. Backstage's organisation is read beside them, never among them: `groupSchema`,
  `userSchema`, `systemSchema` and `domainSchema` (`organisationSchema`, `ORGANISATION_KINDS`)
  require what Backstage requires of each kind, read `metadata.name` and `metadata.namespace`
  alone (`organisationMetadataSchema`), and write each reference in full with the kind
  Backstage's processor defaults it to. `GraphNode` is `CatalogueEntity | OrganisationEntity`:
  what the graph can hold. No proposal schema has a field for any of the four.
  A Component's `spec.providesApis` is read, a short reference taking API as its kind and the
  entity's namespace, and no proposal schema has a field for it. `spec.consumesApis` is not
  read — zod strips it — because consuming something is an access right here, and a second
  declaration of it would be a second truth.
- **Entity paths** — `computeEntityPath`, `resolveEntityPath`, `assertInsideRepo`,
  `PathEscapeError`. The engine, not the model, decides where a file lands, and containment is
  re-checked here rather than trusted to whichever caller eventually writes.
  `isCataloguePath` and `isCatalogueFolder` (`paths/catalogue.ts`) say which files of a
  declarations repository are catalogue: the one rule `context/iac-fs` walks by and the demo
  SI is read by, and the one the forge will prove a commit against.
- **The serialiser** — `serializeEntity`, `parseEntity`. The one place a structure becomes YAML,
  so `no` or `123` survive as strings for the YAML 1.1 readers that also read the repository.
  It writes links, a system and `providesApis` when an entity read from a file carries them,
  so that entity round-trips; the engine's own writes never do, and it never writes an API.
  `parseDocuments` is the matching one place YAML becomes entities, for `context/`'s readers and
  for the bytes a plan would write. It is two halves: `readDocuments` turns YAML into values — a
  document the parser faults is a rejection, never the value `toJS()` would have guessed — and
  `readValue` reads one value, returning one of six readings (`witness`, `rejected`, `ignored`,
  `api`, `organisation`, `entity`) that `parseDocuments` folds. The `backstage-http` provider
  calls `readValue` on each item a catalogue serves, so a catalogue meets the very decisions and
  refusal words a file does. `readValue` sorts before it judges: a Component or Resource goes to
  the strict `entitySchema` and comes back in `entities`, an API — in any case, as every kind —
  goes to `apiSchema` and comes back in `apis`, and a Group, a User, a System or a Domain goes to
  its own schema (`groupSchema`, `userSchema`, `systemSchema`, `domainSchema`) and comes back in
  `organisation`, apart, so every caller on the write side (the re-check, the edits, the gates)
  reads `entities` and cannot amend, count or file either. Of the organisation it reads a name
  and the references Backstage's processor turns into ownership, membership and system
  membership, and nothing else: an annotation, a title, a User's `spec.profile` are named on
  `not read:` (`unreadFieldsOf`) and kept nowhere. One the schema refuses — a Group without its
  `children`, a System without an owner — is `ignored`, its ref kept and its reason saying what
  Backstage requires, never a rejection: a Group is usually another team's, and an error in a
  file a plan edits would refuse the plan (`refusedOrganisation`). Three documents of each of
  these read kinds are set aside as before (`unreadReadKind`): one under another tool's
  apiVersion, one outside the `default` namespace, and one named in upper case, which Backstage
  allows and this grammar does not read. Another kind — a Location, a Template — or a mapping
  with no kind that is plainly another tool's, like a `mkdocs.yml` or a Helm `Chart.yaml`, is
  `ignored`, returned with a reason and never refused. Anything that looks like a failed entity — an empty kind,
  Backstage's `apiVersion` or a `metadata` with no kind, a document that is not a mapping — is
  still a rejection. A rejection's reason is `reasonOf`'s (`schemas/reject.ts`): the field's
  dotted path, then what is wrong with it. Handed the document, it tells a field nobody wrote
  from one written wrong, which zod words alike — an absent field reads `<path>: required`,
  with the values a closed set accepts (`spec.lifecycle: required — experimental, production
  or deprecated`), and so does one written with no value (`lifecycle:`, which YAML reads as
  null); a value that is there keeps zod's words, as does a reason a schema words itself (an
  API's absent definition).
- **Textual surgery** — `insertDocument`, `removeDocument`, `appendSequenceItem`,
  `listDocumentNames`. Line edits, because a reviewer must see an added line, not an AST
  round-trip's reformat. Locating a document by lines is a heuristic, so what it cannot
  locate it refuses, and `planEdits` reads every edit back with the parser before offering it.
- **The plan engine** — `plan/`, everything between a proposal and a diff: `signPlan`, the
  only producer of a `SignedPlan`, then `checkPolicies`, `recheckPlan` and `planEdits`, which
  take nothing else; `questionsOf` for what must be asked, `deriveOwners` and
  `reapplyAnswers` for what follows from the catalogue or was already answered, and the
  `Provenance` all of them read. The gates, their order and why: `plan/README.md`.
- **Validation** — `validate/`: `checkRepository`, the nine rules `validate` runs over a
  `RepositorySnapshot` and the re-check runs over the repository a plan would leave, and the
  Backstage registration — `renderRegistration` writes the Location `init platform` puts at
  the root, and the `registration` rule reads it back.
- **The diff** — `renderUnifiedDiff` (`diff/unified.ts`), a `FileEdit`'s bytes before and
  after as the unified diff a reviewer reads. The bytes are handed in, never read.

- **Commentary** — `checkCommentary`, `COMMENTARY_LIMITS` (`answer/commentary.ts`). The
  engine's check on the sentences a model writes around an answer (ADR-0008): a sentence
  naming an entity no tool returned, or an identifier nobody read, is dropped whole, in
  every script; the rest is bounded at a sentence boundary. Plain data in — the entities
  as `KnownEntity`, the witnessed references, the question — and the cleaner handed in,
  since nothing here imports a renderer.

**The rule: nothing in `core/` may read, write, fetch or ask.** Work that needs a disk belongs
in `context/` or `cli/`, work that needs a model in `agents/` or `llm/` — carve out the pure
part and leave only that here.
