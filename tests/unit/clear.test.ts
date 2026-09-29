import { describe, expect, it } from 'vitest'
import {
  branchFor,
  clearPlan,
  isCleared,
  messageFor,
  SUBMISSION_PREFIX,
  type Cleared,
  type ClearRefusal,
} from '../../src/core/plan/clear.js'
import { namesakesIn, namesakesOf } from '../../src/core/plan/environment.js'
import type { PolicyContext } from '../../src/core/plan/policies.js'
import { nothingStated, type Provenance } from '../../src/core/plan/provenance.js'
import { signPlan, type SignatureContext } from '../../src/core/plan/sign.js'
import { planSchema } from '../../src/core/schemas/plan.js'
import type { Nature } from '../../src/core/schemas/resource-types.js'
import { repositoryFileOf, type RepositorySnapshot } from '../../src/core/validate/rules.js'
import { saidInFull, userSaid } from '../support/provenance.js'

const vocabulary = {
  kinds: ['Component', 'Resource'],
  types: ['database', 'database-access', 'cache', 'api', 'service'],
  environments: ['dev', 'staging', 'prod'],
  owners: ['group:default/tiger'],
}

const signature: SignatureContext = {
  witnessed: new Set(['component:default/billing-api', 'resource:default/nowhere-prod']),
  vocabulary,
  repoRoot: '/repo',
  declared: new Map(),
}

const policy: PolicyContext = {
  vocabulary,
  witnesses: new Set(['catalog/databases', 'dependencies/access']),
  environments: new Map(),
  levels: new Map(),
  natures: new Map(),
  over: new Map(),
  namesakes: namesakesOf([]),
}

/** A freshly scaffolded repository: folders and witnesses, no entity. */
const empty: RepositorySnapshot = {
  folders: ['catalog', 'catalog/databases', 'dependencies', 'dependencies/access'],
  witnesses: ['catalog/databases', 'dependencies/access'],
  files: [],
}

const INTENT =
  'declare the database orders-db-prod in prod owned by group:default/tiger, then give ' +
  'component:default/billing-api a database-access granting read to resource:default/orders-db-prod'

const DATABASE = {
  op: 'create-entity',
  entity: {
    kind: 'Resource',
    metadata: { name: 'orders-db-prod', env: 'prod' },
    spec: { type: 'database', owner: 'group:default/tiger' },
  },
}

const ACCESS = {
  op: 'create-entity',
  entity: {
    kind: 'Resource',
    metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
    spec: {
      type: 'database-access',
      access: 'read',
      owner: 'group:default/tiger',
      dependsOn: ['resource:default/orders-db-prod'],
      dependencyOf: ['component:default/billing-api'],
    },
  },
}

const DATABASE_PATH = 'catalog/databases/orders-db-prod.yml'
const ACCESS_PATH = 'dependencies/access/billing-api-orders-db-prod.yml'

/** Signed as a person who said it all: the level and each environment answered at their paths. */
const sign = (
  intent: string,
  operations: unknown[],
  said: (plan: ReturnType<typeof planSchema.parse>) => Provenance = saidInFull,
  context: SignatureContext = signature,
) => {
  const plan = planSchema.parse({ intent, operations })
  const result = signPlan(plan, context, said(plan))
  if ('outcome' in result) throw new Error(JSON.stringify(result.refusals))
  return result
}

const input = { policy, snapshot: empty, contents: new Map<string, string>() }

const cleared = (result: Cleared | ClearRefusal): Cleared => {
  if ('outcome' in result) throw new Error(result.reasons.join('\n'))
  return result
}

const refusal = (result: Cleared | ClearRefusal): readonly string[] =>
  'outcome' in result ? result.reasons : []

