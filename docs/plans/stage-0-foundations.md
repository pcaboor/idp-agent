# Stage 0 — Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the deterministic core of `idp-agent` — entity schemas, the Plan
type, entity path computation, a deterministic YAML serialiser and textual surgery —
with the property-based invariants that make the trust boundary verifiable.

**Architecture:** Everything in this stage lives under `src/core/` and has no AI, no
network and no CLI. It is a pure library: data in, data out. Later stages consume it;
it never consumes them. The invariants written here are what later stages are checked
against, so they are written now rather than retrofitted.

**Tech Stack:** TypeScript 7, Node 22+, pnpm, Vitest 5, Zod 4, fast-check 4, `yaml` 2.

## Global Constraints

Copied verbatim from `docs/design.md`. Every task inherits these.

- **English throughout** — code, comments, commit messages, test names, output.
- **Licence Apache-2.0.** Every source file starts with no licence header; the
  `LICENSE` file at the root covers the repository.
- **`core/` never imports `agents/` or `llm/`.** Enforced by an architecture test.
- **`agents/` never imports `fs`, `child_process` or a git client.** Same test.
- **One file per entity**, in one folder per nature (§ 4.3).
- **Textual surgery, never a reparse.** A file is never rebuilt from a parsed tree.
  Only whole documents are inserted or removed, line by line (§ 4.3).
- **A blank line between YAML documents** (§ 4.3).
- **Absent means already done.** Removing a document that is not there returns the
  file unchanged; it never throws (§ 4.3).
- **Declare, never infer.** Any field the system cannot determine is
  `{ unknown: string }`, and a Plan carrying one cannot be applied (§ 5.4).
- **An entity's location is read from the entity**, in its `idp-agent.dev/source-file`
  annotation, and only computed by convention when that annotation is absent (§ 5.2).
- Conventional Commits for every commit message.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/core/schemas/entity.ts` | Backstage entity shapes: refs, metadata, Component, Resource |
| `src/core/schemas/plan.ts` | `Unknown`, `Operation`, `Plan`, applicability check |
| `src/core/paths/entity-path.ts` | folder conventions, path computation and resolution, containment check |
| `src/core/yaml/serialize.ts` | one entity to a YAML document, deterministic key order |
| `src/core/yaml/surgery.ts` | insert and remove whole documents in a file, line-wise |
| `src/core/index.ts` | the public surface of the core library |
| `tests/unit/*.test.ts` | example-based tests, one file per module |
| `tests/invariants/*.test.ts` | property-based invariants (fast-check) |
| `tests/architecture/dependencies.test.ts` | import rules |

Split by responsibility: schemas describe shapes, paths decide *where*, yaml decides
*how it is written*. None of the three imports another except through types.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `LICENSE`
- Create: `tests/unit/scaffold.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `pnpm test`, `pnpm typecheck`, `pnpm build` available to every later task

- [ ] **Step 1: Write the failing test**

Create `tests/unit/scaffold.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { VERSION } from '../../src/core/index.js'

describe('scaffold', () => {
  it('exposes the core version', () => {
    expect(VERSION).toBe('0.1.0')
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm vitest run tests/unit/scaffold.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/index.js'`

- [ ] **Step 3: Create the project files**

`package.json`:

```json
{
  "name": "idp-agent",
  "version": "0.1.0",
  "description": "Turn a natural-language intent into reviewed infrastructure declarations",
  "license": "Apache-2.0",
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "build": "tsc"
  },
  "dependencies": {
    "yaml": "^2.9.0",
    "zod": "^4.6.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "fast-check": "^4.9.0",
    "typescript": "^7.0.2",
    "vitest": "^5.0.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src/**/*.ts"]
}
```

`vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
```

`src/core/index.ts`:

```typescript
export const VERSION = '0.1.0'
```

`LICENSE`: the full Apache-2.0 text, fetched verbatim from
<https://www.apache.org/licenses/LICENSE-2.0.txt>, with the copyright line set to
`Copyright 2026 Pierre Caboor`.

- [ ] **Step 4: Install and run the test**

Run: `pnpm install && pnpm test`
Expected: PASS — 1 test.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts LICENSE src tests pnpm-lock.yaml
git commit -m "chore: scaffold the project with vitest and typescript"
```

---

### Task 2: Entity schemas

