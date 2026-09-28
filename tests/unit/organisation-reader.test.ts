import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runValidate } from '../../src/cli/commands/validate.js'
import { readRepository } from '../../src/context/iac-fs/snapshot.js'
import { ORGANISATION_KINDS, organisationSchema } from '../../src/core/schemas/entity.js'
import { checkRepository } from '../../src/core/validate/rules.js'
import { parseDocuments, readValue } from '../../src/core/yaml/serialize.js'

/**
 * Backstage's Group, User, System and Domain, read (docs/plans/backstage-http-slice-3.md,
 * Task 3.1): the read model is wider than the write model, and these four
 * widen it for what it reads of them — a kind, a name, and the references
 * Backstage's processor turns into ownership, membership and system
 * membership — and nothing else. One Backstage would refuse is set aside and
 * said to be, never refused: a Group is usually another team's.
 */

const ORGANISATION = path.resolve(import.meta.dirname, '../golden/organisation')

const GROUP = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Group',
  metadata: { name: 'tiger' },
  spec: { type: 'team', children: [], members: ['ada'] },
}
const USER = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'User',
  metadata: { name: 'ada' },
  spec: { memberOf: ['tiger'] },
}
const SYSTEM = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'System',
  metadata: { name: 'billing' },
  spec: { owner: 'tiger', domain: 'finance' },
}
const DOMAIN = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Domain',
  metadata: { name: 'finance' },
  spec: { owner: 'engineering' },
}

/** A User as Backstage's Microsoft Graph provider writes one: an email and a directory id among its annotations, a profile with a picture. */
const USER_WITH_PROFILE = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'User',
  metadata: {
    name: 'ada.lovelace_acme.example',
    title: 'Ada Lovelace',
    annotations: {
      'microsoft.com/email': 'ada.lovelace@acme.example',
      'graph.microsoft.com/user-id': '0f9d3c1e-user-id',
    },
  },
  spec: {
    profile: {
      displayName: 'Ada Lovelace',
      email: 'ada.lovelace@acme.example',
      picture: 'data:image/png;base64,iVBORw0KGgo=',
    },
    memberOf: ['tiger'],
  },
}

const yaml = (value: object): string => `---\n${JSON.stringify(value)}\n`

