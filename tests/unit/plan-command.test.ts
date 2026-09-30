import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterAll, describe, expect, it } from 'vitest'
import { confirmOnTerminal, InterruptedError, main } from '../../src/cli/index.js'
import { runInitPlatform } from '../../src/cli/commands/init.js'
import { runPlan } from '../../src/cli/commands/plan.js'
import type { Confirm, SubmissionSummary } from '../../src/cli/commands/submit.js'
import { renderUnifiedDiff } from '../../src/core/diff/unified.js'
import { GitError } from '../../src/process/git.js'
import { hashTree } from '../support/tree.js'
import type { Ask } from '../../src/cli/commands/plan.js'
import { confirmingEnvironment } from '../support/ask.js'
import { committed, git, observable, show, stored } from '../support/git.js'

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
 * complete plan has to answer for it — which is what a person does. So is an
 * environment nobody pointed at, and it is confirmed as the draft proposed it
 * (`confirmingEnvironment`). Every other question is left unanswered, so a
 * test about an unvouched owner still tests that.
 */
const answering = (value: string): Ask => async (question) =>
  question.path.endsWith('.access') ? value : confirmingEnvironment(question)
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

  // A link was read through twice, for its entities and for its bytes, so the
  // preview judged and diffed a file that is not in the repository, and only
  // the submission refused it (gap-stage5-readiness-4, D17). Refused here too,
  // by name, before anything it leads to is read. Windows gives a symbolic
  // link to an administrator or to developer mode alone, so the runner may
  // not be able to make one: skipped there, by this condition.
  it.skipIf(process.platform === 'win32')('refuses a file that is a symbolic link, naming it, and reads nothing through it', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'idp-plan-outside-'))
    await writeFile(
      path.join(outside, 'planted.yml'),
      entityDocument('planted-db-prod', 'database', 'prod', ['  # PLANTED-OUTSIDE']),
    )
    const root = await scaffoldedRepository()
    const linked = 'catalog/databases/planted-db-prod.yml'
    await symlink(path.join(outside, 'planted.yml'), path.join(root, ...linked.split('/')))
    const from = await planFile(root, CREATE_PLAN)

    const result = await run(['plan', '--from', from, '--repo', root], answering('read'))

    expect(result.code).toBe(2)
    expect(result.out).not.toContain('@@')
    expect(result.err).toContain(`${linked} is a symbolic link, never followed`)
    expect(result.out + result.err).not.toContain('PLANTED-OUTSIDE')
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

/**
 * Review priority 8, end to end: the tool never says, on exit 0, that an
 * access already exists when it does not. "Already declared" compared the
 * level alone, so each of these ended on "nothing to change — the repository
 * already says it" about an access nobody had; and an update that DID find
 * its access already there said a bare "nothing to change." and named nothing.
 */