**Files:**
- Create: `src/core/schemas/entity.ts`
- Create: `tests/unit/entity.test.ts`
- Modify: `src/core/index.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `entityRefSchema: z.ZodString` — matches `kind:namespace/name`
  - `ownerRefSchema: z.ZodString` — matches `group:…` or `user:…`
  - `RESOURCE_TYPES: readonly ['database','cache','api','database-access','network-access','gateway-route']`
  - `type ResourceType = (typeof RESOURCE_TYPES)[number]`
  - `componentSchema`, `resourceSchema`, `entitySchema` (discriminated on `kind`)
  - `type Component`, `type Resource`, `type Entity`
  - `SOURCE_FILE_ANNOTATION = 'idp-agent.dev/source-file'`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/entity.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { entitySchema, resourceSchema } from '../../src/core/schemas/entity.js'

describe('entity schemas', () => {
  it('accepts a well-formed Resource', () => {
    const parsed = resourceSchema.parse({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: { name: 'billing-db-dev' },
      spec: { type: 'database', owner: 'group:default/tiger' },
    })
    expect(parsed.metadata.annotations).toEqual({})
  })

  it('rejects an owner without a group or user prefix', () => {
    const result = resourceSchema.safeParse({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: { name: 'billing-db-dev' },
      spec: { type: 'database', owner: 'tiger' },
    })
    expect(result.success).toBe(false)
  })

  it('rejects a name that is not a valid Backstage name', () => {
    const result = resourceSchema.safeParse({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: { name: 'Billing DB' },
      spec: { type: 'database', owner: 'group:default/tiger' },
    })
    expect(result.success).toBe(false)
  })

  it('discriminates Component from Resource', () => {
    const parsed = entitySchema.parse({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: { name: 'billing-api' },
      spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
    })
    expect(parsed.kind).toBe('Component')
  })

  it('rejects an unknown resource type', () => {
    const result = resourceSchema.safeParse({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: { name: 'x' },
      spec: { type: 'quantum-blob', owner: 'group:default/tiger' },
    })
    expect(result.success).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm vitest run tests/unit/entity.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/core/schemas/entity.ts`:

```typescript
import { z } from 'zod'

/** Annotation carrying an entity's own file location. Read it; never re-derive it. */
export const SOURCE_FILE_ANNOTATION = 'idp-agent.dev/source-file'

/** Backstage names: up to 63 chars, alphanumerics plus - _ ., not at the edges. */
const NAME_PATTERN = /^[a-z0-9]([a-z0-9._-]{0,61}[a-z0-9])?$/

/** `kind:namespace/name`, e.g. `resource:default/billing-db-dev`. */
export const entityRefSchema = z
  .string()
  .regex(/^[a-z]+:[a-z0-9-]+\/[a-z0-9._-]+$/, 'expected kind:namespace/name')

/** Ownership is always a group or a user, never a bare string. */
export const ownerRefSchema = z
  .string()
  .regex(/^(group|user):[a-z0-9-]+\/[a-z0-9._-]+$/, 'expected group:… or user:…')

export const RESOURCE_TYPES = [
  'database',
  'cache',
  'api',
  'database-access',
  'network-access',
  'gateway-route',
] as const

export type ResourceType = (typeof RESOURCE_TYPES)[number]

export const metadataSchema = z.object({
  name: z.string().regex(NAME_PATTERN, 'invalid Backstage name'),
  description: z.string().optional(),
  annotations: z.record(z.string(), z.string()).default({}),
  tags: z.array(z.string()).optional(),
})

const baseFields = {
  apiVersion: z.literal('backstage.io/v1alpha1'),
  metadata: metadataSchema,
}

export const componentSchema = z.object({
  ...baseFields,
  kind: z.literal('Component'),
  spec: z.object({
    type: z.string().min(1),
    lifecycle: z.enum(['experimental', 'production', 'deprecated']),
    owner: ownerRefSchema,
    dependsOn: z.array(entityRefSchema).optional(),
  }),
})

export const resourceSchema = z.object({
  ...baseFields,
  kind: z.literal('Resource'),
  spec: z.object({
    type: z.enum(RESOURCE_TYPES),
    owner: ownerRefSchema,
    dependsOn: z.array(entityRefSchema).optional(),
    /** An access carries its consumers; a resource does not (design § 4.1). */
    dependencyOf: z.array(entityRefSchema).optional(),
  }),
})

export const entitySchema = z.discriminatedUnion('kind', [componentSchema, resourceSchema])

export type Component = z.infer<typeof componentSchema>
export type Resource = z.infer<typeof resourceSchema>
export type Entity = z.infer<typeof entitySchema>
```

- [ ] **Step 4: Export it and run the tests**

Add to `src/core/index.ts`:

```typescript
export * from './schemas/entity.js'
```