describe('clearPlan', () => {
  it('clears a plan every free gate passes, keeping only the edits that change a byte', () => {
    const result = cleared(clearPlan(sign(INTENT, [DATABASE, ACCESS]), input))

    expect(result.edits.map((edit) => edit.path)).toEqual([DATABASE_PATH, ACCESS_PATH])
    expect(result.repository).toBe('declarations')
    expect(result.expected.scope).toBe('catalogue')
    // A created file is expected ABSENT at the base: one that appeared
    // meanwhile is a divergence, never something to merge into.
    expect([...result.expected.files]).toEqual([
      [DATABASE_PATH, undefined],
      [ACCESS_PATH, undefined],
    ])
    expect(result.branch).toMatch(/^idp-agent\/orders-db-prod-[0-9a-f]{8}$/)
    // Written by the engine from the operations, never from the request (D18).
    expect(result.message.split('\n')[0]).toBe(
      'idp-agent: declare orders-db-prod, declare billing-api-orders-db-prod',
    )
  })

  it('refuses a plan that still asks a question', () => {
    // An owner nobody vouches for is a question (§5.4), and a question is not
    // a value a branch can carry.
    const ghost = {
      ...DATABASE,
      entity: { ...DATABASE.entity, spec: { type: 'database', owner: 'group:default/ghost' } },
    }
    const reasons = refusal(clearPlan(sign(INTENT, [ghost]), input))
    expect(reasons.join('\n')).toContain('operations.0.entity.spec.owner')
  })

  it('refuses a policy violation, re-run here rather than taken on trust', () => {
    const reasons = refusal(
      clearPlan(sign(INTENT, [DATABASE]), {
        ...input,
        policy: { ...policy, witnesses: new Set<string>() },
      }),
    )
    expect(reasons.join('\n')).toContain('unwitnessed-folder')
  })

  it('refuses a plan part of which would not land — a branch carries all of it or nothing', () => {
    // Measured: no policy fires on an update aimed at a grant declared
    // nowhere, and planEdits drops it. The preview lists the drop and exits 0;
    // a branch holding the database without the grant is the "grants nothing"
    // state the audit spent a round closing.
    const update = {
      op: 'update-entity',
      entityRef: 'resource:default/nowhere-prod',
      patch: { patch: 'add-dependency-of', consumer: 'component:default/billing-api', access: 'read' },
    }
    const reasons = refusal(
      clearPlan(sign(`${INTENT} and resource:default/nowhere-prod`, [DATABASE, update]), input),
    )
    expect(reasons.join('\n')).toContain('operations.1')
    expect(reasons.join('\n')).toContain('the whole plan or nothing')
  })

  it('clears a plan the repository already states, with no edit to carry', () => {
    const first = cleared(clearPlan(sign(INTENT, [DATABASE]), input))
    const onDisk = new Map(first.edits.map((edit) => [edit.path, edit.after] as const))
    const snapshot: RepositorySnapshot = {
      ...empty,
      files: [
        {
          path: DATABASE_PATH,
          entities: [
            {
              apiVersion: 'backstage.io/v1alpha1',
              kind: 'Resource',
              metadata: {
                name: 'orders-db-prod',
                annotations: { 'company.fr/env': 'prod' },
              },
              spec: { type: 'database', owner: 'group:default/tiger' },
            },
          ],
          apis: [],
          rejections: [],
          ignored: [],
          documents: 1,
        },
      ],
    } as RepositorySnapshot
    const again = cleared(clearPlan(sign(INTENT, [DATABASE]), { ...input, snapshot, contents: onDisk }))
    expect(again.edits).toEqual([])
  })

  it('is frozen, and its maps refuse to change', () => {
    const result = cleared(clearPlan(sign(INTENT, [DATABASE, ACCESS]), input))
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.edits)).toBe(true)
    expect(() => (result.expected.files as Map<string, string>).set('x.yml', 'x')).toThrow(TypeError)
  })

  it('holds its expectation past a borrowed Map method, and stays the value it minted', () => {
    // `isCleared` checks identity, never contents, and the expectation is what
    // a forge proves the base against: a copy of Map's own method reaches a
    // Map's internal slots past any shadow on the instance, so there must be
    // none to reach.
    const result = cleared(clearPlan(sign(INTENT, [DATABASE, ACCESS]), input))
    const files = result.expected.files as Map<string, string | undefined>
    expect(() => Map.prototype.delete.call(files, DATABASE_PATH)).toThrow(TypeError)
    expect(() => Map.prototype.set.call(files, ACCESS_PATH, 'anything')).toThrow(TypeError)
    expect(() => Map.prototype.clear.call(files)).toThrow(TypeError)
    expect(isCleared(result)).toBe(true)
    expect([...result.expected.files]).toEqual([
      [DATABASE_PATH, undefined],
      [ACCESS_PATH, undefined],
    ])
  })

  it('cannot be written by hand', () => {
    // @ts-expect-error a Cleared is minted by clear.ts or not at all
    const forged: Cleared = { edits: [], expected: { files: new Map(), scope: 'touched' }, branch: 'main', message: '', repository: 'declarations' }
    expect(forged.branch).toBe('main')
  })
})

