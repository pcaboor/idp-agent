# Stage 3 — `init platform` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Tick them as you go.**

**Goal:** Scaffold an IaC repository a platform team can adopt, and ship the validator its
CI needs — because the catalogue ignores duplicates in silence, and CI is what must refuse.

**Architecture:** Three pure layers and one writer. `core/validate/` holds the rule engine
and touches no disk. `context/iac-fs/` reads a repository into a snapshot. `scaffold/`
derives the file list from the resource-type registry and writes it, never clobbering.
`cli/` exposes `init platform` and `validate`. The generated CI workflow calls the shipped
`validate` command rather than carrying a second rule engine.

**Tech Stack:** TypeScript 7, Node 22+, Vitest 5, Zod 4 (`z.toJSONSchema`), `yaml` 2.

## Global Constraints

Inherited and still binding — see `docs/design.md` §4, `AGENTS.md`.

- **`pnpm test` needs no API key, no network and no Docker. Ever.** `node:fs` is not
  blocked: writing into a `mkdtemp` directory in a test is legal, and this stage does it.
- **One witness file per folder.** A pattern with no match is a read error, not an empty
  set (§4.4). The scaffold writes one per registry folder, and `validate` refuses a folder
  that holds entities without one.
- **Never ignore in silence.** The catalogue accepts duplicates; CI must refuse them
  (§4.4). That sentence is the functional spec of `validate`.
- **Absent means already done.** Re-running `init platform` over an existing repository
  writes nothing, reports what it kept, and exits 0 — it must never raise, and never
  clobber a hand-edited file.
- **Declare, never infer.** `--owner` is required; no owner is guessed from a git remote
  or a directory name.
- **An entity's location is read from the entity**, through its annotation, never inferred
  from its type — `validate` compares against `resolveEntityPath`, it does not re-derive.
- **The merge is the act of authorisation.** Nothing here writes to a branch, opens a
  request, or touches a forge.
- **`core/` may not read, write, fetch or ask** (`src/core/README.md`). The rule engine
  lives there; the reader and the writer do not.
- English throughout. Conventional Commits. No `switch` on a closed union without
  `const _exhaustive: never = value`.

---

## Scope, and the three contradictions this plan resolves

`docs/design.md` §7.2 and §7.3 describe the *finished* v0.1 behaviour of two commands whose
capabilities accrete across stages 3→6. §11 describes what ships in week 4. Where they
disagree, §11 wins and §7.2/§7.3 are amended to say which stage brings what.

**1. The per-application `init` (§7.3) needs stage 4 and 5.** It "inspects the repository"
(the Inspector, stage 4), "proposes a `catalog-info.yml` through the same `propose()` path"
(the Architect and `propose()`, stage 4), and ends in a merge request (`ForgeProvider`,
stage 5-6). Only "writes `.idp-agent.yml`" is stage-3-sized, and it is worthless alone.

→ `idp-agent init` ships as a **tested refusal**: exit 3, naming what it waits for. Not a
stub, not a TODO — a documented boundary with a test.

**2. §7.2's live token check needs a forge.** "A live check that the supplied token can
open a request but cannot merge one" requires `ForgeProvider`, which is stage 5-6.

→ Stage 3 **prints** the required branch-protection settings and says plainly that it
cannot verify them yet. The printing half is this stage; the verifying half is stage 6.
The sentence the design is proudest of — *"an automaton that verifies its own
powerlessness, out loud"* — is honoured by admitting the verification is missing.

**3. §7.2 lists five folders; the registry declares six.** `dependencies/gateway` exists in
`RESOURCE_TYPES` and nowhere else — not in §7.2, not in `fixtures/si-demo/`, so the fixture
SI violates the one-witness-per-folder rule it is supposed to demonstrate.

→ The scaffold derives its folders from `RESOURCE_TYPES`, never from a literal list, so it
writes six. The missing fixture folder and its witness are added in task 1, and a test
asserts the registry and the fixtures agree from now on.

### Answered before planning

- **npm.** The generated workflow runs `npx --yes idp-agent@<version> validate .`, so the
  package must exist for a scaffolded repository's first CI run to pass. `idp-agent` is
  free on npm. **`0.1.0-rc.1` is published in task 8**, ahead of the stage-7 schedule,
  because the most useful thing this stage ships is otherwise dead on arrival.
- **`--owner` is a forge handle**, permanently: `@user` or `@org/team`, validated as such.
  It is **not** an `ownerRef` (`group:default/tiger`) — reusing `ownerRefSchema` here is the
  trap. Stage 4 introduces `--owner-ref` when entities start being written.
- **No root marker.** The scaffolded repository carries no `.idp-agent.yml`: §7.0 puts that
  file in the *application* repo with a different shape, and two files sharing a name and
  not a schema is worse than none. Stage 4 must therefore be **told** where the IaC
  repository is, by flag or by the application's own config. This is irreversible for every
  repository scaffolded from now on.

---

## What the user types

```bash
idp-agent init platform <directory> --owner @acme/platform
idp-agent validate <directory>
idp-agent init                      # refused, exit 3
```