Run: `pnpm test && pnpm typecheck`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/schemas/entity.ts src/core/index.ts tests/unit/entity.test.ts
git commit -m "feat(core): add Backstage entity schemas"
```

---

### Task 3: Plan and Operation schemas

**Files:**
- Create: `src/core/schemas/plan.ts`
- Create: `tests/unit/plan.test.ts`
- Modify: `src/core/index.ts`

**Interfaces:**
- Consumes: `entitySchema`, `entityRefSchema` from Task 2
- Produces:
  - `unknownSchema`, `type UnknownValue = { unknown: string }`
  - `operationSchema` — discriminated union on `op`
  - `planSchema`, `type Plan`, `type Operation`
  - `findUnknowns(value: unknown): string[]` — dotted paths of every unknown found
  - `isApplicable(plan: Plan): boolean`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/plan.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { findUnknowns, isApplicable, operationSchema, planSchema } from '../../src/core/schemas/plan.js'

const resource = {
  apiVersion: 'backstage.io/v1alpha1' as const,
  kind: 'Resource' as const,
  metadata: { name: 'billing-api-billing-db-dev', annotations: {} },
  spec: { type: 'database-access' as const, owner: 'group:default/tiger' },
}

describe('plan schemas', () => {
  it('accepts a create-entity operation', () => {
    const op = operationSchema.parse({ op: 'create-entity', entity: resource })
    expect(op.op).toBe('create-entity')
  })

  it('rejects an operation that is not modelled', () => {
    const result = operationSchema.safeParse({ op: 'delete-database', name: 'billing' })
    expect(result.success).toBe(false)
  })

  it('finds no unknown in a fully determined plan', () => {
    const plan = planSchema.parse({
      intent: 'give billing-api read access to billing-db-dev',
      operations: [{ op: 'create-entity', entity: resource }],
    })
    expect(findUnknowns(plan)).toEqual([])
    expect(isApplicable(plan)).toBe(true)
  })

  it('reports the path of every unknown and refuses to apply', () => {
    const plan = planSchema.parse({
      intent: 'connect to the billing database',
      operations: [
        {
          op: 'create-entity',
          entity: {
            ...resource,
            spec: { ...resource.spec, owner: { unknown: 'no CODEOWNERS entry found' } },
          },
        },
      ],
    })
    expect(findUnknowns(plan)).toEqual(['operations.0.entity.spec.owner'])
    expect(isApplicable(plan)).toBe(false)
  })

  it('treats an empty plan as applicable — absent means already done', () => {
    const plan = planSchema.parse({ intent: 'already declared', operations: [] })
    expect(isApplicable(plan)).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm vitest run tests/unit/plan.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/core/schemas/plan.ts`:

```typescript
import { z } from 'zod'
import { componentSchema, entityRefSchema } from './entity.js'

/**
 * An explicitly undetermined value. Design § 4.1: declare, never infer.
 * The reason is mandatory — it is what the CLI shows the user when it asks.
 */
export const unknownSchema = z.object({ unknown: z.string().min(1) })
export type UnknownValue = z.infer<typeof unknownSchema>

/**
 * The closed set of things an agent may ask for. Anything outside it is
 * rejected at the boundary, before its content is even inspected.
 */
export const operationSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create-entity'),
    /**
     * Deliberately not narrowed to `entitySchema`: a proposal may legitimately
     * carry `{ unknown }` in place of a field. Strict entity validation happens
     * once unknowns are resolved, in Stage 5.
     */
    entity: z.record(z.string(), z.unknown()),
  }),
  z.object({
    op: z.literal('update-entity'),
    entityRef: entityRefSchema,
    patch: z.record(z.string(), z.unknown()),
  }),
  z.object({
    op: z.literal('create-catalog-info'),
    repoPath: z.string().min(1),
    entity: componentSchema,
  }),
])

export type Operation = z.infer<typeof operationSchema>

export const planSchema = z.object({
  intent: z.string().min(1),
  operations: z.array(operationSchema),
})

export type Plan = z.infer<typeof planSchema>

const isUnknownValue = (value: unknown): value is UnknownValue =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  'unknown' in value &&
  typeof (value as { unknown: unknown }).unknown === 'string'

/** Dotted paths of every explicitly undetermined field, in traversal order. */
export function findUnknowns(value: unknown, path = ''): string[] {
  if (isUnknownValue(value)) return [path]
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findUnknowns(item, path ? `${path}.${index}` : `${index}`))
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, item]) =>
      findUnknowns(item, path ? `${path}.${key}` : key),
    )
  }
  return []
}

/** A plan holding any unknown cannot be applied; the CLI asks the user instead. */
export function isApplicable(plan: Plan): boolean {
  return findUnknowns(plan).length === 0
}
```

- [ ] **Step 4: Export it and run the tests**