describe('plan --from, what the repository already says', () => {
  const GRANT = 'resource:default/billing-api-orders-db-prod'

  const grantDocument = (
    { owner = 'group:default/tiger', consumer = 'component:default/billing-api' } = {},
  ): string =>
    entityDocument('billing-api-orders-db-prod', 'database-access', 'prod', [
      '  access: read',
      '  dependsOn:',
      '    - resource:default/orders-db-prod',
      '  dependencyOf:',
      `    - ${consumer}`,
    ]).replace('owner: group:default/tiger', `owner: ${owner}`)

  const withGrant = async (content: string): Promise<string> => {
    const root = await scaffoldedRepository()
    await declare(root, DATABASE_PATH, entityDocument('orders-db-prod', 'database', 'prod'))
    await declare(root, ACCESS_PATH, content)
    return root
  }

  const preview = async (root: string, plan: unknown) => {
    const from = await planFile(root, plan)
    const before = await hashTree(root)
    const result = await run(['plan', '--from', from, '--repo', root], answering('read'))
    expect(await hashTree(root)).toBe(before)
    return result
  }

  it('refuses a creation restating a grant another consumer holds, at the same level', async () => {
    const root = await withGrant(grantDocument({ consumer: 'component:default/orders-api' }))

    const { code, out } = await preview(root, {
      intent: CREATE_INTENT,
      operations: [createAccess],
    })

    expect(code).toBe(1)
    expect(out).toContain('declared-otherwise')
    expect(out).toContain('component:default/billing-api')
    expect(out).not.toContain('nothing to change')
    expect(out).not.toContain('@@')
  })

  it('refuses a creation restating a grant another team owns', async () => {
    const root = await withGrant(grantDocument({ owner: 'group:default/lion' }))

    const { code, out } = await preview(root, {
      intent: CREATE_INTENT,
      operations: [createAccess],
    })

    expect(code).toBe(1)
    expect(out).toContain('declared-otherwise')
    expect(out).toContain('group:default/lion')
    expect(out).not.toContain('nothing to change')
  })

  it('names the file and the fields it matched when a creation restates the grant', async () => {
    const root = await withGrant(grantDocument())

    const { code, out } = await preview(root, {
      intent: CREATE_INTENT,
      operations: [createAccess],
    })

    expect(code).toBe(0)
    expect(out).toContain('nothing to change — the repository already says it:')
    expect(out).toContain(`= ${ACCESS_PATH} already declares ${GRANT}`)
    for (const field of [
      'type: database-access',
      'company.fr/env: prod',
      'access: read',
      'owner: group:default/tiger',
      'dependsOn: resource:default/orders-db-prod',
      'dependencyOf: component:default/billing-api',
    ]) {
      expect(out).toContain(field)
    }
  })

  it('reports an update adding a consumer already there as already declared, naming it', async () => {
    // The `link-already-declared` shape. It printed "nothing to change." on
    // exit 0 and named no file: an update was never compared at all.
    const root = await withGrant(grantDocument())

    const { code, out } = await preview(root, {
      intent: `let component:default/billing-api read ${GRANT}`,
      operations: [
        {
          op: 'update-entity',
          entityRef: GRANT,
          patch: {
            patch: 'add-dependency-of',
            consumer: 'component:default/billing-api',
            access: 'read',
          },
        },
      ],
    })

    expect(code).toBe(0)
    expect(out).toContain('nothing to change — the repository already says it:')
    expect(out).toContain(`= ${ACCESS_PATH} already declares ${GRANT}`)
    expect(out).toContain('dependencyOf: component:default/billing-api')
    expect(out).toContain('access: read')
    expect(out).toContain('company.fr/env: prod')
  })

  it('names a restated operation beside the diff of one that is not', async () => {
    // The database is declared as the plan says; the access is not. The diff
    // shows the access, and the database is named rather than left out.
    const root = await scaffoldedRepository()
    await declare(root, DATABASE_PATH, entityDocument('orders-db-prod', 'database', 'prod'))

    const { code, out } = await preview(root, CREATE_PLAN)

    expect(code).toBe(0)
    expect(out).toContain(`+++ b/${ACCESS_PATH}`)
    expect(out).toContain('1 operation the repository already says:')
    expect(out).toContain(`= ${DATABASE_PATH} already declares resource:default/orders-db-prod`)
  })

  it('never exits 0 on an empty diff the re-check did not find already declared', async () => {
    // Declared twice, and the catalogue reads the first (§4.4), which is not
    // where the plan computed. The bytes at the computed path restate the
    // plan, so the diff is empty — and nothing was dropped, which used to be
    // enough for exit 0 and "nothing to change".
    const root = await withGrant(grantDocument())
    await declare(root, 'dependencies/access/aaa-first.yml', grantDocument())

    const { code, out } = await preview(root, { intent: CREATE_INTENT, operations: [createAccess] })

    expect(code).toBe(3)
    expect(out).not.toContain('nothing to change')
    expect(out).toContain('operations.0 — names an entity the repository declares in another file')
  })

  it('names what the grant an update extends is over, so one over another thing can be seen', async () => {
    // The request is for orders-db-prod; the draft extends a grant over
    // payments-db-prod that already lists billing-api. That access exists, so
    // the update is already declared — but it printed the consumer, the level
    // and the environment alone, and nothing a reader could tell it by.
    const root = await withGrant(grantDocument({ consumer: 'component:default/orders-api' }))
    await declare(
      root,
      'catalog/databases/payments-db-prod.yml',
      entityDocument('payments-db-prod', 'database', 'prod'),
    )
    await declare(
      root,
      'dependencies/access/billing-api-payments-db-prod.yml',
      entityDocument('billing-api-payments-db-prod', 'database-access', 'prod', [
        '  access: read',
        '  dependsOn:',
        '    - resource:default/payments-db-prod',
        '  dependencyOf:',
        '    - component:default/billing-api',
      ]),
    )

    const { out } = await preview(root, {
      intent: `give component:default/billing-api read access to resource:default/orders-db-prod`,
      operations: [
        {
          op: 'update-entity',
          entityRef: 'resource:default/billing-api-payments-db-prod',
          patch: {
            patch: 'add-dependency-of',
            consumer: 'component:default/billing-api',
            access: 'read',
          },
        },
      ],
    })

    expect(out).toContain(
      '= dependencies/access/billing-api-payments-db-prod.yml already declares ' +
        'resource:default/billing-api-payments-db-prod',
    )
    expect(out).toContain('dependsOn: resource:default/payments-db-prod')
    expect(out).toContain('type: database-access')
    expect(out).toContain('owner: group:default/tiger')
  })

  it('hands a machine what it hands a person: the file and the fields, under recheck.restated', async () => {
    const root = await withGrant(grantDocument())
    const from = await planFile(root, {
      intent: `let component:default/billing-api read ${GRANT}`,
      operations: [
        {
          op: 'update-entity',
          entityRef: GRANT,
          patch: {
            patch: 'add-dependency-of',
            consumer: 'component:default/billing-api',
            access: 'read',
          },
        },
      ],
    })

    const { code, out } = await run(
      ['plan', '--from', from, '--repo', root, '--json'],
      answering('read'),
    )

    expect(code).toBe(0)
    const report = JSON.parse(out) as {
      recheck: {
        outcomes: Record<string, string>
        restated: Record<string, { path: string; ref: string; fields: unknown[] }>
      }
    }
    expect(report.recheck.outcomes['0']).toBe('already-declared')
    expect(report.recheck.restated['0']?.path).toBe(ACCESS_PATH)
    expect(report.recheck.restated['0']?.ref).toBe(GRANT)
    expect(report.recheck.restated['0']?.fields).toEqual(
      expect.arrayContaining([
        { field: 'dependencyOf', value: 'component:default/billing-api' },
        { field: 'access', value: 'read' },
        { field: 'company.fr/env', value: 'prod' },
        { field: 'dependsOn', value: 'resource:default/orders-db-prod' },
      ]),
    )
  })

  it('exits with the same code in --json as in prose when the diff is empty', async () => {
    // Exit 0 on an empty diff means the repository already declares every
    // operation (AGENTS.md). The prose said 3 for these and --json said 0: a
    // script reading the status alone took a run that did nothing for done.
    const duplicated = await withGrant(grantDocument())
    await declare(duplicated, 'dependencies/access/aaa-first.yml', grantDocument())
    const moved = { intent: CREATE_INTENT, operations: [createAccess] }

    const nowhere = await withGrant(grantDocument())
    const unresolved = {
      intent: 'let component:default/billing-api depend on component:default/orders-api',
      operations: [
        {
          op: 'update-entity',
          entityRef: 'resource:default/declared-nowhere',
          patch: {
            patch: 'add-dependency-of',
            consumer: 'component:default/billing-api',
            access: 'read',
          },
        },
      ],
    }

    for (const [root, plan] of [
      [duplicated, moved],
      [nowhere, unresolved],
    ] as const) {
      const from = await planFile(root, plan)
      const prose = await run(['plan', '--from', from, '--repo', root], answering('read'))
      const json = await run(['plan', '--from', from, '--repo', root, '--json'], answering('read'))

      expect(prose.code).toBe(3)
      expect(json.code).toBe(prose.code)
    }
  })

  it('refuses two operations aimed at one entity, naming both', async () => {
    const root = await scaffoldedRepository()
    await declare(root, DATABASE_PATH, entityDocument('orders-db-prod', 'database', 'prod'))
    const second = {
      op: 'update-entity',
      entityRef: GRANT,
      patch: {
        patch: 'add-dependency-of',
        consumer: 'component:default/billing-api',
        access: 'read',
      },
    }

    const { code, out } = await preview(root, {
      intent: CREATE_INTENT,
      operations: [createAccess, second],
    })

    expect(code).toBe(1)
    expect(out).toContain('same-reference-twice')
    expect(out).toContain('operations.0')
    expect(out).toContain('operations.1')
    expect(out).not.toContain('@@')
  })
})

