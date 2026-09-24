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

  it('returns an empty result rather than an error when known values match nothing together', async () => {
    // Every value is one the catalogue uses; no entity has all of them. That is
    // an answer, and an error there would send the model looking for a typo.
    const outcome = (await tools()).run(
      call('search_entities', { type: 'database', env: 'prod', nameContains: 'no-such-name' }),
    )
    expect(outcome.rows).toBe(0)
    expect(outcome.error).toBeUndefined()
    expect(text(outcome.result)).not.toMatch(/error/)
  })

  it('states the error it refused a call with, beside the result the model reads', async () => {
    const outcome = (await tools()).run(call('search_entities', { kind: 'Banana' }))
    expect(outcome.error).toMatch(/^search_entities: /)
    expect(outcome.result).toEqual({ error: outcome.error })
  })
})

describe('search_entities, given a value the catalogue does not use', () => {
  // A real model fills every optional criterion it is shown, and an invented
  // environment used to come back as an empty result: a legitimate-looking
  // "nothing", for a search that could never have matched. It is an error the
  // model can act on instead, naming the values the catalogue does use.
  const component = (name: string, extra: { env?: string; type?: string; owner?: string } = {}) =>
    ({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: {
        name,
        annotations: extra.env === undefined ? {} : { 'company.fr/env': extra.env },
      },
      spec: {
        type: extra.type ?? 'website',
        lifecycle: 'production',
        owner: extra.owner ?? 'group:default/artist-relations-team',
      },
    }) satisfies Entity

  const ARTIST_WEB = component('artist-web')
  const lone = () => buildTools(EntityGraph.from([ARTIST_WEB]))
  const errorOf = (outcome: ToolOutcome): string => {
    expect(outcome.rows).toBe(0)
    expect(outcome.error).toBeDefined()
    expect(outcome.result).toEqual({ error: outcome.error })
    return outcome.error ?? ''
  }

  it('refuses an environment in a catalogue that declares none, and says to omit it', () => {
    const outcome = lone().run(call('search_entities', { kind: 'Component', env: 'default' }))
    expect(errorOf(outcome)).toBe(
      'search_entities: env "default" matches no entity: ' +
        'this catalogue declares no environment — omit env',
    )
  })

  it('refuses an environment nobody uses, and names the ones in use', () => {
    const built = buildTools(
      EntityGraph.from([
        component('a', { env: 'prod' }),
        component('b', { env: 'dev' }),
        component('c', { env: 'prod' }),
      ]),
    )
    const outcome = built.run(call('search_entities', { env: 'staging' }))
    expect(errorOf(outcome)).toBe(
      'search_entities: env "staging" matches no entity; environments in use: dev, prod',
    )
  })

  it('says how many entities declare no environment, since no env value reaches them', () => {
    const built = buildTools(
      EntityGraph.from([component('a', { env: 'prod' }), ARTIST_WEB]),
    )
    const outcome = built.run(call('search_entities', { env: 'default' }))
    expect(errorOf(outcome)).toBe(
      'search_entities: env "default" matches no entity; environments in use: prod; ' +
        '1 entity declares none — omit env to include it',
    )
  })

  it('still matches no entity without an environment on an env that is in use', () => {
    const built = buildTools(
      EntityGraph.from([component('a', { env: 'prod' }), ARTIST_WEB]),
    )
    const outcome = built.run(call('search_entities', { env: 'prod' }))
    expect(rows(outcome).map((row) => row.name)).toEqual(['a'])
    expect(outcome.error).toBeUndefined()
  })

  it('refuses a type nobody uses, and names the ones in use', () => {
    const outcome = lone().run(call('search_entities', { type: 'service' }))
    expect(errorOf(outcome)).toBe(
      'search_entities: type "service" matches no entity; types in use: website',
    )
  })

  it('refuses a kind nobody uses, and names the ones in use', () => {
    const outcome = lone().run(call('search_entities', { kind: 'Resource' }))
    expect(errorOf(outcome)).toBe(
      'search_entities: kind "Resource" matches no entity; kinds in use: Component',
    )
  })

  it('refuses an owner nobody uses, and names the ones in use', () => {
    const outcome = lone().run(call('search_entities', { owner: 'group:default/tiger' }))
    expect(errorOf(outcome)).toBe(
      'search_entities: owner "group:default/tiger" matches no entity; ' +
        'owners in use: group:default/artist-relations-team',
    )
  })

  it('names every criterion the catalogue does not use, not just the first', () => {
    const outcome = lone().run(
      call('search_entities', { type: 'service', env: 'prod', owner: 'group:default/tiger' }),
    )
    const error = errorOf(outcome)
    expect(error).toMatch(/type "service" matches no entity/)
    expect(error).toMatch(/env "prod" matches no entity/)
    expect(error).toMatch(/owner "group:default\/tiger" matches no entity/)
  })

  it('answers when every value is in use', () => {
    const built = lone()
    const outcome = built.run(
      call('search_entities', {
        kind: 'Component',
        type: 'website',
        owner: 'group:default/artist-relations-team',
        nameContains: 'artist-web',
      }),
    )
    expect(rows(outcome).map((row) => row.ref)).toEqual(['component:default/artist-web'])
    expect(outcome.error).toBeUndefined()
    expect(built.witnessed.has('component:default/artist-web')).toBe(true)
  })

  it('leaves nameContains a plain filter: a fragment nobody has is an empty answer', () => {
    const outcome = lone().run(call('search_entities', { nameContains: 'billing' }))
    expect(outcome.rows).toBe(0)
    expect(outcome.error).toBeUndefined()
    expect(outcome.result).toEqual({ rows: [] })
  })

  it('bounds the list of values it names, and counts the rest', () => {
    const many = Array.from({ length: 14 }, (_, index) =>
      component(`svc-${String(index)}`, { type: `type-${String(index).padStart(2, '0')}` }),
    )
    const outcome = buildTools(EntityGraph.from(many)).run(
      call('search_entities', { type: 'database' }),
    )
    const error = errorOf(outcome)
    expect(error).toMatch(/types in use: type-00, type-01, .*, type-09 and 4 more$/)
    expect(error).not.toContain('type-10')
  })

  it('refuses nothing on an empty catalogue, where the empty result is the whole truth', () => {
    // `init` builds its tools over an empty graph and relies on this.
    const built = buildTools(EntityGraph.from([]))
    for (const criteria of [
      { kind: 'Component' },
      { type: 'website' },
      { env: 'prod' },
      { owner: 'group:default/tiger' },
    ]) {
      const outcome = built.run(call('search_entities', criteria))
      expect(outcome.result).toEqual({ rows: [] })
      expect(outcome.error).toBeUndefined()
    }
  })

  it('witnesses nothing when it refuses', () => {
    const built = lone()
    built.run(call('search_entities', { kind: 'Component', env: 'default' }))
    expect(built.witnessed.size).toBe(0)
  })

  it('can be told to keep the empty result, for an agent whose recordings expect it', () => {
    // The Architect's plan-mode tapes were recorded against the silent empty
    // result; the tool result is part of every later request's digest.
    const built = buildTools(EntityGraph.from([ARTIST_WEB]), { refuseUnusedValues: false })
    const outcome = built.run(call('search_entities', { kind: 'Component', env: 'default' }))
    expect(outcome.result).toEqual({ rows: [] })
    expect(outcome.error).toBeUndefined()
  })
})

describe('get_entity', () => {
  it('says an entity is unknown rather than offering a nearest match', async () => {
    // Declare, never infer: a helpful guess here is how a model ends up
    // answering confidently about an entity that does not exist.
    const outcome = (await tools()).run(call('get_entity', { ref: 'resource:default/nope' }))
    expect(text(outcome.result)).toContain('no such entity')
    expect(outcome.error).toContain('no such entity')
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
    const outcome = (await tools()).run(call('delete_everything', {}))
    expect(text(outcome.result)).toMatch(/unknown tool/)
    expect(outcome.error).toMatch(/unknown tool/)
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
