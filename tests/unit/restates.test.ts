import { describe, expect, it } from 'vitest'
import { consumerRestatement, restatementOf, restates } from '../../src/core/plan/grant.js'
import type { Entity } from '../../src/core/schemas/entity.js'
import { ENV_ANNOTATION } from '../../src/core/schemas/vocabulary.js'
import { parseDocuments } from '../../src/core/yaml/serialize.js'

/**
 * What "already declared" compares, asked of `grant.ts` directly.
 *
 * It used to compare the level alone, so a grant held by ANOTHER consumer, at
 * the same level, was reported on exit 0 as the access the request asked for
 * — "nothing to change — the repository already says it" about an access that
 * did not exist (runtime-probe-1, core-plan-5). A declaration restates an
 * operation only when everything the operation would declare is already there.
 */

/** A grant as the reader hands it over: parsed from bytes, references in full. */
const declared = (lines: readonly string[]): Entity => {
  const [entity] = parseDocuments(`${lines.join('\n')}\n`).entities
  if (entity === undefined) throw new Error('the fixture does not parse as an entity')
  return entity
}

const grant = ({
  env = 'prod',
  /** null writes no `access:` line: §4.1's unstated level. */
  level = 'read' as string | null,
  owner = 'group:default/tiger',
  type = 'database-access',
  dependsOn = ['resource:default/orders-db-prod'],
  dependencyOf = ['component:default/billing-api'],
} = {}): Entity =>
  declared([
    '---',
    'apiVersion: backstage.io/v1alpha1',
    'kind: Resource',
    'metadata:',
    '  name: billing-api-orders-db-prod',
    '  annotations:',
    `    ${ENV_ANNOTATION}: ${env}`,
    'spec:',
    `  type: ${type}`,
    ...(level === null ? [] : [`  access: ${level}`]),
    `  owner: ${owner}`,
    '  dependsOn:',
    ...dependsOn.map((ref) => `    - ${ref}`),
    '  dependencyOf:',
    ...dependencyOf.map((ref) => `    - ${ref}`),
  ])

/** The proposal a draft would carry for that grant, as `propose()` receives it. */
const proposal = (over: { env?: string; spec?: Record<string, unknown> } = {}) => ({
  kind: 'Resource',
  metadata: { name: 'billing-api-orders-db-prod', env: over.env ?? 'prod' },
  spec: {
    type: 'database-access',
    access: 'read',
    owner: 'group:default/tiger',
    dependsOn: ['resource:default/orders-db-prod'],
    dependencyOf: ['component:default/billing-api'],
    ...over.spec,
  },
})

const fieldsOf = (result: ReturnType<typeof restatementOf>): string[] =>
  result.restates ? [] : result.differs.map((difference) => difference.field)