| Case | Output | Exit |
|---|---|---|
| `init platform`, nothing existed | `wrote 12 · kept 0`, the file list, the protection block | 0 |
| `init platform`, re-run | `wrote 0 · kept 12`, same list, same block | 0 |
| `init platform`, partial | `wrote 4 · kept 8` | 0 |
| `--owner` missing or not a handle | stderr: `init platform needs --owner, e.g. --owner @acme/platform` | 2 |
| directory absolute, traversing, or absent | stderr: the `PathEscapeError` message | 2 |
| a write fails mid-way | stderr names the path; only genuinely written files are reported | 1 |
| `idp-agent init` | stderr: `per-application init arrives at stage 4 …` | 3 |
| `validate`, conforms | `<n> entities in <m> files, 0 violations` | 0 |
| `validate`, warnings only | one line per warning, then the count | 0 |
| `validate`, one or more errors | one line per violation, file-anchored | 1 |

**No fifth exit code.** `EXIT.notFound`'s documented meaning widens from *"the query
resolved nothing"* to *"the answer is negative — nothing matched, or the repository does
not conform"*. A future policy refusal is *"understood, and this build will not act"* —
that is exit 3, already shipped.

The block `init platform` prints on every run, including the no-op:

```
Branch protection is set in the forge, not here. Required on the default branch:
  · require a pull request before merging — 1 approval
  · require review from Code Owners
  · dismiss stale approvals on a new push
  · no force push, no branch deletion
  · include administrators
This build cannot verify these. The live token check — that the token which opens
a request cannot merge it — arrives at stage 6.
```

---

## File Structure

### What the scaffold writes — 12 files

| Path | Source |
|---|---|
| `catalog/{databases,caches,apis}/.witness.yml` | folder **derived from `RESOURCE_TYPES`**, body static |
| `dependencies/{access,network,gateway}/.witness.yml` | idem — six folders, not the five §7.2 lists |
| `schemas/entity.schema.json` | **generated**, `z.toJSONSchema(entitySchema, { io: 'input' })` |
| `schemas/plan.schema.json` | **generated**, same over `planSchema` |
| `.github/workflows/validate.yml` | template, one interpolation: the pinned version |
| `CODEOWNERS` | generated from `--owner` |
| `README.md` | template — the doctrine, and the two things this build cannot do |
| `.gitignore` | template, stored as `gitignore` (npm renames a packaged `.gitignore`) |

**Not written:** `components/` — a Component lives in its own repository, and
`resolveEntityPath` throws rather than place one. No `.idp-agent.yml`. No `git init`; the
generated README's first line says to run it.

### New source files

| File | Responsibility |
|---|---|
| `src/core/schemas/json-schema.ts` | `entityJsonSchema()` / `planJsonSchema()` — Zod → JSON Schema, input mode |
| `src/core/validate/rules.ts` | `checkRepository(snapshot)` → `Violation[]`. Pure, no `fs`, the one rule engine |
| `src/context/iac-fs/snapshot.ts` | `readRepository(root)` — keeps the file provenance `FixtureProvider` discards |
| `src/scaffold/templates.ts` | `loadTemplates()` — template bodies, resolved off `import.meta.url` |
| `src/scaffold/layout.ts` | `scaffoldLayout()` — pure; the only place the registry→folder derivation happens |
| `src/scaffold/codeowners.ts` | `isForgeHandle` / `renderCodeowners`. Not `ownerRefSchema` |
| `src/scaffold/write.ts` | `writeScaffold()` — the **only** module under `scaffold/` touching `node:fs` |
| `src/scaffold/README.md` | why the writer sits outside `core/` |
| `src/cli/commands/init.ts` | `runInitPlatform` · `runInit` (the tested refusal) |
| `src/cli/commands/validate.ts` | `runValidate` |
| `templates/iac-repo/**` | `witness.yml` · `README.md` · `gitignore` · `github/workflows/validate.yml` |

Reused rather than rewritten: `RESOURCE_TYPES` / `folderOf`, `assertInsideRepo` +
`PathEscapeError` on every path, `resolveEntityPath` for the misplacement rule,
`entitySchema` / `planSchema`, `FixtureProvider` as a second acceptance oracle,
`EXIT` / `CommandResult` / `MainDeps`, and `scripts/smoke.mjs`'s `check()`.

Why the writer is not in `core/`: `src/core/README.md` says nothing there may read, write,
fetch or ask. Why it is one file: stage 5's atomic applier replaces that seam, and one file
is a refactor where five would be a rewrite.

---

### Task 1: Make the fixture SI obey its own rule, and correct the stale documents

The registry declares six folders; the fixture SI has five. The sixth has no witness, so
the repository that exists to demonstrate the one-witness-per-folder rule breaks it.

**Files:**
- Create: `fixtures/si-demo/dependencies/gateway/.witness.yml`
- Modify: `tests/unit/resource-types.test.ts`
- Modify: `docs/design.md` (§7.2, §7.3), `AGENTS.md`

**Interfaces:**
- Consumes: `RESOURCE_TYPES`, `folderOf` from `core/schemas/resource-types.ts`
- Produces: nothing importable. A guarantee, and documents that stop lying.

- [x] **Step 1: Write the failing test**

Add to `tests/unit/resource-types.test.ts`:

```typescript
import { readdir } from 'node:fs/promises'
import path from 'node:path'

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/si-demo')

it('every folder the registry declares exists in the fixture SI, with a witness', async () => {
  // The fixture SI is a valid IaC repository, not a test-only shape: a folder
  // the registry knows and the repository lacks is a hole the one-witness rule
  // is meant to make impossible (design 4.4).
  const missing: string[] = []
  for (const type of RESOURCE_TYPE_NAMES) {
    const folder = path.join(FIXTURES, folderOf(type))
    const entries = await readdir(folder).catch(() => undefined)
    if (entries === undefined) missing.push(`${folderOf(type)} (no folder)`)
    else if (!entries.includes('.witness.yml')) missing.push(`${folderOf(type)} (no witness)`)
  }
  expect(missing).toEqual([])
})
```

