# Stage 1 — Read-Only Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship two working commands — `idp-agent graph` and `idp-agent show <entity>` —
over a realistic fictional SI, with no AI, no network and no writes.

**Architecture:** A `ContextProvider` interface with one implementation, `fixtures`,
which reads a directory laid out exactly like a real IaC repository. Entities load
into an `EntityGraph` held in memory, which answers dependency questions. Rendering
returns strings, so it is tested without a terminal.

**Tech Stack:** TypeScript 7, Node 22+ (`node:util.parseArgs`, no CLI dependency),
Vitest 5, Zod 4, `yaml` 2.

## Global Constraints

Inherited from Stage 0 and still binding — see `docs/design.md`.

- **English throughout** — code, comments, commit messages, test names, output.
- **`core/` never imports `agents/` or `llm/`;** `agents/` never imports `fs`,
  `child_process` or a git client. Enforced by `tests/architecture`.
- **`core/` never reaches the network.** `context/` may, later; not in this stage.
- **One file per entity**, in one folder per nature — the fixtures obey this too,
  so `fixtures/si-demo/` is a valid IaC repository, not a test-only shape.
- **Never ignore in silence.** An entity that fails validation is reported, never
  dropped quietly: that silent drop is the catalogue behaviour the tool exists to
  compensate for (design 4.4).
- **Declare, never infer.** A dangling reference is reported as dangling, not
  resolved to something plausible.
- **No `switch` on a closed union without an exhaustiveness check:**
  `const _exhaustive: never = value` in the default branch.
- Conventional Commits.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/context/provider.ts` | the `ContextProvider` interface and `LoadResult` |
| `src/context/fixtures/index.ts` | reads a directory of YAML entities from disk |
| `src/context/graph/entity-graph.ts` | in-memory index and dependency queries |
| `src/cli/render/table.ts` | rows to an aligned table, returns a string |
| `src/cli/render/entity.ts` | one entity to a detail view, returns a string |
| `src/cli/commands/graph.ts` | the `graph` command |
| `src/cli/commands/show.ts` | the `show` command |
| `src/cli/index.ts` | argument parsing and dispatch |
| `fixtures/si-demo/**` | ~30 entities, one file each |

Rendering is separated from commands, and commands from parsing, so each is tested
on its own: rendering takes data and returns a string, commands take a graph and
return a string, parsing takes `argv` and returns a resolved command.

---

### Task 1: ContextProvider and the fixture SI

**Files:**
- Create: `src/context/provider.ts`
- Create: `src/context/fixtures/index.ts`
- Create: `fixtures/si-demo/**` (via the generator script below)
- Create: `tests/unit/fixtures-provider.test.ts`
- Modify: `src/core/index.ts` is untouched; add `src/context/index.ts`

**Interfaces:**
- Consumes: `entitySchema`, `Entity` from `core/schemas/entity.ts`
- Produces:
  - `interface ContextProvider { readonly name: string; load(): Promise<LoadResult> }`
  - `interface LoadResult { entities: Entity[]; rejected: Rejection[] }`
  - `interface Rejection { source: string; reason: string }`
  - `class FixtureProvider implements ContextProvider` — `new FixtureProvider(rootDir)`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/fixtures-provider.test.ts`:

```typescript
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FixtureProvider } from '../../src/context/fixtures/index.js'

const ROOT = path.resolve(import.meta.dirname, '../../fixtures/si-demo')

describe('FixtureProvider', () => {
  it('loads every entity in the fixture SI', async () => {
    const { entities, rejected } = await new FixtureProvider(ROOT).load()
    expect(rejected).toEqual([])
    expect(entities.length).toBeGreaterThanOrEqual(28)
  })

  it('reports an invalid entity instead of dropping it silently', async () => {
    const broken = path.resolve(import.meta.dirname, '../golden/broken-si')
    const { entities, rejected } = await new FixtureProvider(broken).load()
    expect(entities).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.source).toContain('invalid.yml')
    expect(rejected[0]?.reason).toMatch(/owner/)
  })

  it('reads several documents from one file', async () => {
    const multi = path.resolve(import.meta.dirname, '../golden/multi-doc')
    const { entities } = await new FixtureProvider(multi).load()
    expect(entities.map((entity) => entity.metadata.name)).toEqual(['first', 'second'])
  })

  it('ignores files that are not YAML', async () => {
    const { rejected } = await new FixtureProvider(ROOT).load()
    expect(rejected.filter((r) => r.source.endsWith('.md'))).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/unit/fixtures-provider.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the interface**

Create `src/context/provider.ts`:

```typescript
import type { Entity } from '../core/schemas/entity.js'

/** Where an entity came from, and why it could not be used. */
export interface Rejection {
  source: string
  reason: string
}

/**
 * Rejections are returned rather than thrown, and never swallowed. Backstage
 * ignores a malformed entity in silence and the first source wins; a tool that
 * did the same would inherit the failure mode it exists to prevent (design 4.4).
 */
