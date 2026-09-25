import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from '../../src/cli/index.js'
import { runInitPlatform } from '../../src/cli/commands/init.js'
import { runPlan } from '../../src/cli/commands/plan.js'
import { hashTree } from '../support/tree.js'
import type { Ask } from '../../src/cli/commands/plan.js'

const capture = (): { out: string[]; err: string[] } => ({ out: [], err: [] })

/**
 * A run with somebody at the keyboard, answering `read` to the one question a
 * grant now always carries: the level is asked, never read out of the request.
 * `ask` is injected the way `client` is, so the interactive path is exercised
 * with no terminal — and a test that wants a diff has to go through it, which
 * is exactly what a person does.
 */
const run = async (args: string[], ask?: Ask) => {
  const io = capture()
  const code = await main(args, {
    out: (chunk) => void io.out.push(chunk),
    err: (chunk) => void io.err.push(chunk),
    ...(ask === undefined ? {} : { ask }),
  })
  return { code, out: io.out.join(''), err: io.err.join('') }
}

/**
 * Answers the one question a grant now always carries, and declines the rest.
 *
 * A level is asked, never read out of the request, so a fixture that wants a
 * complete plan has to answer for it — which is what a person does. Every
 * other question is left unanswered, so a test about an unvouched owner still
 * tests that.
 */
const answering = (value: string): Ask => async (question) =>
  question.path.endsWith('.access') ? value : undefined
/**
 * A real repository on a real disk, because the guarantee under test is that
 * the bytes on that disk do not move. A fake file system would let the command
 * pass the one check the whole stage exists for.
 */
const scaffoldedRepository = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'idp-plan-'))
  const repo = path.join(root, 'repo')
  await runInitPlatform({ root: repo, owner: '@acme/platform', version: '0.0.0-test' })
  return repo
}

const entityDocument = (
  name: string,
  type: string,
  env: string,
  spec: readonly string[] = [],
): string =>
  [
    '---',
    'apiVersion: backstage.io/v1alpha1',
    'kind: Resource',
    'metadata:',
    `  name: ${name}`,
    '  annotations:',
    `    company.fr/env: ${env}`,
    'spec:',
    `  type: ${type}`,
    '  owner: group:default/tiger',
    ...spec,
    '',
  ].join('\n')

const declare = async (repo: string, file: string, content: string): Promise<void> => {
  const absolute = path.join(repo, ...file.split('/'))
  await mkdir(path.dirname(absolute), { recursive: true })
  await writeFile(absolute, content, 'utf8')
}