describe('clearPlan, against the provenance the plan was signed with (D1)', () => {
  it('binds that provenance to the signature, sealed', () => {
    const plan = planSchema.parse({ intent: INTENT, operations: [DATABASE, ACCESS] })
    const said = saidInFull(plan)
    const signed = signPlan(plan, signature, said)
    if ('outcome' in signed) throw new Error(JSON.stringify(signed.refusals))

    expect(signed.provenance.intent).toBe(INTENT)
    expect(signed.provenance.wordsOf).toBe('user')
    expect([...signed.provenance.answers]).toEqual([...said.answers])
    // A copy: what the caller holds afterwards is no longer what was signed.
    expect(signed.provenance.answers).not.toBe(said.answers)
    expect(Object.isFrozen(signed.provenance)).toBe(true)
    expect(() =>
      (signed.provenance.answers as Map<string, string>).set('operations.1.entity.spec.access', 'readwrite'),
    ).toThrow(TypeError)
  })

  it('takes no provenance from its caller', () => {
    const signed = sign(INTENT, [DATABASE, ACCESS])
    // @ts-expect-error the provenance comes with the signature, never beside it
    const result = clearPlan(signed, { ...input, provenance: nothingStated() })
    expect(isCleared(result)).toBe(true)
  })

  it('clears a grant whose level was answered, and refuses the same plan nobody answered', () => {
    expect(isCleared(clearPlan(sign(INTENT, [DATABASE, ACCESS]), input))).toBe(true)

    // Signed under nothing stated, the level is vouched for by nobody: only an
    // answer at its path can, never a word of the request.
    const reasons = refusal(clearPlan(sign(INTENT, [DATABASE, ACCESS], nothingStated), input))
    expect(reasons.join('\n')).toContain('operations.1.entity.spec.access')
  })
})

/**
 * A repository that declares a prod database and orders-api's read grant over
 * it, and the contexts `contextsOf` would build from those bytes — by hand,
 * because `core/` cannot call `cli/`.
 */
const GRANT = 'resource:default/orders-api-orders-db-prod'
const GRANT_PATH = 'dependencies/access/orders-api-orders-db-prod.yml'
const DB = 'resource:default/orders-db-prod'
const BILLING = 'component:default/billing-api'

const grantFile = (consumers: readonly string[], level = 'read'): string =>
  [
    '---',
    'apiVersion: backstage.io/v1alpha1',
    'kind: Resource',
    'metadata:',
    '  name: orders-api-orders-db-prod',
    '  annotations:',
    '    company.fr/env: prod',
    'spec:',
    '  type: database-access',
    `  access: ${level}`,
    '  owner: group:default/tiger',
    '  dependsOn:',
    `    - ${DB}`,
    '  dependencyOf:',
    ...consumers.map((consumer) => `    - ${consumer}`),
    '',
  ].join('\n')

