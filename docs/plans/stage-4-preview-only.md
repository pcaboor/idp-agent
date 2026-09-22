# Stage 4 — Preview Only Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Tick them as you go.**

**Goal:** Turn an intent into a `Plan`, refuse the parts of it nobody can vouch for, and
render the diff it would produce — writing nothing.

**Architecture:** Two merges inside one stage. **4a** builds the signed Plan with no model
at all: `propose()` fills a typed buffer, `signPlan` classifies every leaf by where it came
from, deterministic policies run, the repository is re-checked, and a unified diff is
rendered. **4b** adds the three agents that produce a Plan — Inspector, Architect,
Reviewer — behind a bounded repair loop.

**Tech Stack:** TypeScript 7, Node 22+, Vitest 5, Zod 4, `yaml` 2, Vercel AI SDK.

## Global Constraints

Inherited and still binding — `docs/design.md` §4, `AGENTS.md`.

- **Writes nothing.** Not one byte reaches the repository this stage. A test hashes the
  directory before and after a full preview.
- **`pnpm test` needs no API key, no network and no Docker.** 4a is entirely
  deterministic; 4b replays recordings.
- **`agents/` reaches neither disk nor network, transitively.** The Inspector "reads the
  local repository" and must therefore read nothing itself — the reading lives in
  `context/`, and the facts are handed to it.
- **`core/` imports neither `agents/`, `llm/`, `context/`, `cli/`, the SDK, the network
  nor `fs`.** `core/plan/` and `core/diff/` are pure; the bytes are handed in.
- **Declare, never infer.** A value nobody can vouch for becomes `{ unknown }`, and a Plan
  holding one cannot be applied.
- **The engine chooses the path.** The model emits a structure, never a path, never a line
  of YAML.
- **Textual surgery, never a reparse.** A reviewer sees an added line.
- **The catalogue lags the repository.** Check the repository before proposing, and again
  before rendering.
- **Absent means already done.** A plan whose target was declared meanwhile renders an
  empty diff and exits 0.
- English throughout. Conventional Commits. No `switch` on a closed union without
  `const _exhaustive: never = value`.

---

## The guarantee this stage owes

ADR-0007 closed with a debt: *the witness check is a read-side guarantee and does not
transfer to `propose()`*. This section pays it.

### Why the read-side shape cannot be reused

`answerQuestion` is safe because an `Answer` carries **nothing but identifiers**, so one
set-membership test covers all of its content. A `Plan` carries **values that were never in
the catalogue** — that is what proposing means. Membership has nothing to test against.

### What is actually broken today, measured

Run against the shipped `planSchema`, all four pass:

| Probe | Verdict |
|---|---|
| an entity carrying `backdoor: true` | **passes** — the field is silently dropped later |
| `owner: group:default/ghost-team`, a team that exists nowhere | **passes** |
| `metadata.annotations['idp-agent.dev/source-file'] = '../../etc/x.yml'` | **passes** |
| a `database-access` with no environment at all | **passes** |

The third is the serious one. §5.2 promises *the engine chooses the file path, the model
cannot aim at it* — and `resolveEntityPath` reads exactly that annotation to decide where a
file goes. A model writing it **aims at the path**. The central guarantee of §5.2 is
bypassable in the code as shipped.

### The signature

Every **leaf** of a proposed entity is classified by where its value came from:

| Class | Meaning |
|---|---|
| `echoed` | it appears in the user's own request, verbatim |
| `enumerated` | it is in the SI vocabulary — a known type, environment or owner |
| `derived` | the engine computed it, and the model never saw it |
| `novel` | none of the above |

**A `novel` leaf becomes `{ unknown }`.** The Plan is then not applicable, `findUnknowns`
lists it by dotted path, and the CLI prints the question. Nothing is refused outright and
nothing is invented: the tool asks.

Three properties, each a test:

1. **Total over leaves.** Every terminal value is classified — a traversal in the shape of
   `findUnknowns`, so no field escapes by being nested. Property-based, over `arbitraryPlan`.
2. **An injected leaf is caught.** Take a signed Plan, replace any leaf with a value from
   nowhere, and the signature refuses it, naming its dotted path.
3. **Every path is engine-computed.** No path the model emitted survives, because the
   proposal schema has no field to carry one.

And what it does **not** cover, stated as plainly as ADR-0007 stated its own limit:

> The signature says where a value came from. It says **nothing about whether the value is
> right.** An owner that exists and is the wrong team is `enumerated` and passes. This is
> why the diff is shown to a human, and why the merge — not the signature — is the act of
> authorisation.

### Three decisions that make it enforceable

**The proposal schemas are strict; `entitySchema` stays permissive.** Two schemas, one
direction each. `entitySchema` *reads* a real Backstage repository whose files legitimately
carry fields this tool does not model — making it strict would break `readRepository` on any
real catalogue. A *proposal* carrying an unmodelled field is either an invention or a silent
drop, and both are unacceptable.

**No `annotations` map in a proposal.** The environment is a named field; every other
annotation the engine computes. A reserved-prefix key has nowhere to go, so the
path-aiming attack above stops being possible at the type level rather than being caught.

**`SignedPlan` is a branded type only `signPlan` can mint.** Everything downstream — the
edits, the diff, stage 5's applier — takes a `SignedPlan`, never a `Plan`. *The engine
signs* becomes a compile error instead of a slogan.

---