/** Written beside the repository, never inside it: a plan is not a declaration. */
const planFile = async (repo: string, plan: unknown): Promise<string> => {
  const file = path.join(path.dirname(repo), 'plan.json')
  await writeFile(file, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
  return file
}

/**
 * Every value is either in the request or already in the repository — which is
 * what a signed plan means. Against a freshly scaffolded repository the
 * vocabulary is empty, so the request has to carry all of it.
 */
const CREATE_INTENT =
  'declare the database orders-db-prod in prod owned by group:default/tiger, then give ' +
  'component:default/billing-api a database-access granting read to resource:default/orders-db-prod'

const createDatabase = {
  op: 'create-entity',
  entity: {
    kind: 'Resource',
    metadata: { name: 'orders-db-prod', env: 'prod' },
    spec: { type: 'database', owner: 'group:default/tiger' },
  },
}

const createAccess = {
  op: 'create-entity',
  entity: {
    kind: 'Resource',
    metadata: { name: 'billing-api-orders-db-prod', env: 'prod' },
    spec: {
      type: 'database-access', access: 'read',
      owner: 'group:default/tiger',
      dependsOn: ['resource:default/orders-db-prod'],
      dependencyOf: ['component:default/billing-api'],
    },
  },
}

const CREATE_PLAN = { intent: CREATE_INTENT, operations: [createDatabase, createAccess] }

const DATABASE_PATH = 'catalog/databases/orders-db-prod.yml'
const ACCESS_PATH = 'dependencies/access/billing-api-orders-db-prod.yml'

const CLOSING = 'Nothing is provisioned yet. The merge is what authorises it.'

describe('plan --from', () => {
  it('leaves the repository byte-identical', async () => {
    // "Preview only — writes nothing" is the whole stage. Not a claim: a hash
    // of every file before and after a full preview.
    const root = await scaffoldedRepository()
    const from = await planFile(root, CREATE_PLAN)
    const before = await hashTree(root)

    const result = await runPlan({ from, repo: root, ask: answering('read') })

    expect(result.found).toBe(true)
    expect(await hashTree(root)).toBe(before)
  })

  it('renders the diff the plan would produce and ends on the line §7.4 requires', async () => {
    const root = await scaffoldedRepository()
    const from = await planFile(root, CREATE_PLAN)

    const { code, out } = await run(['plan', '--from', from, '--repo', root], answering('read'))

    expect(code).toBe(0)
    expect(out).toContain('--- /dev/null')
    expect(out).toContain(`+++ b/${DATABASE_PATH}`)
    expect(out).toContain(`+++ b/${ACCESS_PATH}`)
    expect(out).toContain('+  name: orders-db-prod')
    // No escape code: an injected `out` is a sink, not a terminal.
    expect(out).not.toContain('\u001B[')
    expect(out.trimEnd().endsWith(CLOSING)).toBe(true)
  })

  it('renders an empty diff and exits 0 when the target was declared meanwhile', async () => {
    // The catalogue lags the repository by about two minutes (§4.4). Absent
    // means already done (§4.3): nothing to review, and that is not a failure.
    //
    // The declaration states the SAME level the plan states, which is what
    // makes this already-declared rather than a change: a grant is its level
    // (§4.1), and the file has to say what the plan says.
    const root = await scaffoldedRepository()
    await declare(root, DATABASE_PATH, entityDocument('orders-db-prod', 'database', 'prod'))
    await declare(
      root,
      ACCESS_PATH,
      entityDocument('billing-api-orders-db-prod', 'database-access', 'prod', [
        '  access: read',
        '  dependsOn:',
        '    - resource:default/orders-db-prod',
        '  dependencyOf:',
        '    - component:default/billing-api',
      ]),
    )
    const from = await planFile(root, CREATE_PLAN)
    const before = await hashTree(root)

    const { code, out } = await run(['plan', '--from', from, '--repo', root], answering('read'))

    expect(code).toBe(0)
    expect(out).not.toContain('@@')
    expect(out).not.toContain('+++ b/')
    expect(out).toContain(ACCESS_PATH)
    expect(out).toContain('already declares')
    expect(await hashTree(root)).toBe(before)
  })

  it('refuses rather than report "nothing to change" when the level differs', async () => {
    // The falsehood this closes, end to end. The repository grants readwrite,
    // the plan states read, and the only edit this tool can make is an append
    // — so the run used to print "nothing to change — the repository already
    // says it" and exit 0, about a narrowing that silently did not happen.
    const root = await scaffoldedRepository()
    await declare(root, DATABASE_PATH, entityDocument('orders-db-prod', 'database', 'prod'))
    await declare(
      root,
      ACCESS_PATH,
      entityDocument('billing-api-orders-db-prod', 'database-access', 'prod', [
        '  access: readwrite',
        '  dependsOn:',
        '    - resource:default/orders-db-prod',
        '  dependencyOf:',
        '    - component:default/billing-api',
      ]),
    )
    const from = await planFile(root, CREATE_PLAN)
    const before = await hashTree(root)

    const { code, out } = await run(['plan', '--from', from, '--repo', root], answering('read'))

    expect(code).toBe(1)
    expect(out).toContain('declared-level-mismatch')
    expect(out).toContain('operations.1.entity.spec.access')
    expect(out).toContain('readwrite')
    expect(out).not.toContain('nothing to change')
    expect(out).not.toContain('@@')
    expect(await hashTree(root)).toBe(before)
  })

  it('does not report "nothing to change" for a plan that simply did nothing', async () => {
    // F12's third bullet. A Component is filed in its own repository, so the
    // engine computes no path for one and `planEdits` drops it — leaving an
    // empty diff, which the renderer reported as `nothing to change.` on exit
    // 0. Two opposite facts shared one sentence: the repository already grants
    // what you asked, and this plan grants nothing. The reasons were printed
    // underneath, and a reason printed under a sentence that contradicts it is
    // not saying it.
    const root = await scaffoldedRepository()
    const intent =
      'declare the component billing-api, a service in production owned by group:default/tiger'
    const from = await planFile(root, {
      intent,
      operations: [
        {
          op: 'create-entity',
          entity: {
            kind: 'Component',
            metadata: { name: 'billing-api' },
            spec: {
              type: 'service',
              lifecycle: 'production',
              owner: 'group:default/tiger',
            },
          },
        },
      ],
    })
    const before = await hashTree(root)

    const { code, out } = await run(['plan', '--from', from, '--repo', root])

    expect(code).toBe(3)
    expect(out).toContain('this plan changes nothing')
    expect(out).not.toContain('nothing to change')
    // The reason is still there — this changes which sentence sits above it,
    // never whether it is reported.
    expect(out).toContain('the engine computed no path for it')
    expect(await hashTree(root)).toBe(before)
  })

  it('prints the questions and exits 3, with no diff', async () => {
    // A plan holding an {unknown} cannot be applied, and guessing the owner is
    // precisely what declare-never-infer forbids.
    const root = await scaffoldedRepository()
    const from = await planFile(root, {
      intent: 'declare the database orders-db-prod in prod',
      operations: [createDatabase],
    })

    const before = await hashTree(root)
    const { code, out } = await run(['plan', '--from', from, '--repo', root])

    // Hashed here too. "Writes nothing" is a claim about EVERY outcome, and an
    // assertion that covers only the paths that produce a diff leaves the
    // other ones free to write with the whole suite still green.
    expect(await hashTree(root)).toBe(before)
    expect(code).toBe(3)
    expect(out).toContain('operations.0.entity.spec.owner')
    expect(out).toMatch(/owner/)
    expect(out).not.toContain('@@')
    expect(out).not.toContain(CLOSING)
  })

  it('refuses a plan a policy rejects, and offers no diff', async () => {
    // The design's own example: a name carrying `prod` on a request that named
    // dev. The signature vouches for it — `orders-db-prod` exists — and it is
    // still wrong, which is the gap a policy is for.
    //
    // The request states the owner, and it has to: this grant lists no
    // consumer, so nothing in the plan determines who owns it, and a right's
    // owner nothing determines is withdrawn to a question (`derive.ts`, F2).
    // The question would end the run before the violation was printed —
    // `previewPlan` renders questions ahead of policies — and this test is
    // about the policy gate, not about who owns the access.
    const root = await scaffoldedRepository()
    await declare(root, 'catalog/databases/orders-db-dev.yml', entityDocument('orders-db-dev', 'database', 'dev'))
    await declare(root, DATABASE_PATH, entityDocument('orders-db-prod', 'database', 'prod'))
    const from = await planFile(root, {
      intent:
        'give component:default/billing-api a database-access granting read to orders-db in dev, owned by group:default/tiger',
      operations: [
        {
          op: 'create-entity',
          entity: {
            kind: 'Resource',
            metadata: { name: 'billing-api-orders-db-prod', env: 'dev' },
            spec: {
              type: 'database-access', access: 'read',
              owner: 'group:default/tiger',
              dependsOn: ['resource:default/orders-db-prod'],
              dependencyOf: ['component:default/billing-api'],
            },
          },
        },
      ],
    })
    const before = await hashTree(root)

    const { code, out } = await run(['plan', '--from', from, '--repo', root], answering('read'))

    expect(code).toBe(1)
    expect(out).toContain('environment-mismatch')
    expect(out).not.toContain('@@')
    expect(out).not.toContain(CLOSING)
    expect(await hashTree(root)).toBe(before)
  })

  it('emits the signed plan and the violations for a machine', async () => {
    const root = await scaffoldedRepository()
    const from = await planFile(root, CREATE_PLAN)

    const before = await hashTree(root)
    const { code, out } = await run(['plan', '--from', from, '--repo', root, '--json'], answering('read'))

    expect(await hashTree(root)).toBe(before)
    expect(code).toBe(0)
    const report = JSON.parse(out) as {
      plan: { intent: string; operations: unknown[] }
      signature: { paths: Record<string, string>; classified: unknown[] }
      questions: unknown[]
      policies: unknown[]
      recheck: { outcomes: Record<string, string>; violations: { rule: string }[] }
      files: string[]
      dropped: { opIndex: number; reason: string }[]
    }

    expect(report.plan.intent).toBe(CREATE_INTENT)
    expect(report.plan.operations).toHaveLength(2)
    expect(report.signature.paths['1']).toBe(ACCESS_PATH)
    expect(report.signature.classified.length).toBeGreaterThan(0)
    expect(report.questions).toEqual([])
    expect(report.policies).toEqual([])
    expect(report.recheck.outcomes['0']).toBe('fresh')
    // The Component lives in its own repository, so its reference dangles here
    // — reported, never pruned (§4.4), and never a reason to refuse a preview.
    expect(report.recheck.violations.some((violation) => violation.rule === 'dangling-reference')).toBe(true)
    expect(report.files).toEqual([DATABASE_PATH, ACCESS_PATH])
    // Stated even when empty: a machine reading "nothing to change" has to be
    // able to tell it from "this plan grants nothing".
    expect(report.dropped).toEqual([])
    expect(out).not.toContain(CLOSING)
  })

  it('refuses a plan file that is not a plan, rather than previewing half of it', async () => {
    const root = await scaffoldedRepository()
    const from = await planFile(root, { intent: 'x', operations: [{ op: 'drop-everything' }] })

    const { code, err } = await run(['plan', '--from', from, '--repo', root])

    expect(code).toBe(2)
    expect(err).toContain('operations')
  })

  it('refuses a file that is not JSON', async () => {
    const root = await scaffoldedRepository()
    const from = path.join(path.dirname(root), 'not-json.txt')
    await writeFile(from, 'intent: give access\n', 'utf8')

    const { code, err } = await run(['plan', '--from', from, '--repo', root])

    expect(code).toBe(2)
    expect(err).toMatch(/JSON/i)
  })

  it('refuses an empty --repo rather than previewing against the working directory', async () => {
    // `stat('')` failed, so this was refused before the guard was shared;
    // resolving first would turn it into the directory the run stands in.
    const root = await scaffoldedRepository()
    const from = await planFile(root, CREATE_PLAN)

    const { code, err } = await run(['plan', '--from', from, '--repo='])

    expect(code).toBe(2)
    expect(err).toContain('plan --repo names the declarations repository')
  })

  it('refuses a --repo that is not a directory', async () => {
    const root = await scaffoldedRepository()
    const from = await planFile(root, CREATE_PLAN)

    const { code, err } = await run(['plan', '--from', from, '--repo', path.join(root, 'nowhere')])

    expect(code).toBe(2)
    expect(err).toContain('nowhere')
    // The guard `ask`, `graph` and `show` share, in the same words.
    expect(err).toContain('plan --repo names the declarations repository')
  })

  it('needs something to preview: an intent, or a plan in a file', async () => {
    const { code, err } = await run(['plan', '--repo', '/tmp'])
    expect(code).toBe(2)
    expect(err).toContain('plan needs an intent, or --from <plan.json>')
  })

  it('needs --repo: a preview is decided against the repository, never the catalogue', async () => {
    const { code, err } = await run(['plan', '--from', '/tmp/plan.json'])
    expect(code).toBe(2)
    expect(err).toContain('--repo')
    // And the two ways of configuring one once, so it need not be typed again.
    expect(err).toContain('IDP_REPO')
    expect(err).toContain('idp-agent/config.yml')
  })

  it('refuses an intent AND a file, rather than picking one of them', async () => {
    // Two roads to one renderer, and nothing decides which wins. Silently
    // preferring the file would draft nothing and say nothing about it.
    const { code, err } = await run([
      'plan',
      'give billing-api read access to orders-db',
      '--from',
      '/tmp/plan.json',
      '--repo',
      '/tmp',
    ])
    expect(code).toBe(2)
    expect(err).toContain('never both')
  })
})

describe('plan --from, amending a grant a person wrote by hand', () => {
  // The bug this closes: `appendSequenceItem` found documents by their `---`
  // line and `name:` at exactly two spaces, while `planEdits` had already
  // found the entity with the real parser. So a file the parser read and the
  // surgery could not came back unchanged, and an unchanged file is what "the
  // consumer is already listed" looks like: `nothing to change.`, exit 0, and
  // nobody was granted anything.
  const GRANT_PATH = 'dependencies/access/billing-api-billing-db-prod.yml'
  const REPORTING = 'component:default/reporting-worker'

  const grant = (lines: readonly string[]): string => `${lines.join('\n')}\n`

  const amend = async (content: string) => {
    const root = await scaffoldedRepository()
    await declare(root, GRANT_PATH, content)
    const from = await planFile(root, {
      intent:
        `let ${REPORTING} use resource:default/billing-api-billing-db-prod, ` +
        'the readwrite access to billing-db in prod',
      operations: [
        {
          op: 'update-entity',
          entityRef: 'resource:default/billing-api-billing-db-prod',
          patch: { patch: 'add-dependency-of', consumer: REPORTING, access: 'readwrite' },
        },
      ],
    })
    const before = await hashTree(root)
    const result = await run(['plan', '--from', from, '--repo', root], answering('readwrite'))
    expect(await hashTree(root)).toBe(before)
    return result
  }

  it('amends a grant whose file does not open with ---', async () => {
    const { code, out } = await amend(
      grant([
        'apiVersion: backstage.io/v1alpha1',
        'kind: Resource',
        'metadata:',
        '  name: billing-api-billing-db-prod',
        '  annotations:',
        '    company.fr/env: prod',
        'spec:',
        '  type: database-access',
        '  access: readwrite',
        '  owner: group:default/tiger',
        '  dependsOn:',
        '    - resource:default/billing-db-prod',
        '  dependencyOf:',
        '    - component:default/billing-api',
      ]),
    )

    expect(out).not.toContain('nothing to change')
    expect(code).toBe(0)
    expect(out).toContain(`+++ b/${GRANT_PATH}`)
    expect(out).toContain(`+    - ${REPORTING}`)
    // One line, and only that one: textual surgery, never a reparse (§4.3).
    expect(out.split('\n').filter((line) => /^[+-](?![+-])/.test(line))).toEqual([
      `+    - ${REPORTING}`,
    ])
  })

  it('refuses a shape it cannot amend, and never calls that "nothing to change"', async () => {
    // A flow-mapping spec: the parser reads it, a line edit cannot extend it.
    // Whatever the surgery can or cannot do, the operation is not carried out,
    // and saying so is the only honest answer — exit 3, with the reason.
    const { code, out } = await amend(
      grant([
        '---',
        'apiVersion: backstage.io/v1alpha1',
        'kind: Resource',
        'metadata:',
        '  name: billing-api-billing-db-prod',
        '  annotations:',
        '    company.fr/env: prod',
        'spec: {type: database-access, access: readwrite, owner: group:default/tiger, ' +
          'dependsOn: [resource:default/billing-db-prod], ' +
          'dependencyOf: [component:default/billing-api]}',
      ]),
    )

    expect(code).toBe(3)
    expect(out).toContain('this plan changes nothing, and the repository does not already say it')
    expect(out).not.toContain('nothing to change')
    expect(out).toContain(GRANT_PATH)
    expect(out).not.toContain('@@')
  })
})

describe('plan --from, over a repository it cannot read whole', () => {
  // `readRepository` turns an unreadable file into a rejection, and `plan`
  // then read every file again for its bytes and ended on the raw EACCES.
  // Skipping the file is not the answer: `planEdits` takes a path it holds no
  // bytes for as a file that does not exist, and would preview a creation
  // over one that does. The run is refused, naming the file.
  it.skipIf(process.getuid?.() === 0)('refuses, naming the file it could not read', async () => {
    // Root reads through a mode of 000, so the case cannot be staged as root.
    const root = await scaffoldedRepository()
    const locked = 'catalog/databases/locked.yml'
    await declare(root, locked, entityDocument('locked-db-prod', 'database', 'prod'))
    const from = await planFile(root, CREATE_PLAN)
    // Hashed while readable: the hash reads every file too.
    const before = await hashTree(root)

    await chmod(path.join(root, ...locked.split('/')), 0o000)
    const result = await run(['plan', '--from', from, '--repo', root], answering('read')).finally(
      () => chmod(path.join(root, ...locked.split('/')), 0o600),
    )

    expect(result.code).toBe(2)
    expect(result.out).not.toContain('@@')
    expect(result.err).toContain(locked)
    expect(result.err).toContain('EACCES')
    expect(await hashTree(root)).toBe(before)
  })
})

describe('plan --from, over a repository that was already wrong', () => {
  // The re-check ran the six rules over the whole repository the plan would
  // leave behind and refused on any error in it — so one fault anywhere, a
  // document the reader rejects or a file somebody misfiled, blocked every plan
  // on that repository although the plan touched none of it.
  const LEGACY = 'catalog/databases/legacy.yml'
  const INVALID = ['---', 'apiVersion: backstage.io/v1alpha1', 'kind: Resource', 'metadata:', '  name: legacy', ''].join('\n')

  it('previews a plan beside an error it does not touch, and says the error is there', async () => {
    const root = await scaffoldedRepository()
    await declare(root, LEGACY, INVALID)
    const from = await planFile(root, CREATE_PLAN)
    const before = await hashTree(root)

    const { code, out } = await run(['plan', '--from', from, '--repo', root], answering('read'))

    expect(code).toBe(0)
    expect(out).toContain(`+++ b/${DATABASE_PATH}`)
    // One line, never the list: the list is `validate`'s, and the preview is
    // about the plan.
    expect(out).toContain(
      `1 error already in the repository, in files this plan does not touch — ` +
        `idp-agent validate ${root} lists them`,
    )
    expect(out).not.toContain(LEGACY)
    expect(out.trimEnd().endsWith(CLOSING)).toBe(true)
    expect(await hashTree(root)).toBe(before)
  })

  it('keeps the count apart from the plan’s own warnings', async () => {
    // The scaffold declares no billing-api, so the grant the plan writes names
    // a consumer nothing declares: a warning that IS the plan's. Run on, the
    // count read as one more entry of that list.
    const root = await scaffoldedRepository()
    await declare(root, LEGACY, INVALID)
    const from = await planFile(root, CREATE_PLAN)

    const { code, out } = await run(['plan', '--from', from, '--repo', root], answering('read'))

    expect(code).toBe(0)
    const lines = out.split('\n')
    const count = lines.findIndex((line) => line.startsWith('1 error already in the repository'))
    expect(lines.slice(0, count).some((line) => line.startsWith('warning'))).toBe(true)
    expect(lines[count - 1]).toBe('')
  })

  it('names a validate command that runs as printed when the path has a space', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'idp-plan-'))
    const repo = path.join(root, 'my decls')
    await runInitPlatform({ root: repo, owner: '@acme/platform', version: '0.0.0-test' })
    await declare(repo, LEGACY, INVALID)
    const from = await planFile(repo, CREATE_PLAN)

    const { code, out } = await run(['plan', '--from', from, '--repo', repo], answering('read'))

    expect(code).toBe(0)
    expect(out).toContain(`idp-agent validate '${repo}' lists them`)
  })

  it('says the error is there when the repository already says what the plan says', async () => {
    // The "nothing to change" branch, which a person reaches most often on a
    // real repository — and where CI being red for another reason is news.
    const root = await scaffoldedRepository()
    await declare(root, LEGACY, INVALID)
    await declare(root, DATABASE_PATH, entityDocument('orders-db-prod', 'database', 'prod'))
    await declare(
      root,
      ACCESS_PATH,
      entityDocument('billing-api-orders-db-prod', 'database-access', 'prod', [
        '  access: read',
        '  dependsOn:',
        '    - resource:default/orders-db-prod',
        '  dependencyOf:',
        '    - component:default/billing-api',
      ]),
    )
    const from = await planFile(root, CREATE_PLAN)
    const before = await hashTree(root)

    const { code, out } = await run(['plan', '--from', from, '--repo', root], answering('read'))

    expect(code).toBe(0)
    expect(out).toContain('already declares')
    expect(out).not.toContain('@@')
    const standing = out.split('\n').filter((line) => line.includes('already in the repository'))
    // The scaffold declares no billing-api either, so the grant already in the
    // repository dangles: standing too, and counted apart from the error.
    expect(standing).toEqual([
      `1 error and 1 warning already in the repository, in files this plan does not touch — ` +
        `idp-agent validate ${root} lists them`,
    ])
    expect(out).not.toContain(LEGACY)
    expect(await hashTree(root)).toBe(before)
  })

  it('reports the standing violations apart from the plan’s, for a machine', async () => {
    const root = await scaffoldedRepository()
    await declare(root, LEGACY, INVALID)
    const from = await planFile(root, CREATE_PLAN)

    const { code, out } = await run(['plan', '--from', from, '--repo', root, '--json'], answering('read'))

    expect(code).toBe(0)
    const report = JSON.parse(out) as {
      recheck: { violations: { rule: string; file: string }[]; standing: { rule: string; file: string }[] }
    }
    expect(report.recheck.violations.map((violation) => violation.file)).not.toContain(LEGACY)
    expect(report.recheck.standing.map((violation) => [violation.rule, violation.file])).toEqual([
      ['invalid-entity', LEGACY],
    ])
  })

  it('still refuses a plan that introduces an error, and says it is the plan’s', async () => {
    // The database already declared in a file of its own: creating it at the
    // computed path makes a duplicate, which is the plan's doing.
    const root = await scaffoldedRepository()
    await declare(root, LEGACY, INVALID)
    await declare(
      root,
      'catalog/databases/orders-db-legacy.yml',
      entityDocument('orders-db-prod', 'database', 'prod'),
    )
    const from = await planFile(root, CREATE_PLAN)
    const before = await hashTree(root)

    const { code, out } = await run(['plan', '--from', from, '--repo', root], answering('read'))

    expect(code).toBe(1)
    expect(out).toContain('resource:default/orders-db-prod is declared in')
    expect(out).toContain('this plan introduces')
    // The invalid file stays out of the refusal: it is not what the plan did.
    // It is counted, though — fixing the plan's fault would not make CI green.
    expect(out).not.toContain(`${LEGACY}:`)
    expect(out).toContain('1 error already in the repository, in files this plan does not touch')
    expect(out).not.toContain('@@')
    expect(await hashTree(root)).toBe(before)
  })
})