- [x] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/unit/resource-types.test.ts`
Expected: FAIL — `["dependencies/gateway (no folder)"]`.

- [x] **Step 3: Add the missing witness**

Create `fixtures/si-demo/dependencies/gateway/.witness.yml`, byte-identical to the others:

```yaml
# Declares nothing. Its absence would make a glob return an empty set
# instead of failing, and an empty set reads as "nothing to do".
```

- [x] **Step 4: Run the tests**

Run: `pnpm test`
Expected: PASS. The entity count is unchanged — a witness parses to `null` and
`FixtureProvider` skips it, which the existing fixtures test already asserts.

- [x] **Step 5: Correct the documents**

In `docs/design.md` §7.2, replace the five-folder tree with one that says where the folders
come from, and split the verification sentence by stage:

```markdown
iac-repo/
├── catalog/…                         one folder per object type, from the registry
├── dependencies/…                    one folder per right type, from the registry
│   └── each with a .witness.yml      a pattern with no match must fail, not return empty
├── schemas/                          JSON Schemas exported from Zod
├── .github/workflows/validate.yml    calls `idp-agent validate`, which refuses what the
│                                     catalogue would accept
├── CODEOWNERS
└── README.md                         the doctrine, written down
```

**What the tool cannot do, and says so.** Branch protection is set in the forge interface.
The tool prints the exact settings required. **From stage 6** it also verifies them,
including a live check that the supplied token can open a request but cannot merge one,
and refuses to report success until that check passes.

In §7.3, mark the per-application `init` as arriving with `propose()`:

**`idp-agent init` — once per application (stage 4).** Needs the Inspector and `propose()`.
Until then the command exists and refuses, naming what it waits for.

In `AGENTS.md`: the test count (`221` → the real number), and `Three architecture rules`
→ the real list, which has been seven since stage 2.

- [x] **Step 6: Commit**

```bash
git add fixtures/si-demo/dependencies/gateway tests/unit/resource-types.test.ts docs/design.md AGENTS.md
git commit -m "fix(fixtures): give the gateway folder its witness, and correct the stale counts"
```

---

### Task 2: Export the schemas from Zod, and say what JSON Schema cannot hold

**Files:**
- Create: `src/core/schemas/json-schema.ts`
- Create: `tests/unit/json-schema.test.ts`

**Interfaces:**
- Consumes: `entitySchema`, `planSchema`, `RESOURCE_TYPE_NAMES`
- Produces:
  - `function entityJsonSchema(): Record<string, unknown>`
  - `function planJsonSchema(): Record<string, unknown>`
  - `const UNENFORCED_BY_JSON_SCHEMA: readonly string[]`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/json-schema.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import {
  UNENFORCED_BY_JSON_SCHEMA,
  entityJsonSchema,
  planJsonSchema,
} from '../../src/core/schemas/json-schema.js'
import { resourceSchema } from '../../src/core/schemas/entity.js'

describe('entityJsonSchema', () => {
  it('does not require annotations, which have a default', () => {
    // io: 'input' is load-bearing. In output mode a field with .default({})
    // is marked required, and every hand-written entity in a real repository
    // would go red against the schema this stage ships.
    const schema = JSON.stringify(entityJsonSchema())
    expect(schema).toContain('annotations')
    const required = JSON.stringify(entityJsonSchema()).match(/"required":\[[^\]]*\]/g) ?? []
    expect(required.some((group) => group.includes('annotations'))).toBe(false)
  })

  it('enumerates every resource type the registry declares', () => {
    const schema = JSON.stringify(entityJsonSchema())
    for (const type of ['database', 'cache', 'api', 'database-access', 'network-access', 'gateway-route']) {
      expect(schema).toContain(type)
    }
  })

  it('names what it cannot enforce, rather than exporting a schema that looks complete', () => {
    // Zod's superRefine has no JSON Schema equivalent: the export accepts a
    // database carrying dependencyOf, which resourceSchema refuses. A schema
    // that is quietly weaker than the validator is a trap for whoever trusts it.
    const looser = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: { name: 'x' },
      spec: { type: 'database', owner: 'group:default/t', dependencyOf: ['component:default/a'] },
    }
    expect(resourceSchema.safeParse(looser).success).toBe(false)
    expect(UNENFORCED_BY_JSON_SCHEMA.join(' ')).toMatch(/dependencyOf/)
    expect(JSON.stringify(entityJsonSchema())).toContain('$comment')
  })
})

describe('planJsonSchema', () => {
  it('exports without throwing, and describes the operation union', () => {
    expect(JSON.stringify(planJsonSchema())).toContain('create-entity')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/unit/json-schema.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/core/schemas/json-schema.ts`:

```typescript
import { z } from 'zod'
import { entitySchema } from './entity.js'
import { planSchema } from './plan.js'

/**
 * The rules Zod enforces that JSON Schema has no way to express. They are
 * emitted as a `$comment` on the exported schema rather than left implicit: a
 * schema that is quietly weaker than the validator is worse than no schema,
 * because it is trusted.
 */
export const UNENFORCED_BY_JSON_SCHEMA: readonly string[] = [
  'only a right-nature type may carry spec.dependencyOf (an object has no consumers)',
  'entity names must match the path they are filed under',
]

/**
 * `io: 'input'` is load-bearing. metadata.annotations has `.default({})`, and
 * in output mode that field is exported as *required* — every hand-written
 * entity in a real repository would fail against the schema this stage ships.
 */
function exported(schema: z.ZodType): Record<string, unknown> {
  return {
    ...(z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>),
    $comment: `Enforced by idp-agent and not by this schema: ${UNENFORCED_BY_JSON_SCHEMA.join('; ')}.`,
  }
}

export const entityJsonSchema = (): Record<string, unknown> => exported(entitySchema)
export const planJsonSchema = (): Record<string, unknown> => exported(planSchema)
```