export interface LoadResult {
  entities: Entity[]
  rejected: Rejection[]
}

export interface ContextProvider {
  readonly name: string
  load(): Promise<LoadResult>
}
```

- [ ] **Step 4: Write the fixture provider**

Create `src/context/fixtures/index.ts`:

```typescript
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseAllDocuments } from 'yaml'
import { entitySchema } from '../../core/schemas/entity.js'
import type { ContextProvider, LoadResult, Rejection } from '../provider.js'
import type { Entity } from '../../core/schemas/entity.js'

const YAML_EXTENSIONS = new Set(['.yml', '.yaml'])

async function yamlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return yamlFiles(full)
      return YAML_EXTENSIONS.has(path.extname(entry.name)) ? [full] : []
    }),
  )
  return nested.flat().sort()
}

/**
 * Reads a directory laid out exactly like an IaC repository, so the fixture SI
 * is a valid repository rather than a test-only shape.
 */
export class FixtureProvider implements ContextProvider {
  readonly name = 'fixtures'

  constructor(private readonly rootDir: string) {}

  async load(): Promise<LoadResult> {
    const entities: Entity[] = []
    const rejected: Rejection[] = []

    for (const file of await yamlFiles(this.rootDir)) {
      const source = path.relative(this.rootDir, file)
      const content = await readFile(file, 'utf8')

      for (const document of parseAllDocuments(content)) {
        const value: unknown = document.toJS()
        // A witness file declares nothing; its absence is what would be an error.
        if (value === null || value === undefined) continue

        const parsed = entitySchema.safeParse(value)
        if (parsed.success) entities.push(parsed.data)
        else rejected.push({ source, reason: parsed.error.issues[0]?.message ?? 'invalid entity' })
      }
    }

    return { entities, rejected }
  }
}
```

- [ ] **Step 5: Create the golden fixtures for the failure cases**

`tests/golden/broken-si/valid.yml`:

```yaml
---
apiVersion: backstage.io/v1alpha1
kind: Resource
metadata:
  name: good-db-dev
spec:
  type: database
  owner: group:default/tiger
```

`tests/golden/broken-si/invalid.yml`:

```yaml
---
apiVersion: backstage.io/v1alpha1
kind: Resource
metadata:
  name: bad-db-dev
spec:
  type: database
  owner: tiger
```

`tests/golden/multi-doc/both.yml`:

```yaml
---
apiVersion: backstage.io/v1alpha1
kind: Resource
metadata:
  name: first
spec:
  type: database
  owner: group:default/tiger

---
apiVersion: backstage.io/v1alpha1
kind: Resource
metadata:
  name: second
spec:
  type: database
  owner: group:default/tiger
```

- [ ] **Step 6: Generate the fixture SI**

Run this script once from the repository root, then delete it. It writes one file
per entity, in the folder its type dictates, exactly as `computeEntityPath` would.

```typescript
// scripts/seed-fixtures.ts
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { serializeEntity } from '../src/core/yaml/serialize.js'
import { computeEntityPath } from '../src/core/paths/entity-path.js'
import type { Entity, ResourceType } from '../src/core/index.js'

const ROOT = 'fixtures/si-demo'

type Spec = [name: string, type: ResourceType, env: string, owner: string, dependsOn: string[], dependencyOf?: string[]]

const HOSTS: Spec[] = [
  ['mysql-disi6-dev', 'database', 'dev', 'common', []],
  ['mysql-disi6-rec', 'database', 'staging', 'common', []],
  ['mysql-prod-01', 'database', 'prod', 'common', []],
  ['redis-shared-dev', 'cache', 'dev', 'common', []],
  ['redis-shared-prod', 'cache', 'prod', 'common', []],
]

const DATABASES: Spec[] = [
  ['billing-db-dev', 'database', 'dev', 'tiger', ['resource:default/mysql-disi6-dev']],
  ['billing-db-prod', 'database', 'prod', 'tiger', ['resource:default/mysql-prod-01']],
  ['compliance-db-dev', 'database', 'dev', 'common', ['resource:default/mysql-disi6-dev']],
  ['compliance-db-prod', 'database', 'prod', 'common', ['resource:default/mysql-prod-01']],
  ['inpi-db-dev', 'database', 'dev', 'dodowarriors', ['resource:default/mysql-disi6-dev']],
  ['legacy-watch-dev', 'database', 'dev', 'elephant', ['resource:default/mysql-disi6-dev']],
  ['orders-db-dev', 'database', 'dev', 'tiger', ['resource:default/mysql-disi6-dev']],
  ['orders-db-prod', 'database', 'prod', 'tiger', ['resource:default/mysql-prod-01']],
]

const CACHES: Spec[] = [
  ['billing-cache-dev', 'cache', 'dev', 'tiger', ['resource:default/redis-shared-dev']],
  ['orders-cache-prod', 'cache', 'prod', 'tiger', ['resource:default/redis-shared-prod']],
]