/**
 * Every temporary directory the submission suites below made, removed in
 * `afterAll`: each is a real git repository, and a test run's leftovers fill a
 * small disk.
 */
const clones: string[] = []

afterAll(async () => {
  await Promise.all(clones.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A scratch directory that is no repository at all, removed with the clones. */
const nowhere = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'idp-nowhere-'))
  clones.push(dir)
  return dir
}

const runWith = async (
  args: string[],
  deps: { ask?: Ask; confirm?: Confirm; cwd?: string; env?: NodeJS.ProcessEnv } = {},
) => {
  const io = capture()
  const code = await main(args, {
    out: (chunk) => void io.out.push(chunk),
    err: (chunk) => void io.err.push(chunk),
    ...deps,
  })
  return { code, out: io.out.join(''), err: io.err.join('') }
}

/** The declarations repository as a clone: scaffolded, committed on main. */
const clonedRepository = async (): Promise<string> => {
  const repo = await scaffoldedRepository()
  clones.push(path.dirname(repo))
  await committed(repo)
  return repo
}

const branches = async (repo: string): Promise<string[]> =>
  (await git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/idp-agent/'))
    .split('\n')
    .filter((line) => line !== '')

/**
 * No personal file and no IDP_REPO from the developer's shell: the chain is
 * read from what the test names, and nothing else.
 */
const isolated = async (extra: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> => {
  const home = await nowhere()
  return { HOME: home, XDG_CONFIG_HOME: home, ...extra }
}

describe('plan --from --submit', () => {
  it('cuts one branch holding exactly the diff it printed, and leaves main alone', async () => {
    const repo = await clonedRepository()
    const from = await planFile(repo, CREATE_PLAN)
    const main0 = await git(repo, 'rev-parse', 'main')
    const before = await observable(repo)

    const { code, out } = await runWith(['plan', '--from', from, '--repo', repo, '--submit'], {
      ask: answering('read'),
    })

    expect(code).toBe(0)
    expect(out).toMatch(
      /2 files · submitted as idp-agent\/orders-db-prod-[0-9a-f]{8} on top of main@[0-9a-f]{7} · main untouched/,
    )
    expect(out).toContain('Nothing is pushed. No merge request is opened: this build has no forge (stage 6).')
    expect(out.trimEnd().endsWith(CLOSING)).toBe(true)
    expect(await git(repo, 'rev-parse', 'main')).toBe(main0)
    const [branch] = await branches(repo)
    expect(branch).toBeDefined()
    // The branch's diff, rendered by the same renderer, is IN what was printed:
    // what the person read is what was submitted.
    const fromGit = await Promise.all(
      [DATABASE_PATH, ACCESS_PATH].map(async (file) => ({
        path: file,
        before: undefined,
        after: await show(repo, branch ?? '', file),
      })),
    )
    expect(out).toContain(renderUnifiedDiff(fromGit).trimEnd())
    // And the only change a person can see is that one branch.
    const added = (await observable(repo))
      .split('\n')
      .filter((line) => !before.split('\n').includes(line))
    expect(added).toHaveLength(1)
  })

  it('still writes nothing — .git included — without --submit', async () => {
    // Stage 4's guarantee, over a clone this time: the hash covers .git/.
    const repo = await clonedRepository()
    const from = await planFile(repo, CREATE_PLAN)
    const before = await hashTree(repo)
    const { code } = await runWith(['plan', '--from', from, '--repo', repo], { ask: answering('read') })
    expect(code).toBe(0)
    expect(await hashTree(repo)).toBe(before)
  })

  it('prints the same preview over a clone as over a plain directory, byte for byte', async () => {
    // Without --submit nothing about git is read: the stage-4 output, CLOSING
    // included, whether or not the directory happens to be a clone.
    const plain = await scaffoldedRepository()
    clones.push(path.dirname(plain))
    const repo = await clonedRepository()
    const plainRun = await runWith(['plan', '--from', await planFile(plain, CREATE_PLAN), '--repo', plain], {
      ask: answering('read'),
    })
    const cloneRun = await runWith(['plan', '--from', await planFile(repo, CREATE_PLAN), '--repo', repo], {
      ask: answering('read'),
    })
    expect(cloneRun.code).toBe(0)
    expect(cloneRun.out).toBe(plainRun.out)
    expect(cloneRun.out).toContain('2 files · nothing written')
    expect(cloneRun.out.trimEnd().endsWith(CLOSING)).toBe(true)
  })

  it('submitting twice names the branch it already cut, and writes nothing', async () => {
    const repo = await clonedRepository()
    const from = await planFile(repo, CREATE_PLAN)
    const args = ['plan', '--from', from, '--repo', repo, '--submit']
    await runWith(args, { ask: answering('read') })
    const between = await observable(repo)

    const { code, out } = await runWith(args, { ask: answering('read') })

    expect(code).toBe(0)
    expect(out).toMatch(/already submitted as idp-agent\/orders-db-prod-[0-9a-f]{8} · nothing written/)
    expect(await observable(repo)).toBe(between)
  })

  it('answers a second submission before the confirmation: the level asked, no [y/N], nothing written', async () => {
    // The owner's report, 2026-09-29: the level question, the diff, [y/N], and
    // only then "already submitted". The level stays — it decides the bytes,
    // hence the branch — and the forge's read-only look answers the rest.
    const repo = await clonedRepository()
    const from = await planFile(repo, CREATE_PLAN)
    const args = ['plan', '--from', from, '--repo', repo, '--submit']
    await runWith(args, { ask: answering('read'), confirm: async () => true })
    const [seen, objects] = [await observable(repo), await stored(repo)]
    const asked: string[] = []
    const confirmed: SubmissionSummary[] = []

    const { code, out } = await runWith(args, {
      ask: async (question) => {
        asked.push(question.path)
        return answering('read')(question)
      },
      confirm: async (summary) => {
        confirmed.push(summary)
        return true
      },
    })

    expect(code).toBe(0)
    expect(asked.some((one) => one.endsWith('.access'))).toBe(true)
    expect(confirmed).toEqual([])
    expect(out).toMatch(/^2 files · already submitted as idp-agent\/orders-db-prod-[0-9a-f]{8} · nothing written$/m)
    // What a prompt would have printed is not printed instead of it.
    expect(out).not.toContain('+++ b/')
    expect(await observable(repo)).toBe(seen)
    expect(await stored(repo)).toBe(objects)
  })

  it("refuses a branch of that name that is someone else's before the confirmation", async () => {
    const repo = await clonedRepository()
    const from = await planFile(repo, CREATE_PLAN)
    const args = ['plan', '--from', from, '--repo', repo, '--submit']
    // Declined once, to learn the name without writing it; then squatted.
    let branch = ''
    await runWith(args, {
      ask: answering('read'),
      confirm: async (summary) => {
        branch = summary.branch
        return false
      },
    })
    await git(repo, 'update-ref', `refs/heads/${branch}`, 'HEAD')
    const [seen, objects] = [await observable(repo), await stored(repo)]
    let prompted = false

    const { code, out } = await runWith(args, {
      ask: answering('read'),
      confirm: async () => {
        prompted = true
        return true
      },
    })

    expect(code).toBe(1)
    expect(prompted).toBe(false)
    expect(out).toContain(`${branch} already exists and carries a different change`)
    expect(out).toContain('Nothing was written.')
    expect(await observable(repo)).toBe(seen)
    expect(await stored(repo)).toBe(objects)
  })

  it('shows the diff before asking, and prints it once', async () => {
    const repo = await clonedRepository()
    const from = await planFile(repo, CREATE_PLAN)
    const shown: SubmissionSummary[] = []
    const confirm: Confirm = async (summary) => {
      shown.push(summary)
      return true
    }

    const { code, out } = await runWith(['plan', '--from', from, '--repo', repo, '--submit'], {
      ask: answering('read'),
      confirm,
    })

    expect(code).toBe(0)
    // Structured (D5): what a TUI needs, without parsing the text.
    expect(shown).toHaveLength(1)
    expect(shown[0]?.files).toEqual([
      { path: DATABASE_PATH, change: 'create' },
      { path: ACCESS_PATH, change: 'create' },
    ])
    expect(shown[0]?.branch).toMatch(/^idp-agent\/orders-db-prod-[0-9a-f]{8}$/)
    expect(shown[0]?.repository).toBe('declarations')
    expect(shown[0]?.root).toBe(repo)
    expect(shown[0]?.base.branch).toBe('main')
    expect(shown[0]?.base.commit).toBe(await git(repo, 'rev-parse', 'main'))
    expect(shown[0]?.preview).toContain(`+++ b/${DATABASE_PATH}`)
    expect(shown[0]?.preview).toContain('not yet submitted')
    // The prompt printed the diff; the result must not print it a second time.
    expect(out).not.toContain('+++ b/')
    expect(out).toContain('submitted as idp-agent/')
  })

  it('declined at the prompt: exit 0, not submitted, nothing written', async () => {
    const repo = await clonedRepository()
    const from = await planFile(repo, CREATE_PLAN)
    const before = await observable(repo)

    const { code, out } = await runWith(['plan', '--from', from, '--repo', repo, '--submit'], {
      ask: answering('read'),
      confirm: async () => false,
    })

    expect(code).toBe(0)
    expect(out).toContain('not submitted · nothing written')
    expect(await observable(repo)).toBe(before)
  })

  it('interrupted at the prompt: exit 130, nothing written', async () => {
    const repo = await clonedRepository()
    const from = await planFile(repo, CREATE_PLAN)
    const before = await observable(repo)

    const { code, err } = await runWith(['plan', '--from', from, '--repo', repo, '--submit'], {
      ask: answering('read'),
      confirm: async () => {
        throw new InterruptedError()
      },
    })

    expect(code).toBe(130)
    expect(err).toContain('interrupted; nothing was written')
    expect(await observable(repo)).toBe(before)
  })

  it('refuses a --repo that is not a clone, with the argument-error code', async () => {
    const repo = await scaffoldedRepository()
    clones.push(path.dirname(repo))
    const from = await planFile(repo, CREATE_PLAN)
    const before = await hashTree(repo)
    const { code, err } = await runWith(['plan', '--from', from, '--repo', repo, '--submit'])
    expect(code).toBe(2)
    expect(err).toContain('not a git working tree')
    expect(await hashTree(repo)).toBe(before)
  })

  it('refuses a folder of a clone, where the branch would be cut in the parent', async () => {
    const outer = await nowhere()
    const repo = path.join(outer, 'iac')
    await runInitPlatform({ root: repo, owner: '@acme/platform', version: '0.0.0-test' })
    await committed(outer)
    const from = path.join(await nowhere(), 'plan.json')
    await writeFile(from, `${JSON.stringify(CREATE_PLAN)}\n`, 'utf8')

    const { code, err } = await runWith(['plan', '--from', from, '--repo', repo, '--submit'], {
      ask: answering('read'),
    })

    expect(code).toBe(2)
    expect(err).toContain('not at its root')
    expect(await branches(outer)).toEqual([])
  })

  it('refuses a repository whose working tree is not HEAD, before previewing', async () => {
    const repo = await clonedRepository()
    await declare(repo, 'catalog/databases/stray.yml', '# stray\n')
    const from = await planFile(repo, CREATE_PLAN)
    const before = await observable(repo)

    const { code, out } = await runWith(['plan', '--from', from, '--repo', repo, '--submit'], {
      ask: answering('read'),
    })

    expect(code).toBe(1)
    expect(out).toContain('stray.yml')
    expect(out).not.toContain('+++ b/')
    expect(await observable(repo)).toBe(before)
  })

  it('submits nothing while a question is open and nobody can answer it', async () => {
    const repo = await clonedRepository()
    const from = await planFile(repo, CREATE_PLAN)
    const { code } = await runWith(['plan', '--from', from, '--repo', repo, '--submit'])
    expect(code).toBe(3)
    expect(await branches(repo)).toEqual([])
  })

  it('reports the submission in --json, and never prompts there', async () => {
    const repo = await clonedRepository()
    const from = await planFile(repo, CREATE_PLAN)
    const { code, out } = await runWith(
      ['plan', '--from', from, '--repo', repo, '--submit', '--json'],
      {
        ask: answering('read'),
        confirm: async () => {
          throw new Error('a --json run asked a person')
        },
      },
    )
    expect(code).toBe(0)
    const report = JSON.parse(out) as { submission: Record<string, unknown> }
    // The key's shape is pinned (D11): cli-ux-10 versions the report later,
    // and a consumer written today must not be broken silently before then.
    expect(Object.keys(report.submission).sort()).toEqual(['base', 'branch', 'commit', 'outcome'])
    expect(report.submission['outcome']).toBe('created')
    expect(report.submission['branch']).toMatch(/^idp-agent\//)
    expect(report.submission['commit']).toBe(await git(repo, 'rev-parse', String(report.submission['branch'])))
    expect(report.submission['base']).toEqual({ branch: 'main', commit: await git(repo, 'rev-parse', 'main') })
  })

  it('takes the root from the working directory, and says what chose it (D19)', async () => {
    const repo = await clonedRepository()
    const from = await planFile(repo, CREATE_PLAN)
    const roots: string[] = []

    const { code, out, err } = await runWith(['plan', '--from', from, '--submit'], {
      ask: answering('read'),
      confirm: async (summary) => {
        roots.push(summary.root)
        return true
      },
      cwd: repo,
      env: await isolated(),
    })

    expect(code).toBe(0)
    expect(err).toContain('the current directory')
    expect(roots).toEqual([repo])
    expect(out).toContain('submitted as idp-agent/')
    expect(await branches(repo)).toHaveLength(1)
  })

  it('takes the root from IDP_REPO, and says so (D19)', async () => {
    const repo = await clonedRepository()
    const from = await planFile(repo, CREATE_PLAN)
    const roots: string[] = []

    const { code, err } = await runWith(['plan', '--from', from, '--submit'], {
      ask: answering('read'),
      confirm: async (summary) => {
        roots.push(summary.root)
        return true
      },
      cwd: await nowhere(),
      env: await isolated({ IDP_REPO: repo }),
    })

    expect(code).toBe(0)
    expect(err).toContain('IDP_REPO')
    expect(roots).toEqual([repo])
    expect(await branches(repo)).toHaveLength(1)
  })

  it('refuses --submit with no repository resolved, naming the four ways', async () => {
    const { code, err } = await runWith(['plan', '--from', '/tmp/plan.json', '--submit'], {
      cwd: await nowhere(),
      env: await isolated(),
    })
    expect(code).toBe(2)
    expect(err).toContain('--repo')
    expect(err).toContain('IDP_REPO')
    expect(err).toContain('idp-agent/config.yml')
  })

  it('refuses --submit with --demo, an option plan does not know, and writes nothing', async () => {
    // plan never reads the demo SI, so no write can be decided against it: the
    // parser refuses the option before a forge is opened.
    const repo = await clonedRepository()
    const from = await planFile(repo, CREATE_PLAN)
    const before = await observable(repo)
    const { code, err } = await runWith(['plan', '--from', from, '--repo', repo, '--submit', '--demo'], {
      ask: answering('read'),
    })
    expect(code).toBe(2)
    expect(err).toContain("Unknown option '--demo'")
    expect(await observable(repo)).toBe(before)
  })

  it('answers a plan that changes nothing with #83’s exit 3, and asks no forge', async () => {
    const repo = await clonedRepository()
    const from = await planFile(repo, {
      intent: 'declare the component billing-api, a service in production owned by group:default/tiger',
      operations: [
        {
          op: 'create-entity',
          entity: {
            kind: 'Component',
            metadata: { name: 'billing-api' },
            spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
          },
        },
      ],
    })
    const before = await observable(repo)

    const { code, out } = await runWith(['plan', '--from', from, '--repo', repo, '--submit'], {
      confirm: async () => {
        throw new Error('a plan that changes nothing asked for a confirmation')
      },
    })

    expect(code).toBe(3)
    expect(out).toContain('this plan changes nothing, and the repository does not already say it')
    expect(await branches(repo)).toEqual([])
    expect(await observable(repo)).toBe(before)
  })

  it('refuses a plan writing into both repositories, pointing at init --submit (D6)', async () => {
    const repo = await clonedRepository()
    const from = await planFile(repo, {
      intent: `${CREATE_INTENT}, and billing-api as a production service in catalog-info.yaml`,
      operations: [
        createDatabase,
        createAccess,
        {
          op: 'create-catalog-info',
          repoPath: 'catalog-info.yaml',
          entity: {
            kind: 'Component',
            metadata: { name: 'billing-api' },
            spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
          },
        },
      ],
    })
    const before = await observable(repo)

    const { code, out } = await runWith(['plan', '--from', from, '--repo', repo, '--submit'], {
      ask: answering('read'),
    })

    expect(code).toBe(1)
    expect(out).toContain('init --submit')
    expect(out).toContain('Nothing was written.')
    expect(await branches(repo)).toEqual([])
    expect(await observable(repo)).toBe(before)
  })

  it('spells out a bidi control in the base branch’s name, submitted or refused', async () => {
    // The base is the repository's own branch — after a clone, whatever the
    // remote named its default — and git accepts U+202E in a ref name. It is
    // the line that says which base a request sits on: it must not be spoofed.
    const repo = await clonedRepository()
    await git(repo, 'checkout', '-q', '-b', 'safe\u202egnp.exe')
    const from = await planFile(repo, CREATE_PLAN)
    const args = ['plan', '--from', from, '--repo', repo, '--submit']

    const submitted = await runWith(args, { ask: answering('read') })
    expect(submitted.code).toBe(0)
    expect(submitted.out).toContain('on top of safe\\u202egnp.exe@')
    expect(submitted.out + submitted.err).not.toContain('\u202e')

    await declare(repo, 'catalog/databases/stray.yml', '# stray\n')
    const divergent = await runWith(args, { ask: answering('read') })
    expect(divergent.code).toBe(1)
    expect(divergent.out).toContain('is not what safe\\u202egnp.exe@')
    expect(divergent.out + divergent.err).not.toContain('\u202e')
  })

  it('prints a divergent path with nothing a terminal obeys', async () => {
    const repo = await clonedRepository()
    await declare(repo, 'catalog/databases/x\u001b[31mred\u202e.yml', '# stray\n')
    const from = await planFile(repo, CREATE_PLAN)

    const { code, out, err } = await runWith(['plan', '--from', from, '--repo', repo, '--submit'], {
      ask: answering('read'),
    })

    expect(code).toBe(1)
    // An escape sequence is dropped whole; a bidi control is spelled out.
    expect(out).toContain('catalog/databases/xred\\u202e.yml was read')
    expect(out + err).not.toContain('\u001b')
    expect(out + err).not.toContain('\u202e')
  })

  it('refuses at the moment of writing when the base moved after the preview', async () => {
    // Checked again where it is acted on (AGENTS.md, Invariants): a commit on
    // main while the person read the diff is a refusal, not a branch on a base
    // nobody reviewed against.
    const repo = await clonedRepository()
    const from = await planFile(repo, CREATE_PLAN)

    const { code, out } = await runWith(['plan', '--from', from, '--repo', repo, '--submit'], {
      ask: answering('read'),
      confirm: async () => {
        await git(repo, 'commit', '-q', '--allow-empty', '-m', 'meanwhile')
        return true
      },
    })

    expect(code).toBe(1)
    expect(out).toMatch(/main moved from [0-9a-f]{7} to main@[0-9a-f]{7} since the plan was read/)
    expect(out).toContain('Nothing was written.')
    expect(await branches(repo)).toEqual([])
  })

  it('answers a git that fails mid-write with exit 1, and leaves what a person sees', async () => {
    const repo = await clonedRepository()
    const from = await planFile(repo, CREATE_PLAN)
    const before = await observable(repo)
    const objects = path.join(repo, '.git', 'objects')
    const directories = async (dir: string): Promise<string[]> => [
      dir,
      ...(
        await Promise.all(
          (await readdir(dir, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map((entry) => directories(path.join(dir, entry.name))),
        )
      ).flat(),
    ]
    const locked = await directories(objects)

    try {
      const { code, err } = await runWith(['plan', '--from', from, '--repo', repo, '--submit'], {
        ask: answering('read'),
        // After the forge was opened and the base read: git fails writing.
        confirm: async () => {
          await Promise.all(locked.map((dir) => chmod(dir, 0o555)))
          return true
        },
      })

      expect(code).toBe(1)
      expect(err).toMatch(/^git [a-z-]+ failed; nothing was submitted\n {2}\S/)
    } finally {
      await Promise.all(locked.map((dir) => chmod(dir, 0o755)))
    }
    expect(await observable(repo)).toBe(before)
    expect(await branches(repo)).toEqual([])
  })

  it('prints git’s own words one line each, with nothing a terminal obeys', async () => {
    // Recognised by name, because cli/ may not load the launcher: this is the
    // test that fails if the launcher's error is renamed out from under it.
    const repo = await clonedRepository()
    const from = await planFile(repo, CREATE_PLAN)

    const { code, err } = await runWith(['plan', '--from', from, '--repo', repo, '--submit'], {
      ask: answering('read'),
      confirm: async () => {
        throw new GitError(['update-ref'], 128, 'fatal: \u001b[31mboom\u202e\nsecond line\n', false)
      },
    })

    expect(code).toBe(1)
    expect(err).toBe(
      'git update-ref failed; nothing was submitted\n' +
        '  fatal: boom\\u202e\n' +
        '  second line\n',
    )
  })

  it('pins every shape --json gives the submission key (D11)', async () => {
    // A consumer written against the key today must not be broken silently
    // before cli-ux-10 versions the report: each outcome a script can meet.
    const repo = await clonedRepository()
    const from = await planFile(repo, CREATE_PLAN)
    const args = ['plan', '--from', from, '--repo', repo, '--submit', '--json']
    const submission = async (extra: string[] = []) => {
      const { code, out } = await runWith([...args, ...extra], { ask: answering('read') })
      return { code, submission: (JSON.parse(out) as { submission: Record<string, unknown> }).submission }
    }

    const created = await submission()
    expect(created.code).toBe(0)
    expect(Object.keys(created.submission).sort()).toEqual(['base', 'branch', 'commit', 'outcome'])
    expect(Object.keys(created.submission['base'] as object).sort()).toEqual(['branch', 'commit'])

    const again = await submission()
    expect(again.code).toBe(0)
    expect(again.submission).toEqual({ ...created.submission, outcome: 'already-submitted' })

    // Merged: the repository now says it, and there is nothing to submit.
    await git(repo, 'merge', '-q', '--ff-only', String(created.submission['branch']))
    const unchanged = await submission()
    expect(unchanged.code).toBe(0)
    expect(unchanged.submission).toEqual({ outcome: 'unchanged' })

    // A divergent working tree: refused before anything is judged, still JSON.
    await declare(repo, 'catalog/databases/stray.yml', '# stray\n')
    const divergent = await runWith(args, { ask: answering('read') })
    expect(divergent.code).toBe(1)
    const report = JSON.parse(divergent.out) as Record<string, unknown>
    expect(Object.keys(report)).toEqual(['submission'])
    const refused = report['submission'] as Record<string, unknown>
    expect(Object.keys(refused).sort()).toEqual(['outcome', 'reasons'])
    expect(refused['outcome']).toBe('refused')
    expect(refused['reasons']).toEqual([expect.stringContaining('catalog/databases/stray.yml')])
  })

  it('reports a refusal of the clearance under the same key in --json (D6, D11)', async () => {
    const repo = await clonedRepository()
    const from = await planFile(repo, {
      intent: `${CREATE_INTENT}, and billing-api as a production service in catalog-info.yaml`,
      operations: [
        createDatabase,
        createAccess,
        {
          op: 'create-catalog-info',
          repoPath: 'catalog-info.yaml',
          entity: {
            kind: 'Component',
            metadata: { name: 'billing-api' },
            spec: { type: 'service', lifecycle: 'production', owner: 'group:default/tiger' },
          },
        },
      ],
    })

    const { code, out } = await runWith(['plan', '--from', from, '--repo', repo, '--submit', '--json'], {
      ask: answering('read'),
    })

    expect(code).toBe(1)
    const refused = (JSON.parse(out) as { submission: Record<string, unknown> }).submission
    expect(Object.keys(refused).sort()).toEqual(['outcome', 'reasons'])
    expect(refused['outcome']).toBe('refused')
    expect(refused['reasons']).toEqual([expect.stringContaining('init --submit')])
    expect(await branches(repo)).toEqual([])
  })
})

describe('the confirmation at a terminal', () => {
  /** A terminal: readline reads keys, and Ctrl-C, only when its output is one. */
  const terminal = (): { input: PassThrough; output: PassThrough; diff: PassThrough; said: () => string } => {
    const output = new PassThrough() as PassThrough & { isTTY?: boolean }
    output.isTTY = true
    const diff = new PassThrough()
    const chunks: Buffer[] = []
    diff.on('data', (chunk: Buffer) => chunks.push(chunk))
    output.resume()
    return { input: new PassThrough(), output, diff, said: () => Buffer.concat(chunks).toString('utf8') }
  }

  const SUMMARY: SubmissionSummary = {
    root: '/work/iac',
    repository: 'declarations',
    branch: 'idp-agent/orders-db-prod-3f9c2a1b',
    base: { branch: 'main', commit: 'abc1234def' },
    files: [{ path: DATABASE_PATH, change: 'create' }],
    preview: `+++ b/${DATABASE_PATH}\n1 file · not yet submitted — it would become idp-agent/orders-db-prod-3f9c2a1b`,
  }

  it('prints the preview, then submits on y or yes and nothing else', async () => {
    for (const [typed, expected] of [
      ['y', true],
      ['YES', true],
      ['', false],
      ['n', false],
      ['oui', false],
    ] as const) {
      const { input, output, diff, said } = terminal()
      const answered = confirmOnTerminal(input, output, diff)(SUMMARY)
      input.write(`${typed}\n`)
      expect(await answered).toBe(expected)
      expect(said()).toContain(`+++ b/${DATABASE_PATH}`)
    }
  })

  it('leaves Ctrl-D a decline', async () => {
    const { input, output, diff } = terminal()
    const answered = confirmOnTerminal(input, output, diff)(SUMMARY)
    input.end()
    expect(await answered).toBe(false)
  })

  it('is interrupted by Ctrl-C, which is not a decline', async () => {
    const { input, output, diff } = terminal()
    const answered = confirmOnTerminal(input, output, diff)(SUMMARY)
    input.write('\u0003')
    await expect(answered).rejects.toBeInstanceOf(InterruptedError)
  })
})