- [ ] **Step 4: Run the tests and commit**

```bash
pnpm vitest run tests/unit/json-schema.test.ts && pnpm typecheck
git add src/core/schemas/json-schema.ts tests/unit/json-schema.test.ts
git commit -m "feat(core): export the entity and plan schemas as JSON Schema"
```

---

### Task 3: The rule engine

The one piece the design names outright: *"the catalogue ignores duplicates silently: CI
must be the one to refuse"* (§4.4). Pure, in `core/`, over a snapshot it does not read.

**Files:**
- Create: `src/core/validate/rules.ts`
- Create: `tests/unit/validate-rules.test.ts`

**Interfaces:**
- Consumes: `Entity`, `resolveEntityPath`, `PathEscapeError`, `refOf`-style references
- Produces:
  - `type Rule = 'duplicate-name' | 'invalid-entity' | 'multiple-entities' | 'missing-witness' | 'misplaced-entity' | 'dangling-reference'`
  - `interface Violation { rule: Rule; file: string; message: string; severity: 'error' | 'warning' }`
  - `interface RepositoryFile { path: string; entities: readonly Entity[]; rejections: readonly string[]; documents: number }`
  - `interface RepositorySnapshot { folders: readonly string[]; witnesses: readonly string[]; files: readonly RepositoryFile[] }`
  - `function checkRepository(snapshot: RepositorySnapshot): Violation[]`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/validate-rules.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { checkRepository } from '../../src/core/validate/rules.js'
import type { RepositorySnapshot } from '../../src/core/validate/rules.js'
import type { Entity } from '../../src/core/schemas/entity.js'

const database = (name: string, extra: Record<string, unknown> = {}): Entity => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Resource',
  metadata: { name, annotations: {} },
  spec: { type: 'database', owner: 'group:default/tiger', ...extra },
})

const snapshot = (over: Partial<RepositorySnapshot> = {}): RepositorySnapshot => ({
  folders: ['catalog/databases'],
  witnesses: ['catalog/databases'],
  files: [],
  ...over,
})

const file = (path: string, entities: Entity[], over = {}) => ({
  path,
  entities,
  rejections: [],
  documents: entities.length,
  ...over,
})