const DATABASE_FILE = [
  '---',
  'apiVersion: backstage.io/v1alpha1',
  'kind: Resource',
  'metadata:',
  '  name: orders-db-prod',
  '  annotations:',
  '    company.fr/env: prod',
  'spec:',
  '  type: database',
  '  owner: group:default/tiger',
  '',
].join('\n')

/** `level` is the one the grant's bytes declare: the context must say what the file says. */
const declaring = (files: Record<string, string>, level: 'read' | 'readwrite' = 'read') => {
  const contents = new Map(Object.entries(files))
  const snapshot: RepositorySnapshot = {
    ...empty,
    files: [...contents].map(([file, text]) => repositoryFileOf(file, text)),
  }
  const withGrant: PolicyContext = {
    ...policy,
    environments: new Map([
      [GRANT, 'prod'],
      [DB, 'prod'],
    ]),
    levels: new Map([
      [GRANT, level],
      [DB, undefined],
    ]),
    natures: new Map<string, Nature>([
      [GRANT, 'right'],
      [DB, 'object'],
    ]),
    over: new Map([[GRANT, [DB]]]),
    namesakes: namesakesIn(contents.values()),
  }
  return { policy: withGrant, snapshot, contents }
}

const JOIN = {
  op: 'update-entity',
  entityRef: GRANT,
  patch: { patch: 'add-dependency-of', consumer: BILLING, access: 'read' },
}

/** Names the grant, never what it is over: nothing points at an environment. */
const JOIN_INTENT = `give ${BILLING} read on orders-api-orders-db-prod`

const updating = {
  ...signature,
  witnessed: new Set([GRANT, DB, BILLING]),
  environments: new Map([
    [GRANT, 'prod'],
    [DB, 'prod'],
  ]),
}

describe('clearPlan, asking what the preview asks', () => {
  it("refuses an update whose grant's environment nobody answered (core-plan-3)", () => {
    // `questionsOf(plan)` alone never raises it: the implied question needs
    // the natures to know the target is a right. The preview asks it, so a
    // clearance that did not would clear what the preview stopped on.
    const repository = declaring({ [DATABASE_PATH]: DATABASE_FILE, [GRANT_PATH]: grantFile(['component:default/orders-api']) })
    const levelOnly = (plan: ReturnType<typeof planSchema.parse>) =>
      userSaid(plan.intent, { 'operations.0.patch.access': 'read' })

    const reasons = refusal(clearPlan(sign(JOIN_INTENT, [JOIN], levelOnly, updating), repository))
    expect(reasons.join('\n')).toContain('operations.0.environment')

    const answered = (plan: ReturnType<typeof planSchema.parse>) =>
      userSaid(plan.intent, {
        'operations.0.patch.access': 'read',
        'operations.0.environment': 'prod',
      })
    const result = cleared(clearPlan(sign(JOIN_INTENT, [JOIN], answered, updating), repository))
    expect(result.edits.map((edit) => edit.path)).toEqual([GRANT_PATH])
    expect(result.edits[0]?.after).toContain(`    - ${BILLING}`)
    // The file an update amends is judged present, with the bytes it had.
    expect(result.expected.files.get(GRANT_PATH)).toBe(grantFile(['component:default/orders-api']))
    // Named after what it amends, never a new file's name (D18).
    expect(result.message.split('\n')[0]).toBe('idp-agent: add billing-api to orders-api-orders-db-prod')
    expect(result.message).toContain(`~ ${GRANT_PATH}`)
    expect(result.branch).toMatch(/^idp-agent\/orders-api-orders-db-prod-[0-9a-f]{8}$/)
  })
})