describe('the organisation, read for what the read model reads, never proposed', () => {
  it.each([
    ['Group', GROUP, { kind: 'Group', spec: { type: 'team', children: [], members: ['user:default/ada'] } }],
    ['User', USER, { kind: 'User', spec: { memberOf: ['group:default/tiger'] } }],
    [
      'System',
      SYSTEM,
      { kind: 'System', spec: { owner: 'group:default/tiger', domain: 'domain:default/finance' } },
    ],
    ['Domain', DOMAIN, { kind: 'Domain', spec: { owner: 'group:default/engineering' } }],
  ])('reads a %s, its references in full by the processor’s default kinds', (_, value, expected) => {
    expect(readValue(value)).toMatchObject({ as: 'organisation', entity: expected, unread: [] })
  })

  it('reads a parent, a subdomain and a reference that names its kind as the processor does', () => {
    const child = { ...GROUP, spec: { type: 'team', parent: 'engineering', children: ['Group:Tigers-Cubs'] } }
    expect(readValue(child)).toMatchObject({
      entity: { spec: { parent: 'group:default/engineering', children: ['group:default/tigers-cubs'] } },
    })
    const sub = { ...DOMAIN, spec: { owner: 'user:ada', subdomainOf: 'money' } }
    expect(readValue(sub)).toMatchObject({
      entity: { spec: { owner: 'user:default/ada', subdomainOf: 'domain:default/money' } },
    })
  })

  it('reads a short reference in the entity’s own namespace default, as Backstage does: memberOf: [tiger] is group:default/tiger', () => {
    const read = readValue({ ...USER, metadata: { name: 'ada', namespace: 'default' } })
    expect(read).toMatchObject({ as: 'organisation', entity: { spec: { memberOf: ['group:default/tiger'] } } })
    // The namespace is read for that and dropped, as an entity's is.
    expect(read).toMatchObject({ entity: { metadata: { name: 'ada' } } })
    expect(JSON.stringify(read)).not.toContain('namespace')
  })

  it('sets aside, with its ref and the reason in reasonOf’s words, a Group without children, a User without memberOf, a System and a Domain without an owner — never a rejection', () => {
    const refused = [
      [{ ...GROUP, spec: { type: 'team' } }, 'Group tiger is not read: spec.children: required, which Backstage requires'],
      [{ ...USER, spec: {} }, 'User ada is not read: spec.memberOf: required, which Backstage requires'],
      [{ ...SYSTEM, spec: { domain: 'finance' } }, 'System billing is not read: spec.owner: required, which Backstage requires'],
      [{ ...DOMAIN, spec: undefined }, 'Domain finance is not read: spec: required, which Backstage requires'],
    ] as const
    for (const [value, reason] of refused) {
      expect(readValue(value)).toEqual({
        as: 'ignored',
        document: { kind: value.kind, ref: `${value.kind.toLowerCase()}:default/${value.metadata.name}`, reason },
      })
    }
    // A document with no name is set aside too, and names no ref.
    expect(readValue({ ...GROUP, metadata: {} })).toMatchObject({ as: 'ignored', document: { kind: 'Group' } })
    expect(readValue({ ...GROUP, metadata: {} })).not.toHaveProperty('document.ref')
  })

  it('reads backstage.io/v1beta1 for all four, as their schemas allow', () => {
    for (const value of [GROUP, USER, SYSTEM, DOMAIN]) {
      expect(readValue({ ...value, apiVersion: 'backstage.io/v1beta1' })).toMatchObject({ as: 'organisation' })
    }
  })

  it('sets aside a Group of another namespace, of another tool’s apiVersion, or named in upper case — unreadApi’s three reasons', () => {
    expect(readValue({ ...GROUP, metadata: { name: 'tiger', namespace: 'payments' } })).toEqual({
      as: 'ignored',
      document: {
        kind: 'Group',
        ref: 'group:payments/tiger',
        reason: 'namespace payments is not modelled by this tool; group tiger left as is',
      },
    })
    expect(readValue({ ...GROUP, apiVersion: 'acme.io/v1' })).toEqual({
      as: 'ignored',
      document: {
        kind: 'Group',
        ref: 'group:default/tiger',
        reason: "kind Group under acme.io/v1 is not Backstage's; group tiger left as is",
      },
    })
    expect(readValue({ ...GROUP, metadata: { name: 'Tiger' } })).toEqual({
      as: 'ignored',
      document: {
        kind: 'Group',
        ref: 'group:default/tiger',
        reason: 'a name in upper case is not one this tool reads; group Tiger left as is',
      },
    })
  })

  it('names metadata.annotations, metadata.title and spec.profile as not read, and keeps no email, no directory id and no picture anywhere in the reading', () => {
    const read = readValue(USER_WITH_PROFILE)
    expect(read).toMatchObject({
      as: 'organisation',
      unread: ['metadata.annotations', 'metadata.title', 'spec.profile'],
    })
    expect(JSON.stringify(read)).not.toMatch(/@|user-id|data:image|Lovelace/)
  })

  it('still sets a Location, a Template and another tool’s kind aside, as before', () => {
    const aside = (kind: string, apiVersion = 'backstage.io/v1alpha1') =>
      readValue({ apiVersion, kind, metadata: { name: 'x' }, spec: {} })
    expect(aside('Location')).toEqual({
      as: 'ignored',
      document: { kind: 'Location', ref: 'location:default/x', reason: 'kind Location is not modelled by this tool; location x left as is' },
    })
    expect(aside('Template', 'scaffolder.backstage.io/v1beta3')).toMatchObject({ as: 'ignored', document: { kind: 'Template' } })
    expect(aside('Widget', 'acme.io/v1')).toMatchObject({ as: 'ignored', document: { kind: 'Widget' } })
  })

  it('is what parseDocuments folds: organisation beside entities and apis, never among them, and never among rejections', () => {
    const component = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: { name: 'billing-api' },
      spec: { type: 'service', lifecycle: 'production', owner: 'tiger' },
    }
    const read = parseDocuments([component, GROUP, USER, SYSTEM, DOMAIN, { ...GROUP, spec: {} }].map(yaml).join(''))
    expect(read.entities.map((entity) => entity.kind)).toEqual(['Component'])
    expect(read.apis).toEqual([])
    expect(read.organisation.map((node) => node.kind)).toEqual(['Group', 'User', 'System', 'Domain'])
    expect(read.rejections).toEqual([])
    expect(read.ignored.map(({ ref }) => ref)).toEqual(['group:default/tiger'])
  })

  it('reads tests/golden/organisation as its files say: 5 entities, 7 organisation nodes, no rejection, ada’s annotations and profile unread', async () => {
    const { files } = await readRepository(ORGANISATION)
    expect(files.flatMap((file) => file.entities)).toHaveLength(5)
    expect(files.flatMap((file) => file.organisation ?? []).map(({ kind, metadata }) => `${kind} ${metadata.name}`)).toEqual([
      'User ada',
      'System billing',
      'Group common',
      'Group engineering',
      'Domain finance',
      'User grace',
      'Group tiger',
    ])
    expect(files.flatMap((file) => file.rejections)).toEqual([])
    expect(files.flatMap((file) => file.ignored)).toEqual([])
    expect(files.flatMap((file) => file.unread ?? [])).toEqual(['metadata.annotations', 'spec.profile'])
    expect(JSON.stringify(files)).not.toMatch(/@|data:image/)
  })

  it('has one kind per schema, and no proposal schema', () => {
    expect([...ORGANISATION_KINDS]).toEqual(['Group', 'User', 'System', 'Domain'])
    for (const value of [GROUP, USER, SYSTEM, DOMAIN]) expect(organisationSchema.safeParse(value).success).toBe(true)
  })
})