const APIS: Spec[] = [
  ['inpi-api', 'api', 'prod', 'dodowarriors', []],
  ['sirene-api', 'api', 'prod', 'common', []],
  ['payments-api', 'api', 'prod', 'tiger', []],
]

const ACCESSES: Spec[] = [
  ['billing-api-billing-db-dev', 'database-access', 'dev', 'tiger', ['resource:default/billing-db-dev'], ['component:default/billing-api']],
  ['billing-api-billing-db-prod', 'database-access', 'prod', 'tiger', ['resource:default/billing-db-prod'], ['component:default/billing-api']],
  ['billing-api-cache-dev', 'database-access', 'dev', 'tiger', ['resource:default/billing-cache-dev'], ['component:default/billing-api']],
  ['reporting-billing-db-prod', 'database-access', 'prod', 'common', ['resource:default/billing-db-prod'], ['component:default/reporting-worker']],
  ['mcp-compliance-db-dev', 'database-access', 'dev', 'common', ['resource:default/compliance-db-dev'], ['component:default/mcp-eu-compliance']],
  ['mcp-inpi-db-dev', 'database-access', 'dev', 'dodowarriors', ['resource:default/inpi-db-dev'], ['component:default/mcp-inpi']],
  ['orders-api-orders-db-prod', 'database-access', 'prod', 'tiger', ['resource:default/orders-db-prod'], ['component:default/orders-api']],
]

const NETWORK: Spec[] = [
  ['mcp-inpi-to-inpi-api', 'network-access', 'prod', 'dodowarriors', ['resource:default/inpi-api'], ['component:default/mcp-inpi']],
  ['billing-api-to-payments', 'network-access', 'prod', 'tiger', ['resource:default/payments-api'], ['component:default/billing-api']],
  ['orders-api-to-sirene', 'network-access', 'prod', 'common', ['resource:default/sirene-api'], ['component:default/orders-api']],
]

const COMPONENTS = [
  ['billing-api', 'service', 'tiger'],
  ['orders-api', 'service', 'tiger'],
  ['reporting-worker', 'service', 'common'],
  ['mcp-eu-compliance', 'service', 'common'],
  ['mcp-inpi', 'service', 'dodowarriors'],
] as const

const toResource = ([name, type, env, owner, dependsOn, dependencyOf]: Spec): Entity => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Resource',
  metadata: { name, annotations: { 'company.fr/env': env } },
  spec: {
    type,
    owner: `group:default/${owner}`,
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
    ...(dependencyOf !== undefined ? { dependencyOf } : {}),
  },
})

async function write(entity: Entity, relativePath: string): Promise<void> {
  const full = path.join(ROOT, relativePath)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, `---\n${serializeEntity(entity)}`, 'utf8')
}

const resources = [...HOSTS, ...DATABASES, ...CACHES, ...APIS, ...ACCESSES, ...NETWORK]
for (const spec of resources) {
  const entity = toResource(spec)
  await write(entity, computeEntityPath(spec[1], spec[0]))
}

for (const [name, type, owner] of COMPONENTS) {
  await write(
    {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: { name, annotations: {} },
      spec: { type, lifecycle: 'production', owner: `group:default/${owner}` },
    },
    `components/${name}.yml`,
  )
}

// A witness file per folder: a pattern with no match is a read error, not an
// empty set (design 4.4).
for (const folder of ['catalog/databases', 'catalog/caches', 'catalog/apis', 'dependencies/access', 'dependencies/network', 'components']) {
  await mkdir(path.join(ROOT, folder), { recursive: true })
  await writeFile(path.join(ROOT, folder, '.witness.yml'), '# declares nothing; its absence would be a read error\n', 'utf8')
}