describe('clearPlan, never minting a change nobody carried out', () => {
  const answered = (plan: ReturnType<typeof planSchema.parse>) =>
    userSaid(plan.intent, {
      'operations.0.patch.access': 'read',
      'operations.0.environment': 'prod',
    })

  it('refuses an update whose consumer the grant already lists, at a level it does not grant', () => {
    // No byte would change and the repository does not say it: never an empty
    // Cleared the forge would report as unchanged on exit 0. With a context
    // that says what the bytes say, the policy refuses it first — as the
    // preview does (clear-parity) — and the drop behind it is never reached;
    // the drop alone is the nowhere-prod case above.
    const repository = declaring(
      {
        [DATABASE_PATH]: DATABASE_FILE,
        [GRANT_PATH]: grantFile(['component:default/orders-api', BILLING], 'readwrite'),
      },
      'readwrite',
    )
    const result = clearPlan(sign(JOIN_INTENT, [JOIN], answered, updating), repository)
    expect(isCleared(result)).toBe(false)
    expect(refusal(result).join('\n')).toContain('declared-level-mismatch at operations.0')
  })

  it('refuses an empty change the repository does not already account for (#83)', () => {
    // The database is declared twice, identically: at the path the engine
    // computes, and first in another file. `planEdits` finds the computed
    // path already saying it — no byte changes — while the re-check resolves
    // the reference to its FIRST declaration, elsewhere: `moved`, not
    // `already-declared`. Exit 0 would say the repository already said it.
    const bytes = cleared(clearPlan(sign(INTENT, [DATABASE]), input)).edits[0]?.after ?? ''
    const contents = new Map([
      ['catalog/databases/a-copy.yml', bytes],
      [DATABASE_PATH, bytes],
    ])
    const snapshot: RepositorySnapshot = {
      ...empty,
      files: [...contents].map(([file, text]) => repositoryFileOf(file, text)),
    }
    const reasons = refusal(clearPlan(sign(INTENT, [DATABASE]), { ...input, snapshot, contents }))
    expect(reasons.join('\n')).toContain(
      'operations.0 produced no change, and the repository does not already say it',
    )
  })

  it('clears an update the repository already says, with no edit to carry', () => {
    const repository = declaring({
      [DATABASE_PATH]: DATABASE_FILE,
      [GRANT_PATH]: grantFile(['component:default/orders-api', BILLING]),
    })
    const result = cleared(clearPlan(sign(JOIN_INTENT, [JOIN], answered, updating), repository))
    expect(result.edits).toEqual([])
  })
})

describe('clearPlan, over the names the repository chose', () => {
  it('refuses an update whose file name holds a line break or a bidi control', () => {
    // An update is written where the repository declares it, and that name is
    // the repository's, not the engine's: `isCataloguePath` accepts anything
    // ending in `.yml`. Carried, it would be a tree entry nobody can read and
    // a line of the commit body — here, a forged trailer.
    const hostile = 'dependencies/access/x\nCo-authored-by: Mallory <m@x>\u202E.yml'
    const answered = (plan: ReturnType<typeof planSchema.parse>) =>
      userSaid(plan.intent, {
        'operations.0.patch.access': 'read',
        'operations.0.environment': 'prod',
      })
    // Filed where its annotation says, so validate calls it placed (§4.3): the
    // name reaches the edit through a declaration every rule accepts.
    const annotated = grantFile(['component:default/orders-api']).replace(
      '    company.fr/env: prod\n',
      `    company.fr/env: prod\n    idp-agent.dev/source-file: ${JSON.stringify(hostile)}\n`,
    )
    const repository = declaring({ [DATABASE_PATH]: DATABASE_FILE, [hostile]: annotated })

    const result = clearPlan(sign(JOIN_INTENT, [JOIN], answered, updating), repository)
    expect(isCleared(result)).toBe(false)
    const reasons = refusal(result)
    expect(reasons).toEqual([
      'dependencies/access/x\\u{A}Co-authored-by: Mallory <m@x>\\u{202E}.yml is a file name holding ' +
        'a control or bidi character; a branch will not carry it — rename the file in the repository first',
    ])
  })
})