## Scope, and the contradictions this plan resolves

**Stage 4 ships in two merges.** 4a is the signed Plan, the policies, the re-check and the
diff — no model anywhere. 4b is the Inspector, the Architect, the Reviewer and the repair
loop that produce one.

The order is not cosmetic. The debt ADR-0007 names is a property of **the engine**, not of
the Architect: `signPlan` is the thing under test, and testing it against a deterministic
Plan is testing the guarantee. Testing it against a model's output would be illustrating it.

### The contradictions

**1. §11 says "writes nothing"; §7.4 ends on "branch + MR".** The daily gesture has eight
steps and the eighth opens a merge request, which needs a `ForgeProvider` — stage 5-6.

→ Stage 4 stops at step 7: diff and confirmation. Every run that produced a diff ends on
§7.4's own closing line, *"Nothing is provisioned yet. The merge is what authorises it."*
§7.4 is amended to mark step 8 as arriving with the forge.

**2. "Policies" is named four times and defined nowhere.** §5.1, §6.1, §7.4 and ADR-0001
all place it as the second gate of the repair loop. No section says what one is. The only
trace of substance is `governance/ cyber · archi · infra rules` in the §10 layout and a
`get_governance_rule` tool in §6.

→ A Policy is defined here as **a deterministic predicate over a signed Plan**, no model
and no disk. Three ship: `environment-mismatch`, `unwitnessed-folder`,
`cross-environment-consumer`. §6.1 gains the definition. `governance/` and
`get_governance_rule` stay out of v0.1 — a configurable rule engine is a stage of its own,
and three hard-coded predicates are worth more than an empty extension point.

**3. The shipped `operationSchema` does not match §5.3.** The design shows
`create-entity` carrying `kind: EntityKind`; the code carries `entity: z.record(...)`,
which accepts anything. That permissiveness is the first probe in the table above.

→ The operation union is rewritten against the strict proposal schemas. §5.3 is amended to
the shape that ships.

**4. `ENV_ANNOTATION` lives in `context/`, and `core/` needs it.** The signer must know
which annotation carries an environment, and `core/` may not import `context/`.

→ It moves to `core/schemas/vocabulary.ts` with the `Vocabulary` type; `context/` re-exports
so nothing else changes. Done in task 1, while nothing depends on it yet.

### Answered before planning

- **The empty repository.** Right after `init platform` the vocabulary is empty, so every
  leaf would be `novel` and the first run all questions. `.idp-agent.yml` already declares
  `environments: [dev, staging, prod]` in §7.0 — **it is read when present**, with
  `--owner-ref` and `--env` as fallbacks, and when neither exists the questions are printed
  and the run exits 3. An empty vocabulary means *ask*, never *anything goes*. §7.0 is
  amended to say the file is read from stage 4, though written at stage 5.
- **The Reviewer blocks.** A rejection stops the plan. This was decided against the
  recommendation, and the plan carries the reason it was contested: the Architect and the
  Reviewer are the same weights behind the same `IDP_PROVIDER`, so their errors are
  correlated by construction, and a rubber-stamp Reviewer is indistinguishable from a
  working one in every green test. **The mitigation is mandatory, not optional**: a test
  asserts the Reviewer receives the Plan and the *original request*, and never the
  Architect's transcript or its previous rejections. A blocking reviewer fed the
  Architect's own reasoning is an echo with a veto.
- **`repair-malformed-owner` uses an input that is genuinely refusable** — an owner outside
  the SI vocabulary, which the signature refuses deterministically and the Architect must
  then repair. The error comes from the rule, not from hoping the model slips. This is the
  only thing in the whole stage that needs an API key, for one recording session.

---

## What the user types

```bash
# 4a
idp-agent plan --from <plan.json> --repo <path> [--json]

# 4b
idp-agent plan "<intent>" --repo <path> [--owner-ref group:default/team] [--env dev]
                          [--answer <dotted.path>=<value>]... [--apply]
idp-agent init --repo <path> [--owner-ref group:default/team]
```

`--from` is a flag rather than a positional, so 4b's intent form is a pure addition. It
survives into 4b as a deterministic entry point for debugging and for stage 5.

`plan` **requires `--repo`**: a write preview is decided against the repository, never
against the catalogue (§4.4, §13).

| Case | Exit |
|---|---|
| Plan signed, diff rendered, nothing written | 0 |
| Already declared → empty diff, names the existing file | 0 |
| Refused by the signature, a policy, the Reviewer or the re-check | 1 |
| No convergence at attempt 3 → partial plan and the reason, nothing written | 1 |
| Bad arguments · no `--repo` · not JSON · not an IaC repository · no model | 2 |
| The plan holds an `{unknown}` → questions printed, `--answer` suggested | 3 |
| Ambiguous name → matches listed with their environments, no default | 3 |
| `--apply` | 3 — *writing arrives at stage 5* |

Still four exit codes. An unknown is *understood, and this build will not act on it* —
that is 3, and `--apply` is why it survives without a fifth. Stage 5 flips one line.

---

## File Structure

### 4a — the signed Plan, no model