Add to `src/core/index.ts`:

```typescript
export * from './schemas/plan.js'
```

Run: `pnpm test && pnpm typecheck`
Expected: PASS — 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/schemas/plan.ts src/core/index.ts tests/unit/plan.test.ts
git commit -m "feat(core): add Plan, Operation and explicit unknown handling"
```

---

### Task 4: Entity path computation

**Files:**
- Create: `src/core/paths/entity-path.ts`
- Create: `tests/unit/entity-path.test.ts`
- Modify: `src/core/index.ts`

**Interfaces:**
- Consumes: `ResourceType`, `SOURCE_FILE_ANNOTATION`, `Entity` from Task 2
- Produces:
  - `FOLDER_BY_TYPE: Record<ResourceType, string>`
  - `computeEntityPath(type: ResourceType, name: string): string`
  - `resolveEntityPath(entity: Entity): string`
  - `assertInsideRepo(repoRoot: string, candidate: string): string` — throws `PathEscapeError`
  - `class PathEscapeError extends Error`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/entity-path.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import {
  PathEscapeError,
  assertInsideRepo,
  computeEntityPath,
  resolveEntityPath,
} from '../../src/core/paths/entity-path.js'
import { SOURCE_FILE_ANNOTATION } from '../../src/core/schemas/entity.js'

const resource = (annotations: Record<string, string>) => ({
  apiVersion: 'backstage.io/v1alpha1' as const,
  kind: 'Resource' as const,
  metadata: { name: 'billing-db-dev', annotations },
  spec: { type: 'database' as const, owner: 'group:default/tiger' },
})

describe('entity paths', () => {
  it('computes one file per entity, in one folder per nature', () => {
    expect(computeEntityPath('database', 'billing-db-dev')).toBe('catalog/databases/billing-db-dev.yml')
    expect(computeEntityPath('database-access', 'a-b')).toBe('dependencies/access/a-b.yml')
    expect(computeEntityPath('network-access', 'a-b')).toBe('dependencies/network/a-b.yml')
  })

  it('reads the location from the entity when the annotation is present', () => {
    const entity = resource({ [SOURCE_FILE_ANNOTATION]: 'legacy/all-databases.yml' })
    expect(resolveEntityPath(entity)).toBe('legacy/all-databases.yml')
  })

  it('falls back to the convention when the annotation is absent', () => {
    expect(resolveEntityPath(resource({}))).toBe('catalog/databases/billing-db-dev.yml')
  })

  it('accepts a path inside the repository', () => {
    expect(assertInsideRepo('/repo', 'catalog/databases/x.yml')).toBe('/repo/catalog/databases/x.yml')
  })

  it('refuses a traversal escape', () => {
    expect(() => assertInsideRepo('/repo', '../../etc/passwd')).toThrow(PathEscapeError)
  })

  it('refuses an absolute path', () => {
    expect(() => assertInsideRepo('/repo', '/etc/passwd')).toThrow(PathEscapeError)
  })

  it('refuses a sibling directory sharing the prefix', () => {
    expect(() => assertInsideRepo('/repo', '../repo-evil/x.yml')).toThrow(PathEscapeError)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm vitest run tests/unit/entity-path.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/core/paths/entity-path.ts`:

```typescript
import path from 'node:path'
import { SOURCE_FILE_ANNOTATION, type Entity, type ResourceType } from '../schemas/entity.js'

/** One folder per nature, so two concurrent declarations never share a file. */
export const FOLDER_BY_TYPE: Record<ResourceType, string> = {
  database: 'catalog/databases',
  cache: 'catalog/caches',
  api: 'catalog/apis',
  'database-access': 'dependencies/access',
  'network-access': 'dependencies/network',
  'gateway-route': 'dependencies/gateway',
}

export class PathEscapeError extends Error {
  constructor(candidate: string) {
    super(`path escapes the repository: ${candidate}`)
    this.name = 'PathEscapeError'
  }
}

/** Convention for a new entity. The model never chooses this. */
export function computeEntityPath(type: ResourceType, name: string): string {
  return `${FOLDER_BY_TYPE[type]}/${name}.yml`
}

/**
 * Where an entity actually lives. Read from the entity when it says so; only
 * derived from its type when it does not (design § 5.2). If someone filed an
 * entity elsewhere, the change goes where it is, not where convention wants it.
 */
export function resolveEntityPath(entity: Entity): string {
  const declared = entity.metadata.annotations?.[SOURCE_FILE_ANNOTATION]
  if (declared !== undefined && declared !== '') return declared
  if (entity.kind === 'Component') {
    throw new Error('a Component has no conventional location; it lives in its own repository')
  }
  return computeEntityPath(entity.spec.type, entity.metadata.name)
}

/**
 * Resolve `candidate` against `repoRoot` and refuse anything that lands outside.
 * Compares against `repoRoot + sep` so `/repo-evil` is not accepted for `/repo`.
 */
export function assertInsideRepo(repoRoot: string, candidate: string): string {
  const root = path.resolve(repoRoot)
  const resolved = path.resolve(root, candidate)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new PathEscapeError(candidate)
  }
  return resolved
}
```