describe('clearPlan, over one reading of the bytes', () => {
  it('refuses a snapshot that could not be read whole', () => {
    const reasons = refusal(
      clearPlan(sign(INTENT, [DATABASE]), {
        ...input,
        snapshot: { ...empty, unreadable: [{ path: 'catalog', reason: 'EACCES' }] },
      }),
    )
    expect(reasons).toEqual(['catalog could not be read: EACCES'])
  })

  it('refuses a file the snapshot lists and the bytes do not hold', () => {
    const snapshot: RepositorySnapshot = {
      ...empty,
      files: [repositoryFileOf(DATABASE_PATH, DATABASE_FILE)],
    }
    const reasons = refusal(clearPlan(sign(INTENT, [DATABASE]), { ...input, snapshot }))
    expect(reasons).toEqual([
      `${DATABASE_PATH} changed between two reads of the repository; run this again`,
    ])
  })

  it('refuses bytes for a file the snapshot never listed', () => {
    // Nothing in it a gate would refuse: the disagreement alone is the reason.
    const contents = new Map([['catalog/databases/notes.yml', '# notes\n']])
    const reasons = refusal(clearPlan(sign(INTENT, [DATABASE]), { ...input, contents }))
    expect(reasons).toEqual([
      'catalog/databases/notes.yml changed between two reads of the repository; run this again',
    ])
  })
})

describe('clearPlan, re-checking the bytes it would carry', () => {
  /** orders-db-prod, declared under another file name — a copy the plan would duplicate. */
  const COPY = 'catalog/databases/a-copy.yml'
  const copyOf = (name: string) => DATABASE_FILE.replace('name: orders-db-prod', `name: ${name}`)

  it('refuses bytes the re-check refuses, when no policy does (gate 5)', () => {
    // The hand-built context knows nothing of the copy, so every policy
    // passes; only the re-check over the bytes finds two declarations.
    const contents = new Map([[COPY, DATABASE_FILE]])
    const snapshot: RepositorySnapshot = {
      ...empty,
      files: [...contents].map(([file, text]) => repositoryFileOf(file, text)),
    }
    const result = clearPlan(sign(INTENT, [DATABASE]), { ...input, snapshot, contents })
    expect(isCleared(result)).toBe(false)
    expect(refusal(result).join('\n')).toContain('duplicate-name')
  })

  it('judges the bytes it was given, not the snapshot parsed from an earlier read', () => {
    // The snapshot was parsed when the copy declared another database; the
    // bytes now declare orders-db-prod. The forge proves these bytes, so the
    // re-check must judge them — the earlier parse would clear the duplicate.
    const contents = new Map([[COPY, DATABASE_FILE]])
    const snapshot: RepositorySnapshot = {
      ...empty,
      files: [repositoryFileOf(COPY, copyOf('reports-db-prod'))],
    }
    const result = clearPlan(sign(INTENT, [DATABASE]), { ...input, snapshot, contents })
    expect(isCleared(result)).toBe(false)
    expect(refusal(result).join('\n')).toContain('duplicate-name')
  })
})

describe('clearPlan, for one repository (D6)', () => {
  it('refuses a plan that also writes into the service repository, by name', () => {
    const catalogInfo = {
      op: 'create-catalog-info',
      repoPath: 'catalog-info.yaml',
      entity: {
        kind: 'Component',
        metadata: { name: 'billing-api' },
        spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
      },
    }
    const reasons = refusal(
      clearPlan(sign(`${INTENT}, and billing-api as a production service in catalog-info.yaml`, [DATABASE, catalogInfo]), input),
    )
    expect(reasons.join('\n')).toContain('operations.1')
    expect(reasons.join('\n')).toContain('init --submit')
    expect(reasons.join('\n')).not.toContain('produced no change')
  })
})