describe('checkRepository', () => {
  it('accepts a repository that conforms', () => {
    expect(
      checkRepository(
        snapshot({ files: [file('catalog/databases/a.yml', [database('a')])] }),
      ),
    ).toEqual([])
  })

  it('refuses two files declaring the same name, and names both', () => {
    // The catalogue ignores duplicates in silence and lets the first source
    // win (design 4.4). Naming one file would leave the reader hunting.
    const violations = checkRepository(
      snapshot({
        files: [
          file('catalog/databases/a.yml', [database('a')]),
          file('catalog/databases/copy.yml', [database('a')]),
        ],
      }),
    )
    expect(violations).toHaveLength(1)
    expect(violations[0]?.rule).toBe('duplicate-name')
    expect(violations[0]?.severity).toBe('error')
    expect(violations[0]?.message).toContain('a.yml')
    expect(violations[0]?.message).toContain('copy.yml')
  })

  it('reports an entity Zod refused, rather than passing over the file', () => {
    const violations = checkRepository(
      snapshot({ files: [file('catalog/databases/x.yml', [], { rejections: ['owner is required'] })] }),
    )
    expect(violations[0]?.rule).toBe('invalid-entity')
    expect(violations[0]?.message).toContain('owner')
  })

  it('refuses two entities in one file', () => {
    // One file per entity: two concurrent declarations must never write the
    // same file (design 4.3).
    const violations = checkRepository(
      snapshot({
        files: [file('catalog/databases/two.yml', [database('a'), database('b')])],
      }),
    )
    expect(violations[0]?.rule).toBe('multiple-entities')
  })

  it('refuses a folder holding entities with no witness', () => {
    const violations = checkRepository(
      snapshot({
        witnesses: [],
        files: [file('catalog/databases/a.yml', [database('a')])],
      }),
    )
    expect(violations[0]?.rule).toBe('missing-witness')
    expect(violations[0]?.file).toBe('catalog/databases')
  })

  it('refuses an entity filed somewhere other than where it belongs', () => {
    const violations = checkRepository(
      snapshot({
        folders: ['catalog/caches'],
        witnesses: ['catalog/caches'],
        files: [file('catalog/caches/a.yml', [database('a')])],
      }),
    )
    expect(violations[0]?.rule).toBe('misplaced-entity')
    expect(violations[0]?.message).toContain('catalog/databases')
  })

  it('warns on a dangling reference rather than erroring', () => {
    // Reported, never pruned (design 4.4) — but a repository mid-migration is
    // not broken, so this must not be what turns CI red.
    const violations = checkRepository(
      snapshot({
        files: [
          file('catalog/databases/a.yml', [database('a', { dependsOn: ['resource:default/gone'] })]),
        ],
      }),
    )
    expect(violations[0]?.rule).toBe('dangling-reference')
    expect(violations[0]?.severity).toBe('warning')
  })

  it('leaves a Component alone, since it has no conventional location', () => {
    // resolveEntityPath throws for a Component — "it lives in its own
    // repository". A naive misplacement rule crashes on the five fixture
    // Components; this is the guard that stops it.
    const component: Entity = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: { name: 'billing-api', annotations: {} },
      spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
    }
    expect(
      checkRepository(snapshot({ files: [file('components/billing-api.yml', [component])] })),
    ).toEqual([])
  })

  it('puts errors before warnings, and orders each by file', () => {
    const violations = checkRepository(
      snapshot({
        files: [
          file('catalog/databases/z.yml', [database('z', { dependsOn: ['resource:default/gone'] })]),
          file('catalog/databases/a.yml', [database('a'), database('b')]),
        ],
      }),
    )
    expect(violations.map((violation) => violation.severity)).toEqual(['error', 'warning'])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/unit/validate-rules.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/core/validate/rules.ts`. Pure: it imports `resolveEntityPath` and the entity
types, and nothing that touches a disk. Rules, in order of severity:

- **`duplicate-name`** (error) — group every entity by `kind:name`; more than one file for
  a key is one violation naming **all** the files, sorted.
- **`invalid-entity`** (error) — one violation per `rejections` entry, anchored on the file.
- **`multiple-entities`** (error) — `entities.length > 1` in one file.
- **`missing-witness`** (error) — a folder appearing in `folders` that holds at least one
  entity file and is absent from `witnesses`. Anchored on the folder, not a file.
- **`misplaced-entity`** (error) — `resolveEntityPath(entity)` differs from the file's path.
  **Wrap it in try/catch**: it throws `PathEscapeError` for a Component, and a Component
  has no conventional location, so a throw here means *no violation*, not a crash.
- **`dangling-reference`** (warning) — a `dependsOn` or `dependencyOf` naming a reference no
  file declares. Warning, not error: a repository mid-migration is not broken, and turning
  CI red on it would make people delete the declaration, which §4.4 forbids.

Sort errors first, then warnings; within a severity, by `file`.

- [ ] **Step 4: Run the tests and commit**

```bash
pnpm vitest run tests/unit/validate-rules.test.ts && pnpm typecheck
git add src/core/validate tests/unit/validate-rules.test.ts
git commit -m "feat(core): refuse what the catalogue would accept"
```

---

### Task 4: Read a repository into a snapshot

**Files:**
- Create: `src/context/iac-fs/snapshot.ts`
- Create: `tests/unit/iac-fs.test.ts`

**Interfaces:**
- Consumes: `entitySchema`, `RepositorySnapshot` and `RepositoryFile` from `core/validate/rules.ts`
- Produces: `function readRepository(root: string): Promise<RepositorySnapshot>`

Why not `FixtureProvider`: it returns entities and rejections with no file provenance, and
every rule here is anchored on a path. This is also the seam stage 4's `IacFsProvider`
grows from — §3 puts `iac-fs` at stage 4, and this is its first half.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/iac-fs.test.ts`:

```typescript
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readRepository } from '../../src/context/iac-fs/snapshot.js'
import { checkRepository } from '../../src/core/validate/rules.js'

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const GOLDEN = path.resolve(import.meta.dirname, '../golden')

describe('readRepository', () => {
  it('sees a witness in every folder that has one', async () => {
    // readdir, never a glob: a dotfile is a file, and the whole witness rule
    // rests on being able to see it.
    const snapshot = await readRepository(FIXTURES)
    expect(snapshot.witnesses).toContain('catalog/databases')
    expect(snapshot.witnesses).toContain('dependencies/gateway')
  })

  it('keeps the path of every file it parsed', async () => {
    const snapshot = await readRepository(FIXTURES)
    expect(snapshot.files.map((file) => file.path)).toContain(
      'catalog/databases/billing-db-prod.yml',
    )
  })

  it('counts the documents in a file, not only the entities', async () => {
    const snapshot = await readRepository(path.join(GOLDEN, 'multi-doc'))
    expect(snapshot.files[0]?.documents).toBe(2)
    expect(snapshot.files[0]?.entities).toHaveLength(2)
  })

  it('reports what Zod refused instead of dropping it', async () => {
    const snapshot = await readRepository(path.join(GOLDEN, 'broken-si'))
    const invalid = snapshot.files.find((file) => file.path.endsWith('invalid.yml'))
    expect(invalid?.rejections).toHaveLength(1)
  })

  it('finds the fixture SI clean, which is the only proof the rules are usable', async () => {
    // If the repository the project ships as exemplary does not pass its own
    // validator, either the rules or the fixtures are wrong.
    const violations = checkRepository(await readRepository(FIXTURES))
    expect(violations.filter((violation) => violation.severity === 'error')).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/unit/iac-fs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/context/iac-fs/snapshot.ts`. Walk with `readdir(dir, { withFileTypes: true })`
— never a glob, since the witness files are dotfiles and the rule depends on seeing them.
For every `.yml` / `.yaml` that is not `.witness.yml`, `parseAllDocuments`, count the
documents, `safeParse` each non-null one, collect entities and rejection messages. Record
every directory in `folders`, and those containing `.witness.yml` in `witnesses`. All
paths repository-relative with POSIX separators, sorted.

- [ ] **Step 4: Run the tests and commit**

```bash
pnpm vitest run tests/unit/iac-fs.test.ts && pnpm typecheck
git add src/context/iac-fs tests/unit/iac-fs.test.ts
git commit -m "feat(context): read an IaC repository, keeping where each entity came from"
```

---

### Task 5: The `validate` command

**Files:**
- Create: `src/cli/commands/validate.ts`
- Modify: `src/cli/index.ts`, `src/cli/commands/result.ts`
- Create: `tests/unit/validate-command.test.ts`
- Modify: `tests/unit/main.test.ts`, `AGENTS.md`, `README.md`, `src/cli/README.md`

**Interfaces:**
- Produces: `function runValidate(root: string, read?: typeof readRepository): Promise<CommandResult>`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/validate-command.test.ts`, driving `main(['validate', dir])` against:
the fixture SI (exit 0, prints the entity and file counts); a `mkdtemp` holding two files
that declare the same entity (exit 1, both paths in the output); a directory whose only
fault is a dangling reference (**exit 0**, the warning printed — *reported* is not *red*);
a directory that does not exist (exit 2). Build the temp directories with `mkdtemp` and
`writeFile`; no fixture is added for a case that exists to be malformed.

- [ ] **Step 2: Run it to verify it fails**

Expected: FAIL — `validate` parses as an unknown command.

- [ ] **Step 3: Implement**

`runValidate` reads, checks, and renders one line per violation:
`<severity> <file>: <message>`, errors first. `found` is true when no **error** survives.
In `src/cli/index.ts`, add `{ name: 'validate'; directory: string }` to the union and
dispatch it **before** the unconditional `FixtureProvider` load — `validate` reads the
directory it was given, not the fixture SI.

Widen the docstring of `found` in `result.ts` and the exit-code paragraph in `AGENTS.md`,
`README.md` and `src/cli/README.md`: `1` now also means *the repository does not conform*.

- [ ] **Step 4: Run everything and commit**

```bash
pnpm test && pnpm typecheck && pnpm build
git add src/cli tests/unit AGENTS.md README.md
git commit -m "feat(cli): add the validate command CI will call"
```

---

### Task 6: The templates, the layout, and the rules that guard the new layer

**Files:**
- Create: `templates/iac-repo/{witness.yml,README.md,gitignore,github/workflows/validate.yml}`
- Create: `src/scaffold/{templates.ts,layout.ts,codeowners.ts,README.md}`
- Create: `tests/unit/scaffold-layout.test.ts`
- Modify: `tests/architecture/dependencies.test.ts`

**Interfaces:**
- Consumes: `RESOURCE_TYPES`, `folderOf`, `entityJsonSchema`, `planJsonSchema`
- Produces:
  - `interface ScaffoldFile { path: string; content: string }`
  - `interface ScaffoldOptions { owner: string; version: string }`
  - `function scaffoldLayout(options: ScaffoldOptions, templates: ReadonlyMap<string, string>): ScaffoldFile[]`
  - `function loadTemplates(dir?: string): Promise<ReadonlyMap<string, string>>`
  - `function isForgeHandle(raw: string): boolean` · `function renderCodeowners(handle: string): string`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/scaffold-layout.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { scaffoldLayout } from '../../src/scaffold/layout.js'
import { loadTemplates } from '../../src/scaffold/templates.js'
import { isForgeHandle, renderCodeowners } from '../../src/scaffold/codeowners.js'
import { RESOURCE_TYPE_NAMES, folderOf } from '../../src/core/schemas/resource-types.js'

const layout = async () =>
  scaffoldLayout({ owner: '@acme/platform', version: '0.1.0-rc.1' }, await loadTemplates())

describe('scaffoldLayout', () => {
  it('gives every folder the registry declares a witness, not the five the design listed', async () => {
    const paths = (await layout()).map((file) => file.path)
    for (const type of RESOURCE_TYPE_NAMES) {
      expect(paths).toContain(`${folderOf(type)}/.witness.yml`)
    }
    expect(paths.filter((path) => path.endsWith('.witness.yml'))).toHaveLength(6)
  })

  it('writes the same witness body the fixture SI uses', async () => {
    // Not reinvented: the sentence explaining why the file exists is the
    // point of the file.
    const witness = (await layout()).find((file) => file.path.endsWith('.witness.yml'))
    expect(witness?.content).toContain('Declares nothing')
  })

  it('embeds the schemas rather than a link to them', async () => {
    const schema = (await layout()).find((file) => file.path === 'schemas/entity.schema.json')
    expect(JSON.parse(schema?.content ?? '{}')).toHaveProperty('$comment')
  })

  it('pins the version the generated workflow will run', async () => {
    const workflow = (await layout()).find((file) => file.path.endsWith('validate.yml'))
    expect(workflow?.content).toContain('idp-agent@0.1.0-rc.1')
  })

  it('writes no components folder, since a Component lives in its own repository', async () => {
    expect((await layout()).map((file) => file.path).join()).not.toContain('components/')
  })

  it('produces paths that are relative and never traverse', async () => {
    for (const file of await layout()) {
      expect(file.path.startsWith('/')).toBe(false)
      expect(file.path).not.toContain('..')
    }
  })
})

describe('codeowners', () => {
  it('accepts a forge handle', () => {
    expect(isForgeHandle('@acme/platform')).toBe(true)
    expect(isForgeHandle('@pcaboor')).toBe(true)
  })

  it('refuses an entity owner reference, which is a different thing', () => {
    // CODEOWNERS wants @org/team; an entity wants group:default/team. One flag
    // cannot be both, and translating between them would be inference.
    expect(isForgeHandle('group:default/tiger')).toBe(false)
    expect(isForgeHandle('platform')).toBe(false)
    expect(isForgeHandle('@')).toBe(false)
  })

  it('assigns every path, because a comment-only CODEOWNERS requires no reviewer at all', () => {
    const rendered = renderCodeowners('@acme/platform')
    expect(rendered).toMatch(/^\*\s+@acme\/platform$/m)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/unit/scaffold-layout.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the templates**

`templates/iac-repo/witness.yml` — byte-identical to the fixture's.

`templates/iac-repo/github/workflows/validate.yml`:

```yaml
name: validate

on:
  push:
    branches: [main]
  pull_request:

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      # The catalogue accepts a duplicate in silence and lets the first source
      # win. This is what refuses it.
      - run: npx --yes idp-agent@__VERSION__ validate .
```

`templates/iac-repo/README.md` — the doctrine in the repository that embodies it: one file
per entity, one folder per nature, witness files and why, the merge as the act of
authorisation, and **the two things this build cannot do** (verify branch protection, and
write a per-application `catalog-info.yml`). First line: `git init`, because the tool does
not.

`templates/iac-repo/gitignore` — stored dotless; npm renames a packaged `.gitignore` to
`.npmignore`, and the mapping happens on write.

- [ ] **Step 4: Implement the three modules**

`templates.ts` resolves `TEMPLATE_ROOT` off `import.meta.url`, the way `DEFAULT_ROOT` does
in `cli/index.ts`, and reads the files into a map keyed by template name.

`layout.ts` is pure: it takes the options and the template map and returns the twelve
files. The folder list comes from `RESOURCE_TYPE_NAMES.map(folderOf)` deduplicated — never
a literal. The workflow's `__VERSION__` is the one interpolation.

`codeowners.ts`: `isForgeHandle` is `/^@[A-Za-z0-9-]+(\/[A-Za-z0-9._-]+)?$/`, and
`renderCodeowners` emits `* <handle>` under a comment saying why the file must never
become comment-only — GitHub then requires *no* reviewer, which silently removes the
review ADR-0006 rests on.

`scaffold/README.md`: why the writer sits outside `core/`, and why exactly one file in this
folder touches `node:fs`.

- [ ] **Step 5: Add the architecture rules**

`AGENTS.md` says to add a rule when you add a layer. Three, in
`tests/architecture/dependencies.test.ts`:

```typescript
it('scaffold/ imports core/ and nothing else of ours', async () => {
  const offending = (await importsUnder(path.join(SOURCE_ROOT, 'scaffold'))).filter(
    ({ specifier }) => /(^|\/)(agents|llm|context|cli)\//.test(specifier),
  )
  expect(offending).toEqual([])
})

it('only src/scaffold/write.ts touches the disk', async () => {
  // Stage 5's atomic applier replaces that seam. One file is a refactor;
  // five would be a rewrite.
  const offending = (await importsUnder(path.join(SOURCE_ROOT, 'scaffold'))).filter(
    ({ file, specifier }) => DISK.test(specifier) && file !== 'scaffold/write.ts',
  )
  expect(offending).toEqual([])
})

it('core/ neither reads nor writes', async () => {
  // core/README.md has said so since stage 2 and nothing checked it.
  const offending = (await importsUnder(path.join(SOURCE_ROOT, 'core'))).filter(
    ({ specifier }) => DISK.test(specifier),
  )
  expect(offending).toEqual([])
})
```

Verify the second bites: temporarily import `node:fs` in `layout.ts`, watch it fail, remove it.

- [ ] **Step 6: Run the tests and commit**

```bash
pnpm test && pnpm typecheck
git add templates src/scaffold tests
git commit -m "feat(scaffold): derive the repository layout from the resource-type registry"
```

---

### Task 7: Write it, and refuse what this stage cannot do

**Files:**
- Create: `src/scaffold/write.ts`, `src/cli/commands/init.ts`
- Modify: `src/cli/index.ts`
- Create: `tests/unit/scaffold-write.test.ts`, `tests/unit/init-command.test.ts`

**Interfaces:**
- Produces:
  - `interface FileIO { mkdir(dir: string): Promise<void>; writeNew(file: string, content: string): Promise<boolean> }`
  - `interface WriteReport { written: readonly string[]; kept: readonly string[] }`
  - `function writeScaffold(root: string, files: readonly ScaffoldFile[], io?: FileIO): Promise<WriteReport>`
  - `function runInitPlatform(options: { root: string; owner: string; version: string }, io?: FileIO): Promise<CommandResult>`
  - `function runInit(): CommandResult`

- [ ] **Step 1: Write the failing test**

`tests/unit/scaffold-write.test.ts` — against a `mkdtemp` directory:

- writes the twelve files, and the report lists twelve written and none kept;
- **a second run writes nothing, reports twelve kept, and exits 0.** *Absent means already
  done* (§4.3) — re-running must not raise;
- **a hand-edited `CODEOWNERS` survives byte for byte.** This is the one that matters: a
  scaffolder that clobbers is a scaffolder nobody runs twice;
- a write that fails reports only what was genuinely written — with an injected `FileIO`,
  so the suite never needs a read-only filesystem;
- every path written stays inside the root, checked with `assertInsideRepo`.

`tests/unit/init-command.test.ts`:

- **the round trip**: scaffold into a temp directory, then `readRepository` +
  `checkRepository` → zero violations, **and** `FixtureProvider(dir).load()` → zero
  entities and zero rejections. Two independent oracles, because a scaffold that its own
  validator rejects is the one failure this stage cannot ship;
- `--owner` missing → exit 2, the message naming the flag and an example;
- an owner that is an `ownerRef` → exit 2;
- an absolute or traversing directory → exit 2, via `assertInsideRepo`;
- the branch-protection block is printed on **both** the first run and the no-op re-run;
- `idp-agent init` → exit 3, the message naming stage 4 and `propose()`.

- [ ] **Step 2: Run them to verify they fail**

Expected: FAIL — modules not found, and `init` parses as an unknown command.

- [ ] **Step 3: Implement**

`write.ts` is the only module under `scaffold/` importing `node:fs`. `writeNew` uses
`flag: 'wx'` — it never clobbers and never deletes, and returns `false` when the file is
already there. `FileIO` is injected so a failing write is testable.

`init.ts` wires `loadTemplates` → `scaffoldLayout` → `writeScaffold`, renders
`wrote N · kept M` with the file list and the protection block, and returns a
`CommandResult`. `runInit` returns `{ text: '', found: false, unsupported: true }` with its
message on stderr — a tested refusal, not a stub.

In `cli/index.ts`: `init platform <dir> --owner <handle>` and the bare `init`, both parsed
with `parseArgs({ strict: true })`, the directory through `assertInsideRepo(cwd, …)`.
Dispatch before the `FixtureProvider` load.

- [ ] **Step 4: Run everything and commit**

```bash
pnpm test && pnpm typecheck && pnpm build
git add src tests
git commit -m "feat(cli): scaffold an IaC repository, and never clobber what is already there"
```

---

### Task 8: Ship it — packaging, smoke, and the first publish

The one thing that can catch "green tests, broken package". The generated workflow runs
`npx idp-agent@<version>`, so the package must carry `templates/` and must exist.

**Files:**
- Modify: `package.json`, `scripts/smoke.mjs`
- Modify: `AGENTS.md`, `README.md`, `docs/plans/stage-3-init-platform.md`

**Interfaces:**
- Consumes: everything above
- Produces: no new symbol — a published package, `idp-agent@0.1.0-rc.1` under the `next`
  tag, and a `pnpm smoke` that finally checks the tarball its own header claims it checks

- [ ] **Step 1: Write the failing check**

In `scripts/smoke.mjs`, add three checks against the built binary in a temp directory:

```javascript
check({ args: ['init'], code: 3, stderr: /stage 4/ })
check({ args: ['init', 'platform', 'repo'], code: 2, stderr: /--owner/ })
```

and a packaging assertion — `npm pack --dry-run --json` must list `templates/iac-repo/`
and the mapped `gitignore`. The existing header comment claims the script guards packaging
and it never has: it runs against the repository's own `dist/`.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm build && pnpm smoke`
Expected: FAIL — `templates/` is absent from the tarball, `files` lists only
`dist, fixtures, LICENSE, NOTICE`.

- [ ] **Step 3: Fix the packaging**

Add `templates` to `package.json#files`. Re-run: the tarball carries the templates.

- [ ] **Step 4: Scaffold from the packed tarball**

```bash
npm pack
cd "$(mktemp -d)" && npm install /path/to/idp-agent-0.1.0-rc.1.tgz
npx idp-agent init platform repo --owner @acme/platform
npx idp-agent validate repo
```
Expected: twelve files written, then `0 violations`. This is the only test of the real
thing: a scaffold produced by an installed package, validated by an installed package.

- [ ] **Step 5: Publish `0.1.0-rc.1`**

Requires `npm login` — the account is not authenticated today. Bump the version, then:

```bash
npm publish --access public --tag next
```

Published under the `next` tag, not `latest`: this is a release candidate shipped ahead of
the stage-7 schedule so that a scaffolded repository's CI works on its first run, and
nothing else about it claims to be finished.

- [ ] **Step 6: Verify the generated CI can actually run**

```bash
cd "$(mktemp -d)" && npx --yes idp-agent@0.1.0-rc.1 validate .
```
Expected: it runs. It will report violations on an empty directory — that is the correct
answer, and it proves the workflow the scaffold writes is not fiction.

- [ ] **Step 7: Update the counts and commit**

`AGENTS.md` and `README.md`: the test count, the new commands, the smoke count, the stage
table to 3/7.

```bash
git add package.json scripts AGENTS.md README.md docs
git commit -m "chore: ship the templates in the package, and publish 0.1.0-rc.1"
```

---

## Done when

- `idp-agent init platform repo --owner @acme/platform` writes twelve files, prints the
  branch-protection block, and exits 0
- Running it again writes nothing, keeps twelve, and leaves a hand-edited `CODEOWNERS`
  byte for byte
- `idp-agent validate repo` reports `0 violations` on what the scaffold just produced
- `idp-agent validate fixtures/si-demo` reports zero errors — the exemplary repository
  passes its own validator
- Two files declaring the same entity name exit 1 and name both files
- A dangling reference is reported and exits 0 — reported is not red
- `idp-agent init` exits 3, naming the stage it waits for
- The published tarball carries `templates/`, and `npx idp-agent@0.1.0-rc.1 validate .`
  runs on a machine that never cloned this repository
- `pnpm test` still needs no API key, no network and no Docker

Stage 4 brings the Inspector and the Architect, and with them the per-application `init`
this stage refuses. It also owes a guarantee: ADR-0007's witness check is a read-side
guarantee, and `propose()` does not inherit it.