- [ ] **Step 4: Export it and run the tests**

Add to `src/core/index.ts`:

```typescript
export * from './paths/entity-path.js'
```

Run: `pnpm test && pnpm typecheck`
Expected: PASS — 18 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/paths/entity-path.ts src/core/index.ts tests/unit/entity-path.test.ts
git commit -m "feat(core): compute and resolve entity file paths"
```

---

### Task 5: Deterministic YAML serialiser

**Files:**
- Create: `src/core/yaml/serialize.ts`
- Create: `tests/unit/serialize.test.ts`
- Modify: `src/core/index.ts`

**Interfaces:**
- Consumes: `Entity` from Task 2
- Produces:
  - `serializeEntity(entity: Entity): string` — one YAML document, no leading `---`,
    always ending in a single newline
  - `parseEntity(document: string): Entity` — for round-trip tests only

- [ ] **Step 1: Write the failing test**

Create `tests/unit/serialize.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { parseEntity, serializeEntity } from '../../src/core/yaml/serialize.js'
import type { Entity } from '../../src/core/schemas/entity.js'

const entity: Entity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Resource',
  metadata: { name: 'billing-api-billing-db-dev', annotations: { 'company.fr/env': 'dev' } },
  spec: {
    type: 'database-access',
    owner: 'group:default/tiger',
    dependsOn: ['resource:default/billing-db-dev'],
  },
}

describe('serializeEntity', () => {
  it('emits keys in a fixed order', () => {
    const lines = serializeEntity(entity).split('\n')
    expect(lines[0]).toBe('apiVersion: backstage.io/v1alpha1')
    expect(lines[1]).toBe('kind: Resource')
    expect(lines[2]).toBe('metadata:')
  })

  it('ends in exactly one newline and never starts with a document marker', () => {
    const output = serializeEntity(entity)
    expect(output.endsWith('\n')).toBe(true)
    expect(output.endsWith('\n\n')).toBe(false)
    expect(output.startsWith('---')).toBe(false)
  })

  it('is stable across calls', () => {
    expect(serializeEntity(entity)).toBe(serializeEntity(entity))
  })

  it('omits an empty annotations map rather than writing an empty mapping', () => {
    const bare = { ...entity, metadata: { name: 'x', annotations: {} } }
    expect(serializeEntity(bare as Entity)).not.toContain('annotations')
  })

  it('quotes a value that YAML would otherwise misread', () => {
    const risky = { ...entity, metadata: { name: 'x', annotations: { k: '*star' } } }
    expect(serializeEntity(risky as Entity)).toContain("'*star'")
  })

  it('round-trips through the parser', () => {
    expect(parseEntity(serializeEntity(entity))).toEqual(entity)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm vitest run tests/unit/serialize.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/core/yaml/serialize.ts`:

```typescript
import { parse, stringify } from 'yaml'
import { entitySchema, type Entity } from '../schemas/entity.js'

/**
 * The model never emits YAML; it emits a structure and this is the only place
 * that turns one into text. A single serialiser means one format across the
 * repository, whichever model produced the content.
 */
const STRINGIFY_OPTIONS = {
  indent: 2,
  lineWidth: 0,
  singleQuote: true,
  sortMapEntries: false,
} as const

/** Object key insertion order is the document order; both are fixed here. */
function ordered(entity: Entity): Record<string, unknown> {
  const metadata: Record<string, unknown> = { name: entity.metadata.name }
  if (entity.metadata.description !== undefined) metadata.description = entity.metadata.description
  if (Object.keys(entity.metadata.annotations).length > 0) {
    metadata.annotations = entity.metadata.annotations
  }
  if (entity.metadata.tags !== undefined) metadata.tags = entity.metadata.tags

  const spec: Record<string, unknown> = { type: entity.spec.type }
  if (entity.kind === 'Component') spec.lifecycle = entity.spec.lifecycle
  spec.owner = entity.spec.owner
  if (entity.spec.dependsOn !== undefined) spec.dependsOn = entity.spec.dependsOn
  if (entity.kind === 'Resource' && entity.spec.dependencyOf !== undefined) {
    spec.dependencyOf = entity.spec.dependencyOf
  }

  return { apiVersion: entity.apiVersion, kind: entity.kind, metadata, spec }
}

/** One entity, one document. No leading `---`: that belongs to the surgery layer. */
export function serializeEntity(entity: Entity): string {
  const text = stringify(ordered(entity), STRINGIFY_OPTIONS)
  return text.endsWith('\n') ? text : `${text}\n`
}

/** Used by round-trip tests and by readers of an existing repository. */
export function parseEntity(document: string): Entity {
  return entitySchema.parse(parse(document))
}
```

- [ ] **Step 4: Export it and run the tests**

Add to `src/core/index.ts`:

```typescript
export * from './yaml/serialize.js'
```

Run: `pnpm test && pnpm typecheck`
Expected: PASS — 24 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/yaml/serialize.ts src/core/index.ts tests/unit/serialize.test.ts
git commit -m "feat(core): serialise one entity to a deterministic YAML document"
```

---

### Task 6: Textual surgery

**Files:**
- Create: `src/core/yaml/surgery.ts`
- Create: `tests/unit/surgery.test.ts`
- Modify: `src/core/index.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `insertDocument(fileContent: string, documentText: string): string`
  - `removeDocument(fileContent: string, entityName: string): string`
  - `listDocumentNames(fileContent: string): string[]`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/surgery.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { insertDocument, listDocumentNames, removeDocument } from '../../src/core/yaml/surgery.js'

const docA = 'apiVersion: backstage.io/v1alpha1\nkind: Resource\nmetadata:\n  name: alpha\n'
const docB = 'apiVersion: backstage.io/v1alpha1\nkind: Resource\nmetadata:\n  name: beta\n'

describe('insertDocument', () => {
  it('writes a document marker into an empty file', () => {
    expect(insertDocument('', docA)).toBe(`---\n${docA}`)
  })

  it('separates documents with exactly one blank line', () => {
    const file = insertDocument(insertDocument('', docA), docB)
    expect(file).toBe(`---\n${docA}\n---\n${docB}`)
  })

  it('leaves existing lines byte-for-byte untouched, comments included', () => {
    const withComment = `# written by hand, do not reformat\n---\n${docA}`
    expect(insertDocument(withComment, docB)).toContain('# written by hand, do not reformat\n')
  })
})