console.log(`wrote ${resources.length + COMPONENTS.length} entities`)
```

Run: `npx tsx scripts/seed-fixtures.ts && rm scripts/seed-fixtures.ts`
Expected: `wrote 33 entities`

- [ ] **Step 7: Run the tests**

Run: `pnpm test && pnpm typecheck`
Expected: PASS — 74 previous tests plus 4.

- [ ] **Step 8: Commit**

```bash
git add src/context fixtures tests/unit/fixtures-provider.test.ts tests/golden
git commit -m "feat(context): add ContextProvider and the fixture SI"
```

---

### Task 2: The entity graph

**Files:**
- Create: `src/context/graph/entity-graph.ts`
- Create: `tests/unit/entity-graph.test.ts`

**Interfaces:**
- Consumes: `Entity` from core, `LoadResult` from Task 1
- Produces:
  - `class EntityGraph` with `static from(entities: Entity[]): EntityGraph`
  - `refOf(entity: Entity): string` — `kind:default/name`, lower-cased kind
  - `get(ref): Entity | undefined` · `all(): Entity[]` · `size: number`
  - `search(criteria: SearchCriteria): Entity[]`
  - `dependenciesOf(ref): Entity[]` · `dependantsOf(ref): Entity[]`
  - `danglingReferences(): Array<{ from: string; to: string }>`
  - `interface SearchCriteria { kind?; type?; env?; nameContains?; owner? }`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/entity-graph.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { EntityGraph, refOf } from '../../src/context/graph/entity-graph.js'
import type { Entity } from '../../src/core/schemas/entity.js'

const resource = (
  name: string,
  type: Entity['spec']['type'],
  env: string,
  dependsOn: string[] = [],
  dependencyOf: string[] = [],
): Entity =>
  ({
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Resource',
    metadata: { name, annotations: { 'company.fr/env': env } },
    spec: {
      type,
      owner: 'group:default/tiger',
      ...(dependsOn.length > 0 ? { dependsOn } : {}),
      ...(dependencyOf.length > 0 ? { dependencyOf } : {}),
    },
  }) as Entity

const host = resource('mysql-dev', 'database', 'dev')
const db = resource('billing-db-dev', 'database', 'dev', ['resource:default/mysql-dev'])
const access = resource(
  'billing-api-billing-db-dev',
  'database-access',
  'dev',
  ['resource:default/billing-db-dev'],
  ['component:default/billing-api'],
)
const graph = EntityGraph.from([host, db, access])

describe('refOf', () => {
  it('builds a Backstage reference', () => {
    expect(refOf(db)).toBe('resource:default/billing-db-dev')
  })
})

describe('EntityGraph', () => {
  it('finds an entity by reference', () => {
    expect(graph.get('resource:default/billing-db-dev')).toEqual(db)
    expect(graph.get('resource:default/absent')).toBeUndefined()
  })

  it('searches by type and environment', () => {
    expect(graph.search({ type: 'database', env: 'dev' }).map((e) => e.metadata.name)).toEqual([
      'mysql-dev',
      'billing-db-dev',
    ])
  })

  it('searches by name fragment', () => {
    expect(graph.search({ nameContains: 'billing' }).map((e) => e.metadata.name)).toEqual([
      'billing-db-dev',
      'billing-api-billing-db-dev',
    ])
  })

  it('lists what an entity depends on', () => {
    expect(graph.dependenciesOf(refOf(db)).map((e) => e.metadata.name)).toEqual(['mysql-dev'])
  })

  it('lists what depends on an entity, from both directions of the declaration', () => {
    expect(graph.dependantsOf(refOf(db)).map((e) => e.metadata.name)).toEqual([
      'billing-api-billing-db-dev',
    ])
  })

  it('reports a dangling reference rather than resolving it to something plausible', () => {
    const orphan = resource('ghost-access', 'database-access', 'dev', ['resource:default/vanished'])
    expect(EntityGraph.from([orphan]).danglingReferences()).toEqual([
      { from: 'resource:default/ghost-access', to: 'resource:default/vanished' },
    ])
  })

  it('has no dangling reference in a consistent graph', () => {
    expect(graph.danglingReferences()).toEqual([])
  })

  it('survives a reference cycle', () => {
    const a = resource('a', 'database', 'dev', ['resource:default/b'])
    const b = resource('b', 'database', 'dev', ['resource:default/a'])
    const cyclic = EntityGraph.from([a, b])
    expect(cyclic.dependenciesOf('resource:default/a').map((e) => e.metadata.name)).toEqual(['b'])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/unit/entity-graph.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/context/graph/entity-graph.ts`:

```typescript
import type { Entity } from '../../core/schemas/entity.js'

export interface SearchCriteria {
  kind?: 'Component' | 'Resource'
  type?: string
  env?: string
  nameContains?: string
  owner?: string
}

export const ENV_ANNOTATION = 'company.fr/env'

/** `kind:namespace/name`, the form Backstage uses in dependsOn and dependencyOf. */
export function refOf(entity: Entity): string {
  return `${entity.kind.toLowerCase()}:default/${entity.metadata.name}`
}

const envOf = (entity: Entity): string | undefined => entity.metadata.annotations[ENV_ANNOTATION]

export class EntityGraph {
  private readonly byRef: Map<string, Entity>
  private readonly dependants: Map<string, Set<string>>

  private constructor(private readonly entities: Entity[]) {
    this.byRef = new Map(entities.map((entity) => [refOf(entity), entity]))
    this.dependants = new Map()

    // A dependency is declared from either side: `dependsOn` on the consumer, or
    // `dependencyOf` on the access. Both are indexed into the same reverse map so
    // a question about consumers does not depend on which side wrote it down.
    for (const entity of entities) {
      const ref = refOf(entity)
      for (const target of entity.spec.dependsOn ?? []) this.link(target, ref)
      if (entity.kind === 'Resource') {
        for (const consumer of entity.spec.dependencyOf ?? []) this.link(ref, consumer)
      }
    }
  }

  private link(target: string, dependant: string): void {
    const set = this.dependants.get(target) ?? new Set<string>()
    set.add(dependant)
    this.dependants.set(target, set)
  }

  static from(entities: Entity[]): EntityGraph {
    return new EntityGraph(entities)
  }

  get size(): number {
    return this.entities.length
  }

  all(): Entity[] {
    return [...this.entities]
  }

  get(ref: string): Entity | undefined {
    return this.byRef.get(ref)
  }

  search(criteria: SearchCriteria): Entity[] {
    return this.entities.filter((entity) => {
      if (criteria.kind !== undefined && entity.kind !== criteria.kind) return false
      if (criteria.type !== undefined && entity.spec.type !== criteria.type) return false
      if (criteria.env !== undefined && envOf(entity) !== criteria.env) return false
      if (criteria.owner !== undefined && entity.spec.owner !== criteria.owner) return false
      if (
        criteria.nameContains !== undefined &&
        !entity.metadata.name.includes(criteria.nameContains)
      ) {
        return false
      }
      return true
    })
  }

  /** Present entities only. A missing target is a dangling reference, reported separately. */
  dependenciesOf(ref: string): Entity[] {
    const entity = this.byRef.get(ref)
    if (entity === undefined) return []
    return (entity.spec.dependsOn ?? [])
      .map((target) => this.byRef.get(target))
      .filter((found): found is Entity => found !== undefined)
  }

  dependantsOf(ref: string): Entity[] {
    return [...(this.dependants.get(ref) ?? [])]
      .map((dependant) => this.byRef.get(dependant))
      .filter((found): found is Entity => found !== undefined)
  }

  /**
   * References pointing at nothing. Reported rather than pruned: a reference to a
   * missing entity inflates a usage count, and "this flow is still in use" must
   * not be answered by an entity that no longer exists (design 4.4).
   */
  danglingReferences(): Array<{ from: string; to: string }> {
    const dangling: Array<{ from: string; to: string }> = []
    for (const entity of this.entities) {
      const from = refOf(entity)
      const targets = [
        ...(entity.spec.dependsOn ?? []),
        ...(entity.kind === 'Resource' ? (entity.spec.dependencyOf ?? []) : []),
      ]
      for (const to of targets) {
        if (!this.byRef.has(to)) dangling.push({ from, to })
      }
    }
    return dangling
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test && pnpm typecheck`
Expected: PASS — 9 new tests.

- [ ] **Step 5: Commit**

```bash
git add src/context/graph tests/unit/entity-graph.test.ts
git commit -m "feat(context): add the in-memory entity graph"
```

---

### Task 3: Transitive consumers

**Files:**
- Modify: `src/context/graph/entity-graph.ts`
- Modify: `tests/unit/entity-graph.test.ts`

**Interfaces:**
- Produces: `consumersOf(ref: string): Entity[]` — Components reached through any
  chain of accesses, deduplicated, cycle-safe.