| File | Responsibility |
|---|---|
| `src/core/schemas/vocabulary.ts` | `ENV_ANNOTATION`, `Vocabulary` — moved out of `context/` |
| `src/core/schemas/plan.ts` *(edit)* | strict proposal schemas, closed patch union, reserved prefix |
| `src/core/plan/sign.ts` | the four-class signature; the only place a `SignedPlan` is minted |
| `src/core/plan/clarify.ts` | `findUnknowns` → printable questions; `--answer` → back into a Plan |
| `src/core/plan/policies.ts` | three deterministic predicates; no model, no disk |
| `src/core/plan/recheck.ts` | `checkRepository` over the post-application **virtual** snapshot |
| `src/core/plan/edits.ts` | signed Plan + the bytes that exist → the bytes that would exist |
| `src/core/diff/unified.ts` | unified diff rendering; no colour, no terminal |
| `src/core/yaml/surgery.ts` *(edit)* | `appendSequenceItem` — a consumer is an added line |
| `src/context/iac-fs/graph.ts` | `snapshotGraph` — provenance beside the entity |
| `src/cli/commands/plan.ts` | `runPlan`, injected reader on `runValidate`'s pattern |
| `src/core/plan/README.md` | why `core/plan/` exists, and why there is one Plan producer |

### 4b — the agents

| File | Responsibility |
|---|---|
| `src/context/project-fs/snapshot.ts` | `readProject` — **all** application-repository confinement |
| `src/agents/inspector.ts` | `ProjectSnapshot` → `ProjectFacts`; an absent fact is `{unknown}` |
| `src/agents/tools/project-tools.ts` | read-only tools over pre-read project data |
| `src/agents/architect.ts` | the bounded draft loop, on `analyst.ts`'s shape |
| `src/agents/tools/propose-tool.ts` | `propose()` — fills the typed buffer, builds the signature context |
| `src/agents/reviewer.ts` | `reviewPlan` + `verdictSchema`; **blocking**, fed the original request |
| `src/agents/repair.ts` | five gates, three attempts, a structured report back |
| `src/cli/config.ts` | the flags, and `.idp-agent.yml` when present |

Reused rather than rewritten: `findUnknowns` / `isApplicable` / `PLAN_LIMITS`,
`resolveEntityPath` / `computeEntityPath` / `assertInsideRepo`, `serializeEntity`,
`insertDocument` / `removeDocument`, `checkRepository` / `readRepository`, `EntityGraph`,
`scripted()` from `analyst.test.ts`, the recording harness, `EXIT` / `CommandResult`.

---

# Merge 4a — the signed Plan

### Task 1: Move the vocabulary into `core/`, and forbid the import that made it necessary

**Files:**
- Create: `src/core/schemas/vocabulary.ts`
- Modify: `src/context/graph/summary.ts`, `src/context/graph/entity-graph.ts` (re-export)
- Modify: `tests/architecture/dependencies.test.ts`

**Interfaces:**
- Produces: `ENV_ANNOTATION`, `interface Vocabulary { kinds; types; environments; owners }`

The signer needs to know which annotation carries an environment. It lives in `context/`,
and `core/` may not import `context/` — except nothing enforces that today.

- [x] **Step 1: Write the failing test**

```typescript
it('core/ imports nothing from context/, cli/ or scaffold/', async () => {
  // core/ is the deterministic half. A dependency on a layer that reads a disk
  // would make it one by proxy, and the folder's own README says it is not.
  const offending = (await importsUnder(path.join(SOURCE_ROOT, 'core'))).filter(
    ({ specifier }) => /(^|\/)(context|cli|scaffold)\//.test(specifier),
  )
  expect(offending).toEqual([])
})
```

- [x] **Step 2: Prove the rule bites**

Add a throwaway `import { ENV_ANNOTATION } from '../../context/graph/entity-graph.js'` to
any file under `src/core/`. Run the architecture tests, watch the rule name it, delete it.
A rule that has never failed has not been tested.

- [x] **Step 3: Move the symbols**

Create `src/core/schemas/vocabulary.ts` holding `ENV_ANNOTATION` and the `Vocabulary`
interface. Have `context/graph/entity-graph.ts` and `context/graph/summary.ts` re-export
them, so no other file changes and the 306 existing tests stay green.

- [x] **Step 4: Run everything and commit**

```bash
pnpm test && pnpm typecheck
git add src/core/schemas/vocabulary.ts src/context tests/architecture
git commit -m "refactor(core): move the environment annotation where the engine can reach it"
```

---

### Task 2: Strict proposal schemas — close the four holes

**Files:**
- Modify: `src/core/schemas/plan.ts`
- Create: `tests/unit/proposal-schema.test.ts`

**Interfaces:**
- Produces: `proposedResourceSchema`, `proposedComponentSchema`, `patchSchema`,
  `RESERVED_ANNOTATION_PREFIX`, and a rewritten `operationSchema`

- [x] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from 'vitest'
import { planSchema } from '../../src/core/schemas/plan.js'

const plan = (entity: unknown) => ({
  intent: 'give billing-api access to orders-db in prod',
  operations: [{ op: 'create-entity', entity }],
})

const sound = {
  kind: 'Resource',
  metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
  spec: { type: 'database-access', owner: 'group:default/tiger' },
}