describe('isCleared, the runtime brand (D3)', () => {
  it('knows the value clear.ts minted, and nothing shaped like it', () => {
    const result = cleared(clearPlan(sign(INTENT, [DATABASE, ACCESS]), input))
    expect(isCleared(result)).toBe(true)
    expect(isCleared({ ...result })).toBe(false)
    expect(isCleared(structuredClone(result))).toBe(false)
    const forged = { edits: [], expected: { files: new Map(), scope: 'touched' }, branch: 'main', message: '', repository: 'declarations' }
    expect(isCleared(forged)).toBe(false)
    expect(isCleared(undefined)).toBe(false)
  })
})

describe('messageFor (D18)', () => {
  // U+202E reorders what follows it on a terminal; U+009B is a C1 control a
  // terminal reads as the start of an escape.
  const HOSTILE = `declare orders-db-prod\u202E in prod\u009B[2J owned by group:default/tiger`
  const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202A-\u202E\u2066-\u2069]/
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
  const plan = (intent: string) => planSchema.parse({ intent, operations: [DATABASE, ACCESS] })
  const created = [
    { path: DATABASE_PATH, before: undefined, after: 'a\n' },
    { path: ACCESS_PATH, before: undefined, after: 'b\n' },
  ]

  it("writes the subject from the operations, and carries the request in the body as recorded", () => {
    const message = messageFor(plan(HOSTILE), created)
    const lines = message.split('\n')
    expect(lines[0]).toBe('idp-agent: declare orders-db-prod, declare billing-api-orders-db-prod')
    expect(message).toContain(`+ ${DATABASE_PATH}`)
    expect(message).toContain('as recorded')
    for (const line of lines) expect(line).not.toMatch(UNSAFE)
  })

  it('shows a file name as escapes, so a name cannot add a line or reorder one', () => {
    // `clearPlan` refuses such a name; `messageFor` is exported, and holds the
    // line anyway.
    const hostile = 'dependencies/access/x\nCo-authored-by: Mallory <m@x>\u202E\u009B.yml'
    const message = messageFor(plan(INTENT), [{ path: hostile, before: 'a\n', after: 'b\n' }])
    const lines = message.split('\n')
    for (const line of lines) expect(line).not.toMatch(UNSAFE)
    expect(lines.some((line) => line.trim().startsWith('Co-authored-by'))).toBe(false)
    expect(message).toContain('~ dependencies/access/x\\u{A}Co-authored-by: Mallory <m@x>\\u{202E}\\u{9B}.yml')
  })

  it('cuts a long request at a code point, in a script written without spaces', () => {
    // 600 characters outside the Basic Multilingual Plane: two UTF-16 units
    // each, so a cut by unit lands inside a pair half the time.
    const long = '𠮷'.repeat(600)
    const message = messageFor(plan(long), created)
    const recorded = message.split('\n').find((line) => line.includes('𠮷')) ?? ''
    expect(recorded.endsWith('…')).toBe(true)
    expect([...recorded.trim()]).toHaveLength(500)
    expect(message).not.toMatch(LONE_SURROGATE)
  })
})

describe('branchFor', () => {
  const edit = (path: string, after: string) => ({ path, before: undefined, after })

  it('names a branch by its bytes, whatever order the edits came in', () => {
    const a = edit('catalog/databases/a.yml', 'a\n')
    const b = edit('dependencies/access/b.yml', 'b\n')
    expect(branchFor([a, b])).toBe(branchFor([b, a]))
    expect(branchFor([a, b])).not.toBe(branchFor([a, edit('dependencies/access/b.yml', 'c\n')]))
  })

  it('never produces a ref git refuses, whatever the entity is called', () => {
    // `orders..db` is a legal entity name and an illegal ref component.
    const name = branchFor([edit('catalog/databases/orders..db.lock.yml', 'x\n')])
    expect(name.startsWith(SUBMISSION_PREFIX)).toBe(true)
    expect(name).toMatch(/^idp-agent\/[a-z0-9][a-z0-9-]*-[0-9a-f]{8}$/)
    expect(name).not.toContain('..')
  })
})
