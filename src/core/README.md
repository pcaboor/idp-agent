# core/

The deterministic half of the tool: every export is a constant, a schema, or a pure function of its arguments — no
file system, no network, no model, no clock. `tests/architecture/dependencies.test.ts`
enforces it: `core/` imports neither `agents/` nor `llm/`, nor `http`, `net`, `tls` or any
fetch client. `node:path` is arithmetic on strings, not an I/O door.

The boundary exists because the agent drafts and the engine signs: a model picks a name, an
owner, a `dependsOn`, but nothing it proposes reaches a repository without crossing here,
and nothing here can be steered by what it validates. Hence the property tests run keyless.

- **Schemas** — `entitySchema`, `planSchema`, `operationSchema`, `PLAN_LIMITS`, `findUnknowns`,
  `isApplicable`, `RESOURCE_TYPES` behind `natureOf`/`folderOf`. The trust boundary: `Operation`
  is closed, so what is unmodelled cannot be requested, and an `{ unknown }` is never filled in.
- **Entity paths** — `computeEntityPath`, `resolveEntityPath`, `assertInsideRepo`,
  `PathEscapeError`. The engine, not the model, decides where a file lands, and containment is
  re-checked here rather than trusted to whichever caller eventually writes.
- **The serialiser** — `serializeEntity`, `parseEntity`. The one place a structure becomes YAML,
  so `no` or `123` survive as strings for the YAML 1.1 readers that also read the repository.
  `parseDocuments` is the matching one place YAML becomes entities, for `context/`'s readers
  and for the bytes a plan would write: a document the parser faults is a rejection, never
  the value `toJS()` would have guessed. It sorts before it judges: a Component or Resource
  goes to the strict `entitySchema`, while another kind — a Group, an API — or a mapping
  with no kind that is plainly another tool's, like a `mkdocs.yml` or a Helm `Chart.yaml`,
  is `ignored`, returned with a reason and never refused. Anything that looks like a failed
  entity — an empty kind, Backstage's `apiVersion` or a `metadata` with no kind, a document
  that is not a mapping — is still a rejection.
- **Textual surgery** — `insertDocument`, `removeDocument`, `appendSequenceItem`,
  `listDocumentNames`. Line edits, because a reviewer must see an added line, not an AST
  round-trip's reformat. Locating a document by lines is a heuristic, so what it cannot
  locate it refuses, and `planEdits` reads every edit back with the parser before offering it.

**The rule: nothing in `core/` may read, write, fetch or ask.** Work that needs a disk belongs
in `context/` or `cli/`, work that needs a model in `agents/` or `llm/` — carve out the pure
part and leave only that here.