describe('a proposal is stricter than an entity read from disk', () => {
  it('accepts a well-formed proposal', () => {
    expect(planSchema.safeParse(plan(sound)).success).toBe(true)
  })

  it('refuses a field it does not model, instead of dropping it later', () => {
    // Today this passes and `ordered()` drops the field in silence at
    // serialisation. A proposal carrying an unmodelled field is either an
    // invention or a silent drop, and both are unacceptable.
    const result = planSchema.safeParse(plan({ ...sound, backdoor: true }))
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('backdoor')
  })

  it('has nowhere to carry an annotation, so the model cannot aim at a path', () => {
    // §5.2 promises the engine chooses the path. resolveEntityPath reads
    // idp-agent.dev/source-file to decide where a file goes, so a model that
    // writes that annotation aims at the path. There is no annotations map.
    const aiming = {
      ...sound,
      metadata: {
        ...sound.metadata,
        annotations: { 'idp-agent.dev/source-file': '../../etc/passwd.yml' },
      },
    }
    expect(planSchema.safeParse(plan(aiming)).success).toBe(false)
  })

  it('requires an environment, because it is part of an access identity', () => {
    const { env, ...withoutEnv } = sound.metadata
    expect(planSchema.safeParse(plan({ ...sound, metadata: withoutEnv })).success).toBe(false)
  })

  it('lets an unknown stand in for any field the model could not determine', () => {
    const asking = {
      ...sound,
      spec: { ...sound.spec, owner: { unknown: 'which team owns this?' } },
    }
    expect(planSchema.safeParse(plan(asking)).success).toBe(true)
  })

  it('keeps the read schema permissive, since a real catalogue carries more', () => {
    // entitySchema reads a Backstage repository whose files legitimately hold
    // fields this tool does not model. Making it strict would break
    // readRepository on any real catalogue.
    const { entitySchema } = await import('../../src/core/schemas/entity.js')
    expect(
      entitySchema.safeParse({
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Resource',
        metadata: { name: 'x', labels: { team: 'tiger' } },
        spec: { type: 'database', owner: 'group:default/tiger' },
      }).success,
    ).toBe(true)
  })
})
```

- [x] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/unit/proposal-schema.test.ts`
Expected: FAIL on four of the six — the permissive schema accepts everything.

- [x] **Step 3: Implement**

In `src/core/schemas/plan.ts`, add the strict proposal schemas. `z.strictObject`
throughout. No `apiVersion` — derived. **No `annotations` map** — the environment is a
named `metadata.env`, every other annotation is engine-computed, and a reserved-prefix key
has nowhere to land. Wrap each model-chosen field in `z.union([field, unknownSchema])` so
`{ unknown }` remains legal everywhere. Rewrite `operationSchema` over them, with a closed
`patchSchema` for `update-entity`.

Keep `planJsonSchema()` exporting — the stage-3 test must stay green.

- [x] **Step 4: Run the tests and commit**

```bash
pnpm test && pnpm typecheck
git add src/core/schemas/plan.ts tests/unit/proposal-schema.test.ts
git commit -m "feat(core): make a proposal stricter than an entity read from disk"
```

---

### Task 3: The signature

The debt ADR-0007 named. Every leaf classified by where its value came from.

**Files:**
- Create: `src/core/plan/sign.ts`
- Create: `tests/unit/sign.test.ts`
- Modify: `tests/invariants/arbitraries.ts` (add `arbitraryPlan`)
- Modify: `tests/invariants/core.test.ts`

**Interfaces:**
- Produces:
  - `type LeafClass = 'echoed' | 'enumerated' | 'derived' | 'novel'`
  - `interface SignedPlan` — branded; `plan`, `paths`, `refs`, `classified`
  - `interface SignatureContext { witnessed; vocabulary; repoRoot; declared }`
  - `function signPlan(plan: Plan, context: SignatureContext): SignedPlan | PlanRefusal`

- [x] **Step 1: Write the failing test**

`tests/unit/sign.test.ts` asserts, with a hand-built Plan and context:

- a Plan whose every leaf is echoed or enumerated signs, and `paths` holds one
  engine-computed path per operation;
- **an owner outside the vocabulary becomes `{unknown}`**, named by its dotted path —
  `operations.0.entity.spec.owner`, the form `findUnknowns` already produces;
- a name lifted verbatim from the intent is `echoed` and passes;
- a type not in `RESOURCE_TYPE_NAMES` is refused rather than asked about — the union is
  closed, so it is a schema error, not a question;
- **the signed paths come from `computeEntityPath`, and no field of the proposal could
  have influenced them** — asserted by signing two Plans differing only in fields that are
  not name or type, and getting the same path;
- an entity whose reference is already in `declared` signs, and the re-check (task 4)
  decides what that means — the signer does not.

And in `tests/invariants/core.test.ts`, two properties over `arbitraryPlan`:

```typescript
it('every leaf of a signed plan is classified', () => {
  // Total over leaves, not over refs: a Plan carries invented values, so the
  // read-side membership test has nothing to test against.
  fc.assert(
    fc.property(arbitraryPlan, (plan) => {
      const signed = signPlan(plan, context)
      if ('outcome' in signed) return
      expect(leavesOf(signed.plan).length).toBe(signed.classified.length)
    }),
  )
})

it('every path a signature produces stays inside the repository', () => {
  fc.assert(
    fc.property(arbitraryPlan, (plan) => {
      const signed = signPlan(plan, context)
      if ('outcome' in signed) return
      for (const produced of signed.paths.values()) {
        expect(assertInsideRepo('/repo', produced).startsWith('/repo/')).toBe(true)
      }
    }),
  )
})
```

- [x] **Step 2: Run them to verify they fail**

Expected: FAIL — module not found, `arbitraryPlan` undefined.