describe('restatementOf, a creation against the declaration of the same reference', () => {
  it('restates when the declaration says everything the proposal says', () => {
    const result = restatementOf(grant(), proposal())

    expect(result.restates).toBe(true)
    // What a reader can check against the file, field by field.
    expect(result.restates && result.fields).toEqual([
      { field: 'type', value: 'database-access' },
      { field: ENV_ANNOTATION, value: 'prod' },
      { field: 'access', value: 'read' },
      { field: 'owner', value: 'group:default/tiger' },
      { field: 'dependsOn', value: 'resource:default/orders-db-prod' },
      { field: 'dependencyOf', value: 'component:default/billing-api' },
    ])
  })

  it('does not restate a grant that lacks the requested consumer, at the same level', () => {
    // The review's case, word for word: another consumer's grant, the same
    // level, reported as billing-api's access.
    const result = restatementOf(
      grant({ dependencyOf: ['component:default/orders-api'] }),
      proposal(),
    )

    expect(result.restates).toBe(false)
    expect(fieldsOf(result)).toEqual(['dependencyOf'])
    expect(result.restates || result.differs[0]).toEqual({
      field: 'dependencyOf',
      declared: 'component:default/orders-api',
      proposed: 'component:default/billing-api',
    })
  })

  it('restates a grant that lists the consumer among others', () => {
    // A file legitimately carries consumers no proposal ever states: a replay
    // of billing-api's access to a grant orders-api also holds is a replay.
    const result = restatementOf(
      grant({ dependencyOf: ['component:default/orders-api', 'component:default/billing-api'] }),
      proposal(),
    )

    expect(result.restates).toBe(true)
    expect(result.restates && result.fields.at(-1)).toEqual({
      field: 'dependencyOf',
      value: 'component:default/billing-api',
    })
  })

  it('does not restate a grant in another environment', () => {
    expect(fieldsOf(restatementOf(grant({ env: 'staging' }), proposal()))).toEqual([ENV_ANNOTATION])
  })

  it('does not restate a grant that declares no environment', () => {
    // Declare, never infer: a declaration with no environment does not say prod.
    const unscoped = declared([
      '---',
      'apiVersion: backstage.io/v1alpha1',
      'kind: Resource',
      'metadata:',
      '  name: billing-api-orders-db-prod',
      'spec:',
      '  type: database-access',
      '  access: read',
      '  owner: group:default/tiger',
      '  dependsOn:',
      '    - resource:default/orders-db-prod',
      '  dependencyOf:',
      '    - component:default/billing-api',
    ])

    const result = restatementOf(unscoped, proposal())
    expect(fieldsOf(result)).toEqual([ENV_ANNOTATION])
    expect(result.restates || result.differs[0]?.declared).toBe('none')
  })

  it('does not restate a grant another team owns', () => {
    expect(fieldsOf(restatementOf(grant({ owner: 'group:default/lion' }), proposal()))).toEqual([
      'owner',
    ])
  })

  it('does not restate a right of another type', () => {
    // Two rights with no level, so the type is the one thing that differs.
    expect(
      fieldsOf(
        restatementOf(
          grant({ type: 'network-access', level: null }),
          proposal({ spec: { type: 'gateway-route', access: undefined } }),
        ),
      ),
    ).toEqual(['type'])
  })

  it('does not restate a grant over another thing', () => {
    expect(
      fieldsOf(restatementOf(grant({ dependsOn: ['resource:default/payments-db-prod'] }), proposal())),
    ).toEqual(['dependsOn'])
  })

  it('does not restate a grant at another level, or at none', () => {
    expect(fieldsOf(restatementOf(grant({ level: 'readwrite' }), proposal()))).toEqual(['access'])
    expect(fieldsOf(restatementOf(grant({ level: null }), proposal()))).toEqual(['access'])
  })

  it('names every field that differs, not the first', () => {
    expect(
      fieldsOf(
        restatementOf(
          grant({ owner: 'group:default/lion', dependencyOf: ['component:default/orders-api'] }),
          proposal(),
        ),
      ),
    ).toEqual(['owner', 'dependencyOf'])
  })

  it('compares references as the reader reads them, short forms included', () => {
    // Backstage fills in an omitted kind and namespace, and so does the
    // reader; the file keeps the spelling a person wrote.
    const short = declared([
      '---',
      'apiVersion: backstage.io/v1alpha1',
      'kind: Resource',
      'metadata:',
      '  name: billing-api-orders-db-prod',
      '  annotations:',
      `    ${ENV_ANNOTATION}: prod`,
      'spec:',
      '  type: database-access',
      '  access: read',
      '  owner: tiger',
      '  dependsOn:',
      '    - Resource:orders-db-prod',
      '  dependencyOf:',
      '    - component:DEFAULT/billing-api',
    ])

    expect(restatementOf(short, proposal()).restates).toBe(true)
  })

  it('never reads a question as a value', () => {
    const asked = proposal({ spec: { owner: { unknown: 'which team owns it?' } } })

    expect(fieldsOf(restatementOf(grant(), asked))).toEqual(['owner'])
  })

  it('is what `restates` answers', () => {
    expect(restates(grant(), proposal())).toBe(true)
    expect(restates(grant({ dependencyOf: ['component:default/orders-api'] }), proposal())).toBe(
      false,
    )
  })
})

describe('consumerRestatement, an add-dependency-of against the grant it extends', () => {
  it('restates when the consumer is listed and the level agrees', () => {
    const result = consumerRestatement(grant(), 'component:default/billing-api', 'read')

    expect(result.restates).toBe(true)
    // What the grant is over, its type and its owner are named though the
    // operation states none of them: an update names its grant by reference,
    // and a grant over another thing that lists the consumer would otherwise
    // read as the access asked for, with nothing printed to catch it.
    expect(result.restates && result.fields).toEqual([
      { field: 'type', value: 'database-access' },
      { field: ENV_ANNOTATION, value: 'prod' },
      { field: 'access', value: 'read' },
      { field: 'owner', value: 'group:default/tiger' },
      { field: 'dependsOn', value: 'resource:default/orders-db-prod' },
      { field: 'dependencyOf', value: 'component:default/billing-api' },
    ])
  })

  it('names every thing a grant is over, the whole list', () => {
    const result = consumerRestatement(
      grant({
        dependsOn: ['resource:default/orders-db-prod', 'resource:default/payments-db-prod'],
      }),
      'component:default/billing-api',
      'read',
    )

    expect(result.restates && result.fields.find(({ field }) => field === 'dependsOn')).toEqual({
      field: 'dependsOn',
      value: 'resource:default/orders-db-prod, resource:default/payments-db-prod',
    })
  })

  it('does not restate a grant that does not list the consumer', () => {
    // That is an append, not an already-declared access.
    expect(
      fieldsOf(consumerRestatement(grant(), 'component:default/orders-api', 'read')),
    ).toEqual(['dependencyOf'])
  })

  it('does not restate a grant whose level the operation misstates', () => {
    expect(
      fieldsOf(consumerRestatement(grant(), 'component:default/billing-api', 'readwrite')),
    ).toEqual(['access'])
    // An omitted level claims the grant states none (§5.3), which this one does.
    expect(
      fieldsOf(consumerRestatement(grant(), 'component:default/billing-api', undefined)),
    ).toEqual(['access'])
  })

  it('restates a level-less grant for an operation claiming none', () => {
    const result = consumerRestatement(
      grant({ level: null }),
      'component:default/billing-api',
      undefined,
    )

    expect(result.restates).toBe(true)
    expect(result.restates && result.fields.find(({ field }) => field === 'access')).toEqual({
      field: 'access',
      value: 'none',
    })
  })

  it('never restates a question', () => {
    expect(
      consumerRestatement(grant(), 'component:default/billing-api', { unknown: 'which level?' })
        .restates,
    ).toBe(false)
  })
})