The question "which services talk to the billing database" is two hops: the database
has an access as a dependant, and the access has a component as its dependant.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/entity-graph.test.ts`:

```typescript
describe('consumersOf', () => {
  const component: Entity = {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: { name: 'billing-api', annotations: {} },
    spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
  }
  const full = EntityGraph.from([host, db, access, component])

  it('reaches the component behind an access', () => {
    expect(full.consumersOf(refOf(db)).map((e) => e.metadata.name)).toEqual(['billing-api'])
  })

  it('reaches consumers of the host through the database', () => {
    expect(full.consumersOf(refOf(host)).map((e) => e.metadata.name)).toEqual(['billing-api'])
  })

  it('returns nothing for an entity nobody consumes', () => {
    expect(full.consumersOf('resource:default/absent')).toEqual([])
  })

  it('terminates on a cycle', () => {
    const a = resource('a', 'database', 'dev', ['resource:default/b'])
    const b = resource('b', 'database', 'dev', ['resource:default/a'])
    expect(EntityGraph.from([a, b]).consumersOf('resource:default/a')).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/unit/entity-graph.test.ts`
Expected: FAIL — `full.consumersOf is not a function`.

- [ ] **Step 3: Implement**

Add to `EntityGraph`:

```typescript
  /**
   * Components reached through any chain of dependants. Breadth-first with a
   * visited set: a repository is edited by hand, so a cycle is a thing that
   * happens, and answering a read-only question must never hang.
   */
  consumersOf(ref: string): Entity[] {
    const seen = new Set<string>([ref])
    const queue = [ref]
    const found: Entity[] = []

    while (queue.length > 0) {
      const current = queue.shift()
      if (current === undefined) break
      for (const dependant of this.dependantsOf(current)) {
        const dependantRef = refOf(dependant)
        if (seen.has(dependantRef)) continue
        seen.add(dependantRef)
        if (dependant.kind === 'Component') found.push(dependant)
        else queue.push(dependantRef)
      }
    }

    return found
  }
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test && pnpm typecheck`
Expected: PASS — 4 new tests.

- [ ] **Step 5: Commit**

```bash
git add src/context/graph tests/unit/entity-graph.test.ts
git commit -m "feat(context): resolve transitive consumers of a resource"
```

---

### Task 4: Rendering

**Files:**
- Create: `src/cli/render/table.ts`
- Create: `src/cli/render/entity.ts`
- Create: `tests/unit/render.test.ts`

**Interfaces:**
- Produces:
  - `renderTable(headers: string[], rows: string[][]): string`
  - `renderEntityDetail(graph: EntityGraph, entity: Entity): string`

Rendering returns a string and writes nothing, so it is asserted exactly.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/render.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { renderTable } from '../../src/cli/render/table.js'
import { renderEntityDetail } from '../../src/cli/render/entity.js'
import { EntityGraph } from '../../src/context/graph/entity-graph.js'
import type { Entity } from '../../src/core/schemas/entity.js'

describe('renderTable', () => {
  it('aligns columns to the widest cell', () => {
    // Asserting the exact run of spaces would mean counting them by hand and
    // getting it wrong; assert the alignment itself.
    const lines = renderTable(['NAME', 'ENV'], [['a', 'dev'], ['longer-name', 'prod']]).split('\n')
    expect(lines).toHaveLength(3)
    const column = lines[0]?.indexOf('ENV')
    expect(lines[1]?.indexOf('dev')).toBe(column)
    expect(lines[2]?.indexOf('prod')).toBe(column)
    expect(lines[2]?.startsWith('longer-name  ')).toBe(true)
  })

  it('renders headers alone when there are no rows', () => {
    expect(renderTable(['NAME'], [])).toBe('NAME')
  })

  it('never pads the last column, so no line carries trailing space', () => {
    const output = renderTable(['A', 'B'], [['x', 'y']])
    expect(output.split('\n').every((line) => line === line.trimEnd())).toBe(true)
  })
})

describe('renderEntityDetail', () => {
  const db: Entity = {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Resource',
    metadata: { name: 'billing-db-dev', annotations: { 'company.fr/env': 'dev' } },
    spec: { type: 'database', owner: 'group:default/tiger' },
  }

  it('states what is known and marks what is not', () => {
    const output = renderEntityDetail(EntityGraph.from([db]), db)
    expect(output).toContain('billing-db-dev')
    expect(output).toContain('database')
    expect(output).toContain('group:default/tiger')
    expect(output).toContain('dev')
  })

  it('says an environment is undeclared rather than guessing one', () => {
    const bare: Entity = { ...db, metadata: { name: 'x', annotations: {} } }
    expect(renderEntityDetail(EntityGraph.from([bare]), bare)).toContain('undeclared')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/unit/render.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the table**

Create `src/cli/render/table.ts`:

```typescript
const GUTTER = '  '

/**
 * The last column is never padded: trailing whitespace shows up in a diff, in a
 * copied paste and in a golden test, and it never carries meaning.
 */
export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
  )

  const line = (cells: string[]): string =>
    cells
      .map((cell, column) =>
        column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? 0),
      )
      .join(GUTTER)
      .trimEnd()

  return [line(headers), ...rows.map(line)].join('\n')
}
```

- [ ] **Step 4: Implement the detail view**

Create `src/cli/render/entity.ts`:

```typescript
import type { Entity } from '../../core/schemas/entity.js'
import { ENV_ANNOTATION, refOf, type EntityGraph } from '../../context/graph/entity-graph.js'

/** Declare, never infer: an absent environment is stated as absent (design 4.1). */
const UNDECLARED = '(undeclared)'

export function renderEntityDetail(graph: EntityGraph, entity: Entity): string {
  const lines: string[] = [
    refOf(entity),
    '',
    `  kind         ${entity.kind}`,
    `  type         ${entity.spec.type}`,
    `  owner        ${entity.spec.owner}`,
    `  environment  ${entity.metadata.annotations[ENV_ANNOTATION] ?? UNDECLARED}`,
  ]

  const section = (title: string, entities: Entity[]): void => {
    lines.push('', title)
    if (entities.length === 0) lines.push('  none')
    else for (const found of entities) lines.push(`  ${refOf(found)}`)
  }

  section('depends on', graph.dependenciesOf(refOf(entity)))
  section('used by', graph.dependantsOf(refOf(entity)))

  const consumers = graph.consumersOf(refOf(entity))
  if (consumers.length > 0) section('reached by services', consumers)

  return lines.join('\n')
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test && pnpm typecheck`
Expected: PASS — 5 new tests.

- [ ] **Step 6: Commit**

```bash
git add src/cli/render tests/unit/render.test.ts
git commit -m "feat(cli): render tables and entity detail as strings"
```

---

### Task 5: The graph and show commands

**Files:**
- Create: `src/cli/commands/graph.ts`
- Create: `src/cli/commands/show.ts`
- Create: `tests/unit/commands.test.ts`

**Interfaces:**
- Produces:
  - `runGraph(graph: EntityGraph, options: GraphOptions): string`
  - `runShow(graph: EntityGraph, query: string): string`
  - `interface GraphOptions { env?: string; type?: string; kind?: 'Component' | 'Resource' }`

Commands take a graph and return a string. Nothing here touches the disk or stdout,
so a command is asserted like any pure function.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/commands.test.ts`:

```typescript
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FixtureProvider } from '../../src/context/fixtures/index.js'
import { EntityGraph } from '../../src/context/graph/entity-graph.js'
import { runGraph } from '../../src/cli/commands/graph.js'
import { runShow } from '../../src/cli/commands/show.js'

const ROOT = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const load = async (): Promise<EntityGraph> =>
  EntityGraph.from((await new FixtureProvider(ROOT).load()).entities)

describe('graph', () => {
  it('summarises the whole SI', async () => {
    const output = runGraph(await load(), {})
    expect(output).toContain('billing-db-dev')
    expect(output).toContain('NAME')
  })

  it('filters by environment', async () => {
    const output = runGraph(await load(), { env: 'prod' })
    expect(output).toContain('billing-db-prod')
    expect(output).not.toContain('billing-db-dev')
  })

  it('reports when a filter matches nothing, rather than printing an empty table', async () => {
    expect(runGraph(await load(), { env: 'nowhere' })).toContain('No entity matches')
  })
})

describe('show', () => {
  it('accepts a bare name as well as a full reference', async () => {
    const graph = await load()
    expect(runShow(graph, 'billing-db-dev')).toContain('resource:default/billing-db-dev')
    expect(runShow(graph, 'resource:default/billing-db-dev')).toContain('database')
  })

  it('names the services that reach a database', async () => {
    expect(runShow(await load(), 'billing-db-prod')).toContain('billing-api')
  })

  it('lists the candidates when a name is ambiguous', async () => {
    const output = runShow(await load(), 'billing')
    expect(output).toMatch(/matches \d+ entities/)
    expect(output).toContain('billing-db-dev')
    expect(output).toContain('billing-db-prod')
  })

  it('says so when nothing matches', async () => {
    expect(runShow(await load(), 'no-such-thing')).toContain('No entity named')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/unit/commands.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement graph**

Create `src/cli/commands/graph.ts`:

```typescript
import { ENV_ANNOTATION, type EntityGraph } from '../../context/graph/entity-graph.js'
import { renderTable } from '../render/table.js'

export interface GraphOptions {
  env?: string
  type?: string
  kind?: 'Component' | 'Resource'
}

export function runGraph(graph: EntityGraph, options: GraphOptions): string {
  const matches = graph.search({
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.type !== undefined ? { type: options.type } : {}),
    ...(options.kind !== undefined ? { kind: options.kind } : {}),
  })

  if (matches.length === 0) return 'No entity matches those filters.'

  const rows = matches.map((entity) => [
    entity.metadata.name,
    entity.kind,
    entity.spec.type,
    entity.metadata.annotations[ENV_ANNOTATION] ?? '-',
    entity.spec.owner,
  ])

  const table = renderTable(['NAME', 'KIND', 'TYPE', 'ENV', 'OWNER'], rows)
  const dangling = graph.danglingReferences()
  if (dangling.length === 0) return table

  // Surfaced, never pruned: a reference to a missing entity inflates a usage
  // count, and silence here is the failure this tool exists to prevent.
  const warnings = dangling.map(({ from, to }) => `  ${from} -> ${to}`)
  return [table, '', `${dangling.length} dangling reference(s):`, ...warnings].join('\n')
}
```

- [ ] **Step 4: Implement show**

Create `src/cli/commands/show.ts`:

```typescript
import { refOf, type EntityGraph } from '../../context/graph/entity-graph.js'
import { renderEntityDetail } from '../render/entity.js'

/**
 * A bare name is resolved to a reference; an ambiguous one lists the candidates
 * instead of picking the first. Declare, never infer (design 4.1).
 */
export function runShow(graph: EntityGraph, query: string): string {
  const exact = graph.get(query) ?? graph.all().find((entity) => entity.metadata.name === query)
  if (exact !== undefined) return renderEntityDetail(graph, exact)

  const candidates = graph.search({ nameContains: query })
  if (candidates.length === 0) return `No entity named "${query}".`

  const lines = candidates.map((entity) => `  ${refOf(entity)}`)
  return [`"${query}" matches ${candidates.length} entities:`, ...lines].join('\n')
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test && pnpm typecheck`
Expected: PASS — 7 new tests.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands tests/unit/commands.test.ts
git commit -m "feat(cli): add the graph and show commands"
```

---

### Task 6: The executable entry point

**Files:**
- Create: `src/cli/index.ts`
- Create: `tests/unit/cli-args.test.ts`
- Modify: `package.json` (add `bin`, `files`)

**Interfaces:**
- Produces:
  - `parseArguments(argv: string[]): Command` — a discriminated union
  - `type Command = { name: 'graph'; options: GraphOptions } | { name: 'show'; query: string } | { name: 'help' } | { name: 'error'; message: string }`
  - `main(argv: string[]): Promise<number>` — returns the exit code, never calls `process.exit`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/cli-args.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { parseArguments } from '../../src/cli/index.js'

describe('parseArguments', () => {
  it('reads the graph command with its filters', () => {
    expect(parseArguments(['graph', '--env', 'prod'])).toEqual({
      name: 'graph',
      options: { env: 'prod' },
    })
  })

  it('reads the show command with its argument', () => {
    expect(parseArguments(['show', 'billing-db-dev'])).toEqual({
      name: 'show',
      query: 'billing-db-dev',
    })
  })

  it('asks for help when given nothing', () => {
    expect(parseArguments([])).toEqual({ name: 'help' })
  })

  it('reports an unknown command instead of guessing one', () => {
    const command = parseArguments(['destroy'])
    expect(command.name).toBe('error')
  })

  it('reports show without an argument', () => {
    expect(parseArguments(['show']).name).toBe('error')
  })

  it('reports an unknown flag rather than ignoring it', () => {
    expect(parseArguments(['graph', '--wat', 'x']).name).toBe('error')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run tests/unit/cli-args.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/cli/index.ts`:

```typescript
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { FixtureProvider } from '../context/fixtures/index.js'
import { EntityGraph } from '../context/graph/entity-graph.js'
import { runGraph, type GraphOptions } from './commands/graph.js'
import { runShow } from './commands/show.js'

export type Command =
  | { name: 'graph'; options: GraphOptions }
  | { name: 'show'; query: string }
  | { name: 'help' }
  | { name: 'error'; message: string }

const HELP = `idp-agent — read-only view of the service catalogue

  idp-agent graph [--env <env>] [--type <type>] [--kind Component|Resource]
  idp-agent show <name-or-reference>
`

export function parseArguments(argv: string[]): Command {
  const [commandName, ...rest] = argv
  if (commandName === undefined || commandName === 'help' || commandName === '--help') {
    return { name: 'help' }
  }

  if (commandName === 'show') {
    const query = rest[0]
    if (query === undefined) return { name: 'error', message: 'show needs a name or a reference' }
    return { name: 'show', query }
  }

  if (commandName === 'graph') {
    try {
      const { values } = parseArgs({
        args: rest,
        options: {
          env: { type: 'string' },
          type: { type: 'string' },
          kind: { type: 'string' },
        },
        strict: true,
      })
      const kind = values.kind
      if (kind !== undefined && kind !== 'Component' && kind !== 'Resource') {
        return { name: 'error', message: 'kind must be Component or Resource' }
      }
      return {
        name: 'graph',
        options: {
          ...(values.env !== undefined ? { env: values.env } : {}),
          ...(values.type !== undefined ? { type: values.type } : {}),
          ...(kind !== undefined ? { kind } : {}),
        },
      }
    } catch (error) {
      return { name: 'error', message: (error as Error).message }
    }
  }

  return { name: 'error', message: `unknown command "${commandName}"` }
}

/** Returns the exit code rather than calling process.exit, so it is testable. */
export async function main(argv: string[]): Promise<number> {
  const command = parseArguments(argv)

  if (command.name === 'help') {
    process.stdout.write(HELP)
    return 0
  }
  if (command.name === 'error') {
    process.stderr.write(`${command.message}\n\n${HELP}`)
    return 2
  }

  const fixtures = path.resolve(fileURLToPath(import.meta.url), '../../../fixtures/si-demo')
  const { entities, rejected } = await new FixtureProvider(fixtures).load()
  for (const rejection of rejected) {
    process.stderr.write(`skipped ${rejection.source}: ${rejection.reason}\n`)
  }

  const graph = EntityGraph.from(entities)
  const output = command.name === 'graph' ? runGraph(graph, command.options) : runShow(graph, command.query)
  process.stdout.write(`${output}\n`)
  return 0
}
```

- [ ] **Step 4: Add the bin entry**

In `package.json`, add alongside `scripts`:

```json
  "bin": {
    "idp-agent": "dist/cli/bin.js",
    "idpa": "dist/cli/bin.js"
  },
  "files": ["dist", "fixtures", "LICENSE", "NOTICE"],
```

Create `src/cli/bin.ts`:

```typescript
#!/usr/bin/env node
import { main } from './index.js'

process.exitCode = await main(process.argv.slice(2))
```

- [ ] **Step 5: Run everything, then try it by hand**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: PASS.

Run: `node dist/cli/bin.js graph --env prod`
Expected: a table of production entities.

Run: `node dist/cli/bin.js show billing-db-prod`
Expected: the detail view, naming `billing-api` under "reached by services".

- [ ] **Step 6: Commit**

```bash
git add src/cli package.json tests/unit/cli-args.test.ts
git commit -m "feat(cli): add the executable entry point"
```

---

## Done when

- `idp-agent graph` prints the fictional SI, and `--env prod` filters it
- `idp-agent show billing-db-prod` names the services that reach it
- An invalid entity is reported on stderr, never dropped in silence
- A dangling reference is surfaced under the table, never pruned
- An ambiguous name lists candidates instead of picking the first
- `pnpm test` still needs no API key, no network and no Docker

Stage 2 (question mode) puts a model in front of exactly these queries.