- [x] **Step 3: Implement**

`signPlan` walks the Plan the way `findUnknowns` does — iteratively, bounded by
`PLAN_LIMITS`, visiting every terminal value. For each leaf:

- **`derived`** if the engine produced it (a path, a reference, `apiVersion`);
- **`echoed`** if the value appears in `plan.intent`, compared case-insensitively on word
  boundaries so `prod` in "in prod" counts and `pro` does not;
- **`enumerated`** if it is in the matching `Vocabulary` list, or in `witnessed`;
- **`novel`** otherwise → the leaf is replaced by `{ unknown: <a question naming the
  field> }` in the returned Plan.

Paths come from `computeEntityPath` for a new entity and from the existing entity's
annotation for an update — read from the entity, never re-derived (§4.3). Both go through
`assertInsideRepo`.

The brand: `declare const signature: unique symbol`, not exported. Only this module can
produce a value of the type.

- [x] **Step 4: Prove the brand holds**

Add to the test file, and check it typechecks as a failure:

```typescript
// @ts-expect-error a bare Plan is not signed, and nothing downstream accepts one
planEdits(plan, new Map())
```

- [x] **Step 5: Run everything and commit**

```bash
pnpm test && pnpm typecheck
git add src/core/plan tests
git commit -m "feat(core): sign a plan by classifying where every value came from"
```

---

### Task 4: Policies, the re-check, and the questions

The second gate of §6.1, finally defined — and the sixth step of §7.4, which exists
because the catalogue lags the repository.

**Files:**
- Create: `src/core/plan/policies.ts`, `src/core/plan/recheck.ts`, `src/core/plan/clarify.ts`
- Create: `tests/unit/policies.test.ts`, `tests/unit/recheck.test.ts`
- Modify: `docs/design.md` §6.1

**Interfaces:**
- Produces:
  - `type PolicyName = 'environment-mismatch' | 'unwitnessed-folder' | 'cross-environment-consumer'`
  - `function checkPolicies(signed: SignedPlan, context: PolicyContext): PolicyViolation[]`
  - `type RecheckOutcome = 'fresh' | 'already-declared' | 'moved' | 'conflict'`
  - `function recheckPlan(signed: SignedPlan, snapshot: RepositorySnapshot): Recheck`
  - `function questionsOf(plan: Plan): Question[]` · `function answer(plan: Plan, path: string, value: string): Plan`

- [ ] **Step 1: Write the failing tests**

`tests/unit/policies.test.ts`:

```typescript
describe('environment-mismatch', () => {
  it('refuses a plan that touches prod when the intent named dev', () => {
    // The design's own example of what Zod cannot catch and a Reviewer was
    // meant to. It is deterministic, so it does not need a model.
    const signed = sign({ intent: 'give billing-api access to orders-db in dev', ... })
    const violations = checkPolicies(signed, context)
    expect(violations[0]?.policy).toBe('environment-mismatch')
  })

  it('says nothing when the intent names no environment', () => {
    // Declare, never infer: silence in the request is not permission, but it
    // is not a violation either — it is an {unknown}, which the signer made.
  })
})

describe('unwitnessed-folder', () => {
  it('refuses writing into a folder with no witness', () => { ... })
})

describe('cross-environment-consumer', () => {
  it('refuses a dev access declaring a prod consumer', () => {
    // Being authorised in dev grants nothing in staging (§4.1). An access
    // whose environment differs from its consumer's is the shape of that bug.
  })
})
```

`tests/unit/recheck.test.ts`:

```typescript
it('reports already-declared when the entity appeared meanwhile', () => {
  // The catalogue lags the repository by about two minutes (§4.4), so what
  // was true when the plan was drafted may not be true now.
  expect(recheckPlan(signed, snapshotHolding(theEntity)).outcome).toBe('already-declared')
})

it('reports moved when the entity exists at a different path', () => { ... })

it('refuses a plan that would introduce a duplicate', () => {
  // Applied virtually, then checkRepository over the result: the same six
  // rules CI runs, asked about a repository that does not exist yet.
  const { violations } = recheckPlan(signed, snapshot)
  expect(violations.some((v) => v.rule === 'duplicate-name')).toBe(true)
})

it('reports fresh when nothing changed', () => { ... })
```

`tests/unit/clarify.test.ts`: `questionsOf` turns each `{unknown}` into a printable
question carrying its dotted path; `answer(plan, 'operations.0.entity.spec.owner', 'group:default/tiger')`
returns a Plan with that leaf filled and the others untouched; an answer aimed at a path
that is not an unknown is refused rather than silently ignored.

- [ ] **Step 2: Run them to verify they fail**

- [ ] **Step 3: Implement**

`policies.ts` is pure: three predicates over a `SignedPlan` and a context, each returning
violations with a message a human can act on. No model, no disk. The list is a constant
array — a configurable rule engine is a stage of its own, and `governance/` stays out of
v0.1.

`recheck.ts` applies the Plan **virtually** — it builds the snapshot that would exist and
runs `checkRepository` over it. That reuses the six rules CI already runs rather than
inventing a second set, which is the whole reason task 3 of stage 3 put them in `core/`.

`clarify.ts` sits on `findUnknowns`, which already returns dotted paths in traversal order.

Amend `docs/design.md` §6.1 with the definition:

