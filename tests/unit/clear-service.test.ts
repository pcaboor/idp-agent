import { describe, expect, it } from 'vitest'
import { clearService, isCleared, type Cleared, type ClearRefusal } from '../../src/core/plan/clear.js'
import { CATALOG_INFO } from '../../src/core/plan/catalog-info.js'
import type { Provenance } from '../../src/core/plan/provenance.js'
import { signPlan } from '../../src/core/plan/sign.js'
import { CONFIG_FILE, serializeConfig } from '../../src/core/schemas/config.js'
import { planSchema } from '../../src/core/schemas/plan.js'

const COMPONENT = {
  op: 'create-entity',
  entity: {
    kind: 'Component',
    metadata: { name: 'billing-api' },
    spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
  },
}

/**
 * What `init` signs: an engine-composed request, which vouches for nothing,
 * and what the inspection read, at the fields it read it for (`inspected`).
 */
const said: Provenance = {
  intent: 'declare this repository in the catalogue',
  wordsOf: 'engine',
  answers: new Map([
    ['operations.0.entity.metadata.name', 'billing-api'],
    ['operations.0.entity.spec.type', 'service'],
    ['operations.0.entity.spec.lifecycle', 'production'],
    ['operations.0.entity.spec.owner', 'group:default/tiger'],
  ]),
}

const signed = () => {
  const result = signPlan(
    planSchema.parse({ intent: said.intent, operations: [COMPONENT] }),
    {
      witnessed: new Set(),
      vocabulary: { kinds: [], types: [], environments: [], owners: [] },
      repoRoot: '/service',
      declared: new Map(),
    },
    said,
  )
  if ('outcome' in result) throw new Error(JSON.stringify(result.refusals))
  return result
}

const CONFIG = { iacRepo: 'github.com/acme/iac', environments: ['dev', 'staging', 'prod'] }
const NONE = { target: CATALOG_INFO, kept: [], existing: undefined, config: undefined }

const cleared = (result: Cleared | ClearRefusal): Cleared => {
  if ('outcome' in result) throw new Error(result.reasons.join('\n'))
  return result
}

