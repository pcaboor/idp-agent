import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FixtureProvider } from '../../src/context/fixtures/index.js'
import { EntityGraph } from '../../src/context/graph/entity-graph.js'
import { buildTools, type ToolOutcome } from '../../src/agents/tools/graph-tools.js'
import type { Entity } from '../../src/core/schemas/entity.js'
import { QUERY_LIMITS } from '../../src/core/schemas/query.js'

const ROOT = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const tools = async (): Promise<ReturnType<typeof buildTools>> =>
  buildTools(EntityGraph.from((await new FixtureProvider(ROOT).load()).entities))

const call = (name: string, args: unknown) => ({ id: 'c1', name, args })
const text = (value: unknown): string => JSON.stringify(value)

/** The rows a tool returned, as plain objects: `Row` is internal on purpose. */
const rows = (outcome: ToolOutcome): Array<Record<string, unknown>> =>
  (outcome.result as { rows: Array<Record<string, unknown>> }).rows

describe('the tool registry', () => {
  it('exposes exactly the four tools the loop needs', async () => {
    expect((await tools()).specs.map((spec) => spec.name)).toEqual([
      'search_entities',
      'get_entity',
      'get_dependencies',
      'answer',
    ])
  })

  it('describes every tool, since the description is all the model has to choose from', async () => {
    expect((await tools()).specs.every((spec) => spec.description.length > 20)).toBe(true)
  })
})

describe('search_entities', () => {
  it('records every reference it returned in the witness set', async () => {
    const built = await tools()
    built.run(call('search_entities', { type: 'database', env: 'prod' }))
    expect(built.witnessed.has('resource:default/billing-db-prod')).toBe(true)
    expect(built.witnessed.has('resource:default/billing-db-dev')).toBe(false)
  })

  it('caps a result and states the truncation rather than trimming in silence', async () => {
    const built = await tools()
    const outcome = built.run(call('search_entities', { kind: 'Resource' }))
    expect(outcome.rows).toBeLessThanOrEqual(QUERY_LIMITS.maxRows)
    expect(outcome.truncated).toBeGreaterThan(0)
    expect(text(outcome.result)).toContain('truncated')
  })

  it('rejects a search with no criterion, which would hand over the whole SI', async () => {
    expect(text((await tools()).run(call('search_entities', {})).result)).toMatch(/criterion/)
  })

  it('rejects arguments that do not parse, and names the tool', async () => {
    const outcome = (await tools()).run(call('search_entities', { kind: 'Banana' }))
    expect(text(outcome.result)).toMatch(/search_entities/)
    expect(outcome.rows).toBe(0)
  })

  it('returns an empty result rather than an error when nothing matches', async () => {
    const outcome = (await tools()).run(call('search_entities', { env: 'nowhere' }))
    expect(outcome.rows).toBe(0)
    expect(text(outcome.result)).not.toMatch(/error/)
  })
})

describe('get_entity', () => {
  it('says an entity is unknown rather than offering a nearest match', async () => {
    // Declare, never infer: a helpful guess here is how a model ends up
    // answering confidently about an entity that does not exist.
    const outcome = (await tools()).run(call('get_entity', { ref: 'resource:default/nope' }))
    expect(text(outcome.result)).toContain('no such entity')
    expect(text(outcome.result)).not.toContain('billing')
  })

  it('returns the entity and witnesses it', async () => {
    const built = await tools()
    const outcome = built.run(call('get_entity', { ref: 'resource:default/billing-db-prod' }))
    expect(text(outcome.result)).toContain('billing-db-prod')
    expect(built.witnessed.has('resource:default/billing-db-prod')).toBe(true)
  })
})

describe('get_dependencies', () => {
  it('keeps the three directions apart, since the model is a poor judge of which was meant', async () => {
    const built = await tools()
    const ref = 'resource:default/billing-db-prod'
    expect(text(built.run(call('get_dependencies', { ref, direction: 'dependencies' })).result))
      .toContain('mysql-prod-01')
    expect(text(built.run(call('get_dependencies', { ref, direction: 'dependants' })).result))
      .toContain('billing-api-billing-db-prod')
    expect(text(built.run(call('get_dependencies', { ref, direction: 'consumers' })).result))
      .toContain('billing-api')
  })

  it('refuses a direction it does not model', async () => {
    const outcome = (await tools()).run(
      call('get_dependencies', { ref: 'resource:default/billing-db-prod', direction: 'sideways' }),
    )
    expect(text(outcome.result)).toMatch(/get_dependencies/)
  })
})