> **A Policy is a deterministic predicate over a signed Plan.** No model, no disk. Three
> ship in v0.1: an environment the intent did not name, a folder with no witness, and an
> access whose environment differs from its consumer's. A configurable rule engine —
> `governance/`, and the `get_governance_rule` tool of §6 — is deferred past v0.1: three
> predicates that run are worth more than an extension point that does not.

- [ ] **Step 4: Run everything and commit**

```bash
pnpm test && pnpm typecheck
git add src/core/plan tests docs/design.md
git commit -m "feat(core): define a policy, and re-check the plan against the repository"
```

---

### Task 5: The edits, the diff, and `plan --from`

**Files:**
- Create: `src/core/plan/edits.ts`, `src/core/diff/unified.ts`, `src/cli/commands/plan.ts`,
  `src/cli/render/diff.ts`, `src/core/plan/README.md`
- Modify: `src/core/yaml/surgery.ts` (`appendSequenceItem`), `src/cli/index.ts`
- Create: `tests/unit/edits.test.ts`, `tests/unit/diff.test.ts`, `tests/unit/plan-command.test.ts`

**Interfaces:**
- Produces:
  - `interface FileEdit { path: string; before: string | undefined; after: string }`
  - `function planEdits(signed: SignedPlan, before: ReadonlyMap<string, string>): FileEdit[]`
  - `function renderUnifiedDiff(edits: readonly FileEdit[], options?: { context?: number }): string`
  - `function appendSequenceItem(text: string, entityName: string, field: string, item: string): string`
  - `function runPlan(options): Promise<CommandResult>`

- [ ] **Step 1: Write the failing tests**

The load-bearing one, in `tests/unit/plan-command.test.ts`:

```typescript
it('leaves the repository byte-identical', async () => {
  // "Preview only — writes nothing" is the whole stage. Not a claim: a hash
  // of every file before and after a full preview.
  const root = await scaffoldedRepository()
  const before = await hashTree(root)
  const { code } = await run(['plan', '--from', planFile, '--repo', root])
  expect(code).toBe(0)
  expect(await hashTree(root)).toBe(before)
})
```

and in `tests/unit/edits.test.ts`:

```typescript
it('adds a consumer as an added line, not a rewritten document', () => {
  // Textual surgery, never a reparse (§4.3): a reviewer must see one line
  // added, not a file reformatted. A remove-then-reinsert passes a
  // round-trip test and fails a reviewer.
  const after = appendSequenceItem(existing, 'billing-api-orders-db-prod', 'dependencyOf', 'component:default/billing-api')
  const added = diffLines(existing, after)
  expect(added.removed).toEqual([])
  expect(added.added).toHaveLength(1)
})
```

plus: an insert produces a document separated by a blank line (§4.3); `insert then append
then remove yields the file byte for byte` as a fast-check property beside the existing
surgery invariants; a plan whose target was declared meanwhile renders an **empty** diff
and exits 0; `--json` emits the signed plan and the violations, for a machine.

- [ ] **Step 2: Run them to verify they fail**

- [ ] **Step 3: Implement**

`edits.ts` takes the signed Plan and the bytes that exist, and returns the bytes that
would exist — `serializeEntity` + `insertDocument` for a creation, `appendSequenceItem`
for an update. Pure: `core/` may not read a disk, so the "before" map is handed in.

`unified.ts` renders a standard unified diff. No colour, no terminal, no dependency: a
string, so it is tested without one.

`runPlan` reads the repository, loads the Plan from `--from`, signs, runs the policies,
re-checks, computes the edits, renders. On an `{unknown}`, prints the questions and
returns exit 3. Every run that produced a diff ends on §7.4's closing line.

- [ ] **Step 4: Run everything, then try it by hand**

```bash
pnpm test && pnpm typecheck && pnpm build
idpa init platform /tmp/iac --owner @acme/platform
idpa plan --from examples/add-access.json --repo /tmp/iac
```
Expected: a unified diff, exit 0, and `/tmp/iac` unchanged.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat(cli): render the diff a plan would produce, and write nothing"
```

---

# Merge 4b — the agents that produce a Plan

### Task 6: Read the application repository, confined

The Inspector "reads the local repository" (§6) and `agents/` may reach no disk,
transitively. So the reading lives in `context/`, and the facts are handed over.

**Files:**
- Create: `src/context/project-fs/snapshot.ts`
- Create: `tests/unit/project-fs.test.ts`
- Modify: `tests/architecture/dependencies.test.ts`

**Interfaces:**
- Produces:
  - `const PROJECT_LIMITS = { maxFiles: 200, maxFileBytes: 65_536, maxTotalBytes: 1_048_576 }`
  - `interface ProjectSnapshot { root; files; skipped; truncated }`
  - `function readProject(root: string): Promise<ProjectSnapshot>`

- [ ] **Step 1: Write the failing test**

```typescript
it('never returns a secret, and says what it skipped', async () => {
  // §6: escaping paths refused, .env, .git/ and key files excluded, size
  // capped. "Never ignore in silence" applies to exclusions too — a file
  // dropped without a word is a file the user thinks was read.
  const root = await projectWith({
    '.env': 'MISTRAL_API_KEY=secret',
    'src/index.ts': 'export const x = 1',
    'id_rsa': '-----BEGIN PRIVATE KEY-----',
    'huge.txt': 'x'.repeat(200_000),
  })
  const snapshot = await readProject(root)
  const text = JSON.stringify(snapshot.files)
  expect(text).not.toContain('secret')
  expect(text).not.toContain('PRIVATE KEY')
  expect(snapshot.skipped.map((s) => s.path)).toEqual(
    expect.arrayContaining(['.env', 'id_rsa', 'huge.txt']),
  )
  expect(snapshot.skipped.every((s) => s.reason.length > 0)).toBe(true)
})