describe('clearService', () => {
  it('carries the catalog-info and the configuration, for the service repository', () => {
    const result = cleared(clearService(signed(), { ...NONE, config: CONFIG }))
    expect(isCleared(result)).toBe(true)
    expect(result.repository).toBe('service')
    expect(result.edits.map((edit) => edit.path)).toEqual([CONFIG_FILE, CATALOG_INFO])
    expect(result.edits[0]?.after).toBe(serializeConfig(CONFIG))
    expect(result.edits[1]?.after).toContain('name: billing-api')
    expect(result.expected.scope).toBe('touched')
    expect([...result.expected.files].sort()).toEqual([
      [CONFIG_FILE, undefined],
      [CATALOG_INFO, undefined],
    ])
    expect(result.branch).toMatch(/^idp-agent\/init-billing-api-[0-9a-f]{8}$/)
  })

  it('files in the root .yml the service keeps, never a twin beside it', () => {
    // #82: the file init previews is `targetOf`'s, and its `before` is the file
    // read whole. A clearance that took the root .yaml alone filed a second one.
    const yml = { path: 'catalog-info.yml', text: 'apiVersion: backstage.io/v1alpha1\nkind: API\nmetadata:\n  name: billing\n' }
    const result = cleared(clearService(signed(), { ...NONE, target: yml.path, kept: [yml] }))
    expect(result.edits.map((edit) => edit.path)).toEqual(['catalog-info.yml'])
    expect(result.edits[0]?.before).toBe(yml.text)
    expect(result.expected.files.get('catalog-info.yml')).toBe(yml.text)
    expect(result.expected.files.has(CATALOG_INFO)).toBe(false)
  })

  it('files in the one catalog-info the service keeps elsewhere', () => {
    const nested = { path: 'deploy/catalog-info.yaml', text: '# nothing yet\n' }
    const result = cleared(clearService(signed(), { ...NONE, target: nested.path, kept: [nested] }))
    expect(result.edits.map((edit) => edit.path)).toEqual([nested.path])
  })

  it('proves every declaration it read, not only the one it writes', () => {
    // The "already declared" and name decisions read every kept file: a base
    // where one of them changed is a base those decisions never saw.
    const a = { path: 'services/a/catalog-info.yaml', text: '# a\n' }
    const b = { path: 'services/b/catalog-info.yaml', text: '# b\n' }
    const result = cleared(clearService(signed(), { ...NONE, kept: [a, b] }))
    expect(result.expected.files.get(a.path)).toBe(a.text)
    expect(result.expected.files.get(b.path)).toBe(b.text)
    expect(result.expected.files.get(CATALOG_INFO)).toBeUndefined()
    expect(result.expected.files.get(CONFIG_FILE)).toBeUndefined()
  })

  it('writes no configuration when nobody typed one', () => {
    const result = cleared(clearService(signed(), NONE))
    expect(result.edits.map((edit) => edit.path)).toEqual([CATALOG_INFO])
  })

  it('leaves a committed configuration alone when it says the same, however it is written', () => {
    // Hand-written, unquoted — the shape `plan-intent.test.ts`'s CONFIGURED
    // fixture has, and the one a person types. Byte comparison refused it.
    const existing = {
      text: 'iacRepo: github.com/acme/iac\nenvironments: [dev, staging, prod]\n',
      config: CONFIG,
    }
    const result = cleared(clearService(signed(), { ...NONE, existing, config: CONFIG }))
    expect(result.edits.map((edit) => edit.path)).toEqual([CATALOG_INFO])
    expect(result.expected.files.get(CONFIG_FILE)).toBe(existing.text)
  })

  it('never rewrites a committed configuration that says something else', () => {
    // It seeds the vocabulary every gate measures against (§7.0), and it was
    // merged by someone. Changing it is a reviewed edit made by hand.
    const result = clearService(signed(), {
      ...NONE,
      existing: {
        text: 'iacRepo: github.com/other/iac\nenvironments: [prod]\n',
        config: { iacRepo: 'github.com/other/iac', environments: ['prod'] },
      },
      config: CONFIG,
    })
    expect('outcome' in result && result.reasons.join('\n')).toContain(CONFIG_FILE)
  })

  it('refuses a configuration the reader would refuse, rather than throwing it', () => {
    // What a person typed: a flag left empty is a refusal to show them, never
    // an uncaught ZodError that exits 1 as a failure nobody expected.
    const result = clearService(signed(), { ...NONE, config: { iacRepo: '', environments: [] } })
    expect('outcome' in result && result.reasons).toEqual([
      expect.stringMatching(new RegExp(`^\\${CONFIG_FILE}: .*iacRepo`)),
    ])
  })

  it('refuses a configuration value holding a control, format or bidi character', () => {
    // The file seeds every gate's vocabulary and is committed: an invisible
    // direction override in it is one a reviewer reads the wrong way round.
    for (const config of [
      { iacRepo: 'github.com/acme/iac\u202E', environments: ['prod'] },
      { iacRepo: 'github.com/acme/iac', environments: ['prod\u2066'] },
      { iacRepo: '\uFEFFgithub.com/acme/iac', environments: ['prod'] },
      { iacRepo: 'github.com/acme/iac', environments: ['dev\u2028prod'] },
    ]) {
      const result = clearService(signed(), { ...NONE, config })
      expect('outcome' in result && result.reasons.join('\n')).toContain(
        `${CONFIG_FILE}: a value holds a control, format or bidi character`,
      )
    }
  })

  it('refuses a plan with a question left, whatever the caller checked', () => {
    // D1: the provenance sealed in the signed plan is re-read at the moment of
    // acting. An owner nothing vouches for is a question, and a question is
    // never a branch — even from a caller that forgot to ask it.
    const answers = new Map(said.answers)
    answers.delete('operations.0.entity.spec.owner')
    const plan = planSchema.parse({ intent: said.intent, operations: [COMPONENT] })
    const result = signPlan(plan, { witnessed: new Set(), vocabulary: { kinds: [], types: [], environments: [], owners: [] }, repoRoot: '/service', declared: new Map() }, { ...said, answers })
    if ('outcome' in result) throw new Error(JSON.stringify(result.refusals))
    const refusal = clearService(result, NONE)
    expect('outcome' in refusal && refusal.reasons).toEqual([
      'operations.0.entity.spec.owner: still a question',
    ])
  })

  it('refuses a target outside the repository, or in a hidden folder', () => {
    // The target is the caller's; the plan schema decides where a catalog-info
    // may be filed, and the minted plan crosses it again here.
    for (const target of ['../catalog-info.yaml', '.github/catalog-info.yaml']) {
      const result = clearService(signed(), { ...NONE, target })
      expect('outcome' in result && result.reasons.join('\n')).toContain('the composed plan is not a plan')
    }
  })

  it('refuses a kept file that swallows what is appended to it, never "already declared"', () => {
    // A document appended after an open quoted scalar is part of that scalar:
    // the file changes and declares nothing. Zero edits would read as a
    // Component already there — a branch, or an exit 0, for a plan that
    // declared nothing (#83).
    const open = { path: CATALOG_INFO, text: 'description: "open\n' }
    const result = clearService(signed(), { ...NONE, kept: [open] })
    expect('outcome' in result && result.reasons.join('\n')).toContain('the edit did not declare it')
  })

  it('carries a Component already declared as no edit at all', () => {
    const own = {
      path: CATALOG_INFO,
      text: 'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: billing-api\nspec:\n  type: service\n  lifecycle: production\n  owner: group:default/tiger\n',
    }
    const result = cleared(clearService(signed(), { ...NONE, kept: [own] }))
    expect(result.edits).toEqual([])
  })

  it('refuses a plan carrying anything but the service’s Component', () => {
    // A right has no place in a service's repository; the preview never shows
    // one there, so a clearance must not either.
    const grant = {
      op: 'update-entity',
      entityRef: 'resource:default/orders-db-prod',
      patch: { patch: 'add-dependency-of', consumer: 'component:default/billing-api', access: 'read' },
    }
    const plan = planSchema.parse({ intent: said.intent, operations: [COMPONENT, grant] })
    const result = signPlan(plan, { witnessed: new Set(), vocabulary: { kinds: [], types: [], environments: [], owners: [] }, repoRoot: '/service', declared: new Map() }, said)
    if ('outcome' in result) return // refused at the signature is a refusal too
    expect('outcome' in clearService(result, NONE)).toBe(true)
  })

  it('refuses it by name when every value in it is vouched for', () => {
    // The case above stops on its questions; this one has none left, so what
    // refuses it is the rule itself — a service's clearance carries its
    // Component and nothing else, never a grant filed nowhere.
    const grant = {
      op: 'update-entity',
      entityRef: 'resource:default/orders-db-prod',
      patch: { patch: 'add-dependency-of', consumer: 'component:default/billing-api', access: 'read' },
    }
    const vouched: Provenance = {
      ...said,
      answers: new Map([
        ...said.answers,
        ['operations.1.entityRef', grant.entityRef],
        ['operations.1.patch.consumer', grant.patch.consumer],
        ['operations.1.patch.access', grant.patch.access],
      ]),
    }
    const plan = planSchema.parse({ intent: said.intent, operations: [COMPONENT, grant] })
    const result = signPlan(plan, { witnessed: new Set(), vocabulary: { kinds: [], types: [], environments: [], owners: [] }, repoRoot: '/service', declared: new Map() }, vouched)
    if ('outcome' in result) throw new Error(JSON.stringify(result.refusals))
    const refusal = clearService(result, NONE)
    expect('outcome' in refusal && refusal.reasons).toEqual([
      "operations.1 is not this service's Component; init --submit writes nothing else",
    ])
  })
})