describe('removeDocument', () => {
  it('returns the file unchanged when the document is not there', () => {
    const file = `---\n${docA}`
    expect(removeDocument(file, 'ghost')).toBe(file)
  })

  it('removes a document and the blank line that preceded it', () => {
    const original = `---\n${docA}`
    const grown = insertDocument(original, docB)
    expect(removeDocument(grown, 'beta')).toBe(original)
  })

  it('removes the first document without leaving a leading blank line', () => {
    const grown = insertDocument(`---\n${docA}`, docB)
    expect(removeDocument(grown, 'alpha')).toBe(`---\n${docB}`)
  })

  it('empties a file that held a single document', () => {
    expect(removeDocument(`---\n${docA}`, 'alpha')).toBe('')
  })

  it('is idempotent — absent means already done', () => {
    const once = removeDocument(`---\n${docA}`, 'alpha')
    expect(removeDocument(once, 'alpha')).toBe(once)
  })
})

describe('listDocumentNames', () => {
  it('lists names in document order', () => {
    const file = insertDocument(insertDocument('', docA), docB)
    expect(listDocumentNames(file)).toEqual(['alpha', 'beta'])
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm vitest run tests/unit/surgery.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/core/yaml/surgery.ts`:

```typescript
/**
 * Whole-document insertion and removal, line by line. A file is never rebuilt
 * from a parsed tree: rewriting YAML from an AST reformats everything, loses
 * comments and reorders keys, and a reviewer must see an added line
 * (design § 4.3).
 */

const NEWLINE = '\n'
const MARKER = '---'

interface Block {
  /** index of the `---` line */
  start: number
  /** index of the last content line, blank separators excluded */
  end: number
}

function splitLines(content: string): { lines: string[]; trailing: boolean } {
  const trailing = content.endsWith(NEWLINE)
  const body = trailing ? content.slice(0, -1) : content
  return { lines: body === '' ? [] : body.split(NEWLINE), trailing }
}

function joinLines(lines: string[], trailing: boolean): string {
  if (lines.length === 0) return ''
  return lines.join(NEWLINE) + (trailing ? NEWLINE : '')
}

function findBlocks(lines: string[]): Block[] {
  const starts: number[] = []
  lines.forEach((line, index) => {
    if (line.trimEnd() === MARKER) starts.push(index)
  })
  return starts.map((start, i) => {
    let end = i + 1 < starts.length ? (starts[i + 1] as number) - 1 : lines.length - 1
    while (end > start && (lines[end] as string).trim() === '') end -= 1
    return { start, end }
  })
}

/** The `name:` under `metadata:`, i.e. indented by exactly two spaces. */
function blockName(lines: string[], block: Block): string | undefined {
  for (let i = block.start; i <= block.end; i += 1) {
    const match = /^ {2}name:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(lines[i] as string)
    if (match) return match[1]
  }
  return undefined
}

/** Append a document, preceded by a blank line when the file is not empty. */
export function insertDocument(fileContent: string, documentText: string): string {
  const body = documentText.endsWith(NEWLINE) ? documentText.slice(0, -1) : documentText
  const documentLines = [MARKER, ...body.split(NEWLINE)]
  const { lines } = splitLines(fileContent)
  if (lines.length === 0) return joinLines(documentLines, true)
  return joinLines([...lines, '', ...documentLines], true)
}

/** Remove the document declaring `entityName`. Absent means already done. */
export function removeDocument(fileContent: string, entityName: string): string {
  const { lines, trailing } = splitLines(fileContent)
  const blocks = findBlocks(lines)
  const target = blocks.find((block) => blockName(lines, block) === entityName)
  if (!target) return fileContent

  let from = target.start
  if (from > 0 && (lines[from - 1] as string).trim() === '') from -= 1

  const kept = [...lines.slice(0, from), ...lines.slice(target.end + 1)]
  return joinLines(kept, trailing)
}

export function listDocumentNames(fileContent: string): string[] {
  const { lines } = splitLines(fileContent)
  return findBlocks(lines)
    .map((block) => blockName(lines, block))
    .filter((name): name is string => name !== undefined)
}
```

- [ ] **Step 4: Export it and run the tests**

Add to `src/core/index.ts`:

```typescript
export * from './yaml/surgery.js'
```

Run: `pnpm test && pnpm typecheck`
Expected: PASS — 33 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/yaml/surgery.ts src/core/index.ts tests/unit/surgery.test.ts
git commit -m "feat(core): insert and remove YAML documents by textual surgery"
```

---

### Task 7: Property-based invariants

**Files:**
- Create: `tests/invariants/arbitraries.ts`
- Create: `tests/invariants/core.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2 to 6
- Produces: `arbitraryEntity`, `arbitraryFile` — reused by later stages

Three of the five invariants in design § 9.2 are reachable at this stage. The two
that depend on plan application (atomicity, apply-twice) arrive in Stage 5.

- [ ] **Step 1: Write the arbitraries**

Create `tests/invariants/arbitraries.ts`:

```typescript
import fc from 'fast-check'
import { RESOURCE_TYPES, type Entity } from '../../src/core/schemas/entity.js'
import { insertDocument } from '../../src/core/yaml/surgery.js'
import { serializeEntity } from '../../src/core/yaml/serialize.js'

const name = fc
  .stringMatching(/^[a-z0-9]([a-z0-9-]{0,20}[a-z0-9])?$/)
  .filter((value) => value.length > 0)

const owner = name.map((group) => `group:default/${group}`)

export const arbitraryEntity: fc.Arbitrary<Entity> = fc.record({
  apiVersion: fc.constant('backstage.io/v1alpha1' as const),
  kind: fc.constant('Resource' as const),
  metadata: fc.record({
    name,
    annotations: fc.dictionary(fc.constantFrom('company.fr/env', 'team'), name, {
      maxKeys: 2,
    }),
  }),
  spec: fc.record({
    type: fc.constantFrom(...RESOURCE_TYPES),
    owner,
  }),
})

/** Files built the way the tool builds them: normalised, one document per entity. */
export const arbitraryFile = fc
  .uniqueArray(arbitraryEntity, { minLength: 1, maxLength: 4, selector: (e) => e.metadata.name })
  .map((entities) =>
    entities.reduce((file, entity) => insertDocument(file, serializeEntity(entity)), ''),
  )
```

- [ ] **Step 2: Write the failing invariants**

Create `tests/invariants/core.test.ts`:

```typescript
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { arbitraryEntity, arbitraryFile } from './arbitraries.js'
import { parseEntity, serializeEntity } from '../../src/core/yaml/serialize.js'
import { insertDocument, removeDocument } from '../../src/core/yaml/surgery.js'
import { assertInsideRepo, resolveEntityPath } from '../../src/core/paths/entity-path.js'

describe('invariants', () => {
  it('serialise then reload yields the same entity', () => {
    fc.assert(
      fc.property(arbitraryEntity, (entity) => {
        expect(parseEntity(serializeEntity(entity))).toEqual(entity)
      }),
    )
  })

  it('insert then remove yields the file byte for byte', () => {
    fc.assert(
      fc.property(arbitraryFile, arbitraryEntity, (file, entity) => {
        fc.pre(!file.includes(`name: ${entity.metadata.name}\n`))
        const grown = insertDocument(file, serializeEntity(entity))
        expect(removeDocument(grown, entity.metadata.name)).toBe(file)
      }),
    )
  })

  it('every computed path stays inside the repository', () => {
    fc.assert(
      fc.property(arbitraryEntity, (entity) => {
        const resolved = assertInsideRepo('/repo', resolveEntityPath(entity))
        expect(resolved.startsWith('/repo/')).toBe(true)
      }),
    )
  })
})
```

- [ ] **Step 3: Run them**

Run: `pnpm vitest run tests/invariants/core.test.ts`
Expected: PASS — 3 properties, 100 runs each. If the second fails, the counter-example
printed by fast-check is the file to fix in `surgery.ts`, not the test to relax.

- [ ] **Step 4: Prove the fourth invariant bites**

Temporarily replace the body of `insertDocument` with a parse-and-restringify
implementation, run the suite, and confirm the byte-for-byte property fails. Then
revert. This is a manual check that the invariant is not vacuous — do not commit the
broken version.

- [ ] **Step 5: Commit**

```bash
git add tests/invariants
git commit -m "test(core): add property-based invariants for paths, serialisation and surgery"
```

---

### Task 8: Architecture test and CI

**Files:**
- Create: `tests/architecture/dependencies.test.ts`
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the source tree
- Produces: the rule enforcement every later stage relies on

- [ ] **Step 1: Write the failing test**

Create `tests/architecture/dependencies.test.ts`:

```typescript
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../../src')

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return sourceFiles(full)
      return entry.name.endsWith('.ts') ? [full] : []
    }),
  )
  return files.flat()
}