it('refuses a symlink pointing outside the project', async () => { ... })
it('stops at the file cap and says it truncated', async () => { ... })
it('reads a manifest', async () => { ... })
```

- [ ] **Step 2: Run it to verify it fails**

- [ ] **Step 3: Implement, and add the architecture rule**

`readProject` walks with `readdir`, applies the exclusion list and the three caps, and
records **every** exclusion with its reason. Add to `tests/architecture`:

```typescript
it('only context/iac-fs and context/project-fs read a user repository', async () => {
  const allowed = new Set(['context/iac-fs/snapshot.ts', 'context/project-fs/snapshot.ts',
                           'context/fixtures/index.ts'])
  const offending = (await importsUnder(path.join(SOURCE_ROOT, 'context')))
    .filter(({ file, specifier }) => DISK.test(specifier) && !allowed.has(file))
  expect(offending).toEqual([])
})
```

- [ ] **Step 4: Run everything and commit**

```bash
git commit -m "feat(context): read an application repository without its secrets"
```

---

### Task 7: The Inspector, the Architect, and `propose()`

**Files:**
- Create: `src/agents/inspector.ts`, `src/agents/architect.ts`,
  `src/agents/tools/project-tools.ts`, `src/agents/tools/propose-tool.ts`
- Create: `tests/unit/inspector.test.ts`, `tests/unit/architect.test.ts`

**Interfaces:**
- Produces:
  - `projectFactsSchema` / `type ProjectFacts` — every field a value or `{unknown}`
  - `function inspect(client, snapshot, emit): Promise<ProjectFacts>`
  - `function buildProjectTools(snapshot)` · `function buildProposeTool()`
  - `function draftPlan(client, tools, input, emit): Promise<Plan>`

- [ ] **Step 1: Write the failing tests**

With `scripted()`, the stub `LlmClient` from `analyst.test.ts`:

- `propose()` fills a typed buffer and returns nothing to the model — the Architect never
  receives a path, a byte, or the buffer's contents;
- an absent fact is `{unknown}`, never omitted and never guessed: a repository with no
  manifest yields `{ name: { unknown: … } }`, not a name derived from the directory;
- **the Architect is never handed a path**: a test asserts no tool it can call returns one,
  and that the propose tool's schema has no path field;
- the bounded loop stops like the Analyst's — four turns, three calls per turn, a forced
  terminal call;
- `ProjectFacts` never carries a forge handle translated into an owner reference —
  `codeowners.ts` already refuses that round trip, and this is the same refusal one layer up.

- [ ] **Step 2: Run them to verify they fail**

- [ ] **Step 3: Implement**

`inspector.ts` is handed a `ProjectSnapshot` and returns `ProjectFacts` — it reads nothing.
`architect.ts` follows `analyst.ts`'s shape: a hand-written bounded loop, tools closing
over pre-read data, a forced terminal `propose`. `propose-tool.ts` validates against the
strict proposal schemas and fills the buffer; it also accumulates the witness set the
signature will use.

- [ ] **Step 4: Run everything and commit**

```bash
git commit -m "feat(agents): inspect a repository and draft a plan into a typed buffer"
```

---

### Task 8: The repair loop, and a Reviewer that is not an echo

**Files:**
- Create: `src/agents/reviewer.ts`, `src/agents/repair.ts`
- Modify: `src/agents/events.ts`
- Create: `tests/unit/reviewer.test.ts`, `tests/unit/repair.test.ts`

**Interfaces:**
- Produces:
  - `verdictSchema` — `{ verdict: 'ok' }` or `{ verdict: 'reject', reason }`
  - `function reviewPlan(client, input, emit): Promise<Verdict>`
  - `const REPAIR_LIMITS = { maxAttempts: 3 }`
  - `type Gate = 'zod' | 'signature' | 'policy' | 'reviewer' | 'recheck'`
  - `function repair(...): Promise<RepairOutcome>`

**The Reviewer blocks.** That was decided deliberately, and it makes the test below
mandatory rather than nice to have.

- [ ] **Step 1: Write the failing tests**

```typescript
it('shows the reviewer the original request, never the architect transcript', async () => {
  // The Architect and the Reviewer are the same weights behind the same
  // provider: their errors are correlated by construction. Feeding it the
  // Architect's own reasoning turns a second opinion into an echo — and this
  // one holds a veto.
  const seen: GenerateRequest[] = []
  const client: LlmClient = { generate: async (r) => { seen.push(r); return ok() } }
  await reviewPlan(client, { plan, intent: 'give billing-api access in dev' }, () => {})
  const sent = JSON.stringify(seen[0]?.transcript)
  expect(sent).toContain('give billing-api access in dev')
  expect(sent).not.toContain('architect')
  expect(sent).not.toContain('attempt')
})

it('stops the plan when the reviewer rejects', async () => {
  // Blocking, by decision. A rejection is not a caveat.
})