/** A copy of tests/golden/organisation, with `extra` files written over it. */
const copyWith = async (extra: Record<string, string> = {}): Promise<string> => {
  const root = path.join(await mkdtemp(path.join(tmpdir(), 'idp-org-read-')), 'repo')
  await cp(ORGANISATION, root, { recursive: true })
  for (const [relative, text] of Object.entries(extra)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true })
    await writeFile(path.join(root, relative), text, 'utf8')
  }
  return root
}

describe('validate over a repository holding the organisation', () => {
  it('counts the organisation among the entities and warns about none of it', async () => {
    expect((await runValidate(ORGANISATION)).text).toBe('12 entities in 12 files, 0 violations')
  })

  it('warns, never fails, on a Group that Backstage would refuse: not-modelled, its message saying why', async () => {
    const root = await copyWith({ 'org/lonely.yml': yaml({ ...GROUP, metadata: { name: 'lonely' }, spec: { type: 'team' } }) })
    const result = await runValidate(root)
    expect(result.found).toBe(true)
    expect(result.text).toBe(
      [
        'warning org/lonely.yml: Group lonely is not read: spec.children: required, which Backstage requires',
        '',
        '12 entities in 13 files, 0 violations',
      ].join('\n'),
    )
  })

  it('reports nothing for two Groups of one name: no rule reads the organisation', async () => {
    const root = await copyWith({ 'org/tiger-again.yml': yaml(GROUP) })
    expect((await runValidate(root)).text).toBe('13 entities in 13 files, 0 violations')
  })

  it('reports no dangling reference for an owner or a membership naming nothing: the rule reads the write model', async () => {
    // lion and ghost are declared nowhere in tests/golden/organisation.
    const text = await readFile(path.join(ORGANISATION, 'org', 'grace.yml'), 'utf8')
    expect(text).toContain('group:default/ghost')
    expect((await runValidate(ORGANISATION)).text).not.toMatch(/dangling|lion|ghost/)
  })

  it('resolves a dependsOn naming a Group the repository declares, and one naming a System Backstage would refuse, as it resolved them set aside', async () => {
    const root = await copyWith({
      'components/invoicing-worker.yml': [
        '---',
        'apiVersion: backstage.io/v1alpha1',
        'kind: Component',
        'metadata:',
        '  name: invoicing-worker',
        'spec:',
        '  type: service',
        '  lifecycle: production',
        '  owner: group:default/lion',
        '  dependsOn:',
        '    - group:default/tiger',
        '    - system:default/events',
        '',
      ].join('\n'),
      'org/events.yml': yaml({ apiVersion: 'backstage.io/v1alpha1', kind: 'System', metadata: { name: 'events' } }),
    })
    const snapshot = await readRepository(root)
    expect(checkRepository(snapshot)).toEqual([
      {
        rule: 'not-modelled',
        file: 'org/events.yml',
        severity: 'warning',
        message: 'System events is not read: spec: required, which Backstage requires',
      },
    ])
  })
})