async function importsOf(dir: string): Promise<Array<{ file: string; specifier: string }>> {
  const files = await sourceFiles(dir)
  const found: Array<{ file: string; specifier: string }> = []
  for (const file of files) {
    const content = await readFile(file, 'utf8')
    for (const match of content.matchAll(/^\s*(?:import|export)[^'"]*['"]([^'"]+)['"]/gm)) {
      found.push({ file, specifier: match[1] as string })
    }
  }
  return found
}

describe('architecture', () => {
  it('core/ does not import agents/ or llm/', async () => {
    const offending = (await importsOf(path.join(ROOT, 'core'))).filter(({ specifier }) =>
      /(^|\/)(agents|llm)\//.test(specifier),
    )
    expect(offending).toEqual([])
  })

  it('agents/ does not import fs, git or child_process', async () => {
    const forbidden = /^(node:)?(fs|fs\/promises|child_process)$|^simple-git$|^isomorphic-git$/
    const offending = (await importsOf(path.join(ROOT, 'agents'))).filter(({ specifier }) =>
      forbidden.test(specifier),
    )
    expect(offending).toEqual([])
  })
})
```

- [ ] **Step 2: Run it**

Run: `pnpm vitest run tests/architecture/dependencies.test.ts`
Expected: PASS — `src/agents` does not exist yet, so the second test passes vacuously.
That is intended: the rule is in place before the code it governs.

- [ ] **Step 3: Prove the rule bites**

```bash
mkdir -p src/agents && printf "import fs from 'node:fs'\nexport const x = fs\n" > src/agents/probe.ts
pnpm vitest run tests/architecture/dependencies.test.ts
```

Expected: FAIL, naming `src/agents/probe.ts`. Then:

```bash
rm -rf src/agents
```

- [ ] **Step 4: Add CI**

Create `.github/workflows/ci.yml`:

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      # No API key is needed: the suite never reaches a model.
      - run: pnpm test
```

- [ ] **Step 5: Run everything and commit**

Run: `pnpm typecheck && pnpm test`
Expected: PASS — 35 tests and 3 properties.

```bash
git add tests/architecture .github/workflows/ci.yml
git commit -m "test: enforce import boundaries and run them in CI"
```

---

## Done when

- `pnpm test` passes with no API key, no network and no Docker
- `pnpm typecheck` is clean under `strict` plus `noUncheckedIndexedAccess`
- The byte-for-byte invariant has been observed to fail against a reparse
  implementation, and to pass against the shipped one
- The architecture test has been observed to fail against a probe importing `fs`
- `src/core/index.ts` exports schemas, plan, paths, serialise and surgery

Stage 1 (read-only commands over fixtures) consumes exactly these exports.