it('stops at three attempts, prints the partial plan and its reason, writes nothing', async () => {
  const outcome = await repair(alwaysRejecting, ...)
  expect(outcome.attempts).toBe(REPAIR_LIMITS.maxAttempts)
  expect(outcome.signed).toBeUndefined()
  expect(outcome.plan).toBeDefined()
})

it('hands the architect the signer own dotted paths, not a paraphrase', async () => {
  // The repair report is the refusal: operations.0.entity.spec.owner, the
  // same string a human reads. A model repairing a paraphrase is repairing
  // something else.
})

it('runs the gates in the order the design fixes', async () => {
  expect(gatesSeen).toEqual(['zod', 'signature', 'policy', 'reviewer', 'recheck'])
})
```

- [ ] **Step 2: Run them to verify they fail**

- [ ] **Step 3: Implement**

`repair.ts` is plain TypeScript: five gates in fixed order, three attempts, each failure
producing a structured report handed back to the Architect. Past three: clean stop, the
partial Plan with the reason, nothing written (§6.1, §7.5).

`reviewer.ts` receives the Plan and the **original request**, and nothing else. The
`verdictSchema` mirrors `answerSchema`: refusal is a member of the union, so the model has
a legal way to object without having to invent a defect.

Events: `repair { attempt, gate, reason }`, `plan:ready { plan }`, `clarify { questions }`.

- [ ] **Step 4: Run everything and commit**

```bash
git commit -m "feat(agents): bound the repair loop, and keep the reviewer independent"
```

---

### Task 9: `plan "<intent>"`, `init`, the recordings, the documents

**Files:**
- Modify: `src/cli/index.ts`, `src/cli/commands/plan.ts`, `src/cli/commands/init.ts`
- Create: `src/cli/config.ts`, `src/agents/README.md`, `src/llm/README.md`
- Create: `tests/recordings/link-*.json`, `tests/recordings/repair-malformed-owner.json`
- Create: `tests/scenarios/plan-mode.test.ts`
- Modify: `docs/design.md` §5.3, §7.0, §7.4 · `AGENTS.md` · `README.md` · `scripts/smoke.mjs`

- [ ] **Step 1: Wire the intent form and the config**

`plan "<intent>"` runs Inspector → Architect → repair → diff. `init --repo` finally
answers the refusal stage 3 shipped: Inspector → Architect restricted to
`create-catalog-info`. `config.ts` reads `.idp-agent.yml` when present — §7.0 declares
`environments`, which is what seeds the vocabulary on a fresh repository.

Amend §7.0 to say the file is **read from stage 4**, though written at stage 5.

- [ ] **Step 2: Record the five scenarios**

```bash
IDP_PROVIDER=<yours> IDP_MODEL=<yours> IDP_RECORDING=record pnpm vitest run tests/scenarios
```

`link-db-exists`, `link-db-missing`, `link-ambiguous-env`, `link-already-declared`,
`repair-malformed-owner` — the names §9.3 reserved.

`repair-malformed-owner` uses **an owner outside the SI vocabulary**: the signature refuses
it deterministically, so the Architect has something real to repair. The error comes from
the rule, not from hoping the model slips.

Then verify, as stage 2 did: no secret in any recording, and the whole suite replays with
no key and no network.

- [ ] **Step 3: The owed hygiene test**

```typescript
it('no shipped recording is hand-authored', async () => {
  // Stage 2 introduced the handAuthored flag and never tested it. A
  // fabricated recording passing as a real one would make the whole harness
  // worthless, and nothing would say so.
  for (const file of await recordings()) {
    expect(file.turns.every((turn) => turn.handAuthored !== true)).toBe(true)
  }
})
```

- [ ] **Step 4: Amend the documents**

- §5.3 — the operation union as it ships, over the strict proposal schemas.
- §7.4 — step 8 (branch + MR) arrives with the forge at stage 5-6; stage 4 stops at 7.
- §7.0 — `.idp-agent.yml` is read from stage 4.
- `AGENTS.md` — the stage table, the test count, the new commands, the new architecture
  rules, and the exit-code paragraph.
- `scripts/smoke.mjs` — `plan --from` against the built binary, and replace the hard-coded
  count with `checks.length`, which has been a maintenance trap since stage 3.

- [ ] **Step 5: Run everything and commit**

```bash
pnpm typecheck && pnpm test && pnpm build && pnpm smoke
git commit -m "feat(cli): turn an intent into a reviewed plan, and stop before writing"
```

---

## Done when

- `idp-agent plan --from <plan.json> --repo <dir>` renders a unified diff and exits 0,
  and the directory is **byte-identical** afterwards
- A proposal carrying a field the schema does not model is refused, naming it
- A proposal carrying `idp-agent.dev/source-file` cannot be expressed at all
- An owner outside the SI vocabulary becomes a question, not a value
- Every path in a signed plan came from the engine, proven over generated plans
- A plan that would introduce a duplicate is refused by the re-check, using the same six
  rules CI runs
- An intent naming dev and a plan touching prod is refused by a policy, deterministically
- The Reviewer sees the original request and never the Architect's transcript
- Three failed attempts stop the loop, print the partial plan with its reason, and write
  nothing
- `idp-agent init --repo <dir>` answers the refusal stage 3 shipped
- `pnpm test` still needs no API key, no network and no Docker

Stage 5 turns `--apply` from exit 3 into a local branch, and the `SignedPlan` this stage
mints is what it will apply. The guarantee stops there too: the signature says where a
value came from, never whether it is right. **The merge is what authorises it.**
