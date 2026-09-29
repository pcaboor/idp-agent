import { describe, expect, it } from 'vitest'
import {
  CATALOG_INFO,
  catalogInfoEdits,
  isSetAside,
  targetOf,
} from '../../src/core/plan/catalog-info.js'
import type { Plan } from '../../src/core/schemas/plan.js'

/**
 * Where `init` files a service's Component, and the bytes it leaves there —
 * the functions the preview and the clearance share (stage 5, task 2), so the
 * file a branch carries is the file the preview showed.
 */

const componentOf = (name: string, repoPath = CATALOG_INFO) => ({
  op: 'create-catalog-info' as const,
  repoPath,
  entity: {
    kind: 'Component' as const,
    metadata: { name },
    spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
  },
})

const planOf = (...operations: unknown[]): Plan =>
  ({ intent: 'declare this service', operations }) as unknown as Plan

const API = 'apiVersion: backstage.io/v1alpha1\nkind: API\nmetadata:\n  name: billing\n'

const OWN = [
  'apiVersion: backstage.io/v1alpha1',
  'kind: Component',
  'metadata:',
  '  name: billing-api',
  'spec:',
  '  type: service',
  '  lifecycle: production',
  '  owner: group:default/tiger',
  '',
].join('\n')

describe('targetOf', () => {
  it('is a new root catalog-info.yaml when the service keeps none', () => {
    expect(targetOf([])).toBe(CATALOG_INFO)
  })

  it('is the root .yml the service keeps', () => {
    expect(targetOf([{ path: 'catalog-info.yml' }])).toBe('catalog-info.yml')
  })

  it('is the one catalog-info the service keeps elsewhere', () => {
    expect(targetOf([{ path: 'services/billing/catalog-info.yaml' }])).toBe(
      'services/billing/catalog-info.yaml',
    )
  })

  it('is a new root file when two are kept elsewhere and none at the root', () => {
    // A monorepo's: each folder's own, and none of them is this one.
    expect(
      targetOf([
        { path: 'services/a/catalog-info.yaml' },
        { path: 'services/b/catalog-info.yaml' },
      ]),
    ).toBe(CATALOG_INFO)
  })

  it('is a new root file when the only one kept is a workspace’s', () => {
    expect(targetOf([{ path: 'packages/web/catalog-info.yaml', workspace: 'packages/web' }])).toBe(
      CATALOG_INFO,
    )
  })
})

describe('isSetAside', () => {
  it('sets aside an example’s and a test’s catalog-info', () => {
    expect(isSetAside('examples/catalog-info.yaml')).toBe(true)
    expect(isSetAside('src/__tests__/catalog-info.yaml')).toBe(true)
  })

  it('keeps the root’s', () => {
    expect(isSetAside('catalog-info.yaml')).toBe(false)
  })
})

describe('catalogInfoEdits', () => {
  it('appends a document to the root .yml the service keeps, before its bytes', () => {
    const { edits, dropped } = catalogInfoEdits(planOf(componentOf('billing-api', 'catalog-info.yml')), {
      files: [{ path: 'catalog-info.yml', text: API }],
    })
    expect(dropped).toEqual([])
    expect(edits).toHaveLength(1)
    expect(edits[0]?.path).toBe('catalog-info.yml')
    expect(edits[0]?.before).toBe(API)
    expect(edits[0]?.after.startsWith(API)).toBe(true)
    expect(edits[0]?.after).toContain('name: billing-api')
  })

  it('leaves a file already declaring the Component as it is', () => {
    const { edits, dropped } = catalogInfoEdits(planOf(componentOf('billing-api')), {
      files: [{ path: CATALOG_INFO, text: OWN }],
    })
    expect(dropped).toEqual([])
    expect(edits).toEqual([{ path: CATALOG_INFO, before: OWN, after: OWN }])
  })

  it('reports an operation whose entity does not materialise, never skipping it in silence', () => {
    // #45: a caller printing a diff must be able to say "this plan declares
    // nothing" rather than "nothing to change".
    const question = {
      ...componentOf('billing-api'),
      entity: {
        ...componentOf('billing-api').entity,
        spec: { type: 'service', lifecycle: 'production', owner: { unknown: 'which team?' } },
      },
    }
    const { edits, dropped } = catalogInfoEdits(planOf(question), { files: [] })
    expect(edits).toEqual([])
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.opIndex).toBe(0)
    expect(dropped[0]?.reason).toMatch(/materialised/)
  })

  it('reports an edit that does not declare the Component it was for', () => {
    // An open quoted scalar swallows the document appended after it: the
    // bytes change, and nothing in them declares billing-api. The effect check
    // `planEdits` has (#45), which `init` skipped.
    const broken = 'description: "a line nobody closed\n'
    const { edits, dropped } = catalogInfoEdits(planOf(componentOf('billing-api')), {
      files: [{ path: CATALOG_INFO, text: broken }],
    })
    // No bytes for a drop, as `planEdits` leaves none: a preview must not show
    // a hunk for a declaration it then says was not made.
    expect(edits).toEqual([])
    expect(dropped).toEqual([
      { opIndex: 0, reason: `${CATALOG_INFO}: the edit did not declare it` },
    ])
  })
})