describe('the level a row states', () => {
  // The level of a grant is the authorisation being asked for. A model that
  // cannot read it off the catalogue has to guess whether an existing grant
  // already covers the request — and the plan gate then refuses it for a fact
  // it was never shown.
  const resource = (name: string, type: 'database-access' | 'network-access' | 'database') =>
    ({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: { name, annotations: { 'company.fr/env': 'dev' } },
      spec: { type, owner: 'group:default/tiger' },
    }) satisfies Entity

  it('carries the level a levelled grant declares', async () => {
    const outcome = (await tools()).run(
      call('get_entity', { ref: 'resource:default/billing-api-billing-db-prod' }),
    )
    expect(rows(outcome)[0]).toMatchObject({ type: 'database-access', access: 'readwrite' })
  })

  it('carries it through search_entities as well', async () => {
    const outcome = (await tools()).run(call('search_entities', { type: 'database-access' }))
    const byName = new Map(rows(outcome).map((row) => [row.name, row.access]))
    expect(byName.get('billing-api-billing-db-prod')).toBe('readwrite')
    expect(byName.get('reporting-billing-db-prod')).toBe('read')
  })

  it('carries it through get_dependencies as well', async () => {
    const outcome = (await tools()).run(
      call('get_dependencies', { ref: 'resource:default/billing-db-prod', direction: 'dependants' }),
    )
    const grant = rows(outcome).find((row) => row.name === 'billing-api-billing-db-prod')
    expect(grant).toMatchObject({ access: 'readwrite' })
  })

  it('gives an object no level: there is nothing for one to be about', async () => {
    const outcome = (await tools()).run(
      call('get_entity', { ref: 'resource:default/billing-db-prod' }),
    )
    expect(rows(outcome)[0]).not.toHaveProperty('access')
  })

  it('gives an unlevelled right none either: a flow is opened or it is not', async () => {
    const outcome = (await tools()).run(
      call('get_entity', { ref: 'resource:default/billing-api-to-payments' }),
    )
    expect(rows(outcome)[0]).toMatchObject({ type: 'network-access' })
    expect(rows(outcome)[0]).not.toHaveProperty('access')
  })

  it('states that a levelled grant declares none, rather than reading one as read', () => {
    // `resourceSchema` leaves `access` optional so a repository written before
    // the field still parses. An absent level is absent, never a default.
    const built = buildTools(EntityGraph.from([resource('legacy-grant', 'database-access')]))
    const outcome = built.run(call('get_entity', { ref: 'resource:default/legacy-grant' }))
    expect(rows(outcome)[0]).toMatchObject({ access: '(undeclared)' })
  })

  it('witnesses exactly the references it returned, level or no level', () => {
    // The one thing these tools must not gain or lose. A field added to a row
    // describes what was read; it must not change WHAT was read.
    const built = buildTools(
      EntityGraph.from([
        resource('legacy-grant', 'database-access'),
        resource('billing-db-dev', 'database'),
        resource('billing-api-to-payments', 'network-access'),
      ]),
    )
    const outcome = built.run(call('search_entities', { kind: 'Resource' }))
    expect([...built.witnessed].sort()).toEqual(rows(outcome).map((row) => row.ref).sort())
    expect(built.witnessed.size).toBe(3)
  })
})

describe('the answer tool and the registry itself', () => {
  it('refuses an unknown tool name instead of ignoring the call', async () => {
    expect(text((await tools()).run(call('delete_everything', {})).result)).toMatch(/unknown tool/)
  })

  it('returns the answer as given, for the loop to validate and the engine to sign', async () => {
    const outcome = (await tools()).run(
      call('answer', { outcome: 'entities', refs: ['resource:default/billing-db-prod'] }),
    )
    expect(text(outcome.result)).toContain('billing-db-prod')
  })

  it('does not witness what the answer tool names, which would defeat the check', async () => {
    // The witness set records what the ENGINE returned. If calling answer added
    // to it, a model could witness its own invention.
    const built = await tools()
    built.run(call('answer', { outcome: 'entities', refs: ['resource:default/invented'] }))
    expect(built.witnessed.has('resource:default/invented')).toBe(false)
  })
})
