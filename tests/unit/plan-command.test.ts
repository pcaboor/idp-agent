import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from '../../src/cli/index.js'
import { runInitPlatform } from '../../src/cli/commands/init.js'
import { runPlan } from '../../src/cli/commands/plan.js'

const capture = (): { out: string[]; err: string[] } => ({ out: [], err: [] })

const run = async (args: string[]) => {
  const io = capture()
  const code = await main(args, {
    out: (chunk) => void io.out.push(chunk),
    err: (chunk) => void io.err.push(chunk),
  })
  return { code, out: io.out.join(''), err: io.err.join('') }
}

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

/**
 * Every ENTRY under `root`, repository-relative, POSIX, dotfiles included —
 * directories among them, marked with a trailing slash.
 *
 * Files alone were not enough: an mkdir inside the repository left the digest
 * untouched, so a command that created a folder and wrote nothing into it
 * passed a check named "writes nothing".
 */
async function entriesUnder(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const found = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(directory, entry.name)
      const relative = path.relative(root, full).split(path.sep).join('/')
      if (entry.isDirectory()) return [`${relative}/`, ...(await entriesUnder(root, full))]
      return [relative]
    }),
  )
  return found.flat()
}

/**
 * Paths as well as contents, and directories as well as files. Hashing contents
 * alone would let a file appear or disappear without moving the digest, and an
 * added file is exactly the failure "writes nothing" is a claim about. Hashing
 * files alone let an mkdir pass the very check that names it.
 */
async function hashTree(root: string): Promise<string> {
  const entries = (await entriesUnder(root)).sort()
  const digest = createHash('sha256')
  for (const entry of entries) {
    digest.update(entry)
    digest.update('\x00')
    // A directory has no bytes; its presence in the list is the whole point.
    if (!entry.endsWith('/')) {
      digest.update(await readFile(path.join(root, ...entry.split('/'))))
    }
    digest.update('\x00')
  }
  return digest.digest('hex')
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
  'component:default/billing-api a database-access to resource:default/orders-db-prod'

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
      type: 'database-access',
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

    const result = await runPlan({ from, repo: root })

    expect(result.found).toBe(true)
    expect(await hashTree(root)).toBe(before)
  })

  it('renders the diff the plan would produce and ends on the line §7.4 requires', async () => {
    const root = await scaffoldedRepository()
    const from = await planFile(root, CREATE_PLAN)

    const { code, out } = await run(['plan', '--from', from, '--repo', root])

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
    const root = await scaffoldedRepository()
    await declare(root, DATABASE_PATH, entityDocument('orders-db-prod', 'database', 'prod'))
    await declare(
      root,
      ACCESS_PATH,
      entityDocument('billing-api-orders-db-prod', 'database-access', 'prod', [
        '  dependsOn:',
        '    - resource:default/orders-db-prod',
        '  dependencyOf:',
        '    - component:default/billing-api',
      ]),
    )
    const from = await planFile(root, CREATE_PLAN)
    const before = await hashTree(root)

    const { code, out } = await run(['plan', '--from', from, '--repo', root])

    expect(code).toBe(0)
    expect(out).not.toContain('@@')
    expect(out).not.toContain('+++ b/')
    expect(out).toContain(ACCESS_PATH)
    expect(out).toContain('already declares')
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
    const root = await scaffoldedRepository()
    await declare(root, 'catalog/databases/orders-db-dev.yml', entityDocument('orders-db-dev', 'database', 'dev'))
    await declare(root, DATABASE_PATH, entityDocument('orders-db-prod', 'database', 'prod'))
    const from = await planFile(root, {
      intent: 'give component:default/billing-api a database-access to orders-db in dev',
      operations: [
        {
          op: 'create-entity',
          entity: {
            kind: 'Resource',
            metadata: { name: 'billing-api-orders-db-prod', env: 'dev' },
            spec: {
              type: 'database-access',
              owner: 'group:default/tiger',
              dependsOn: ['resource:default/orders-db-prod'],
            },
          },
        },
      ],
    })
    const before = await hashTree(root)

    const { code, out } = await run(['plan', '--from', from, '--repo', root])

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
    const { code, out } = await run(['plan', '--from', from, '--repo', root, '--json'])

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

  it('refuses a --repo that is not a directory', async () => {
    const root = await scaffoldedRepository()
    const from = await planFile(root, CREATE_PLAN)

    const { code, err } = await run(['plan', '--from', from, '--repo', path.join(root, 'nowhere')])

    expect(code).toBe(2)
    expect(err).toContain('nowhere')
  })

  it('needs --from, and says the intent form is not this build', async () => {
    const { code, err } = await run(['plan', '--repo', '/tmp'])
    expect(code).toBe(2)
    expect(err).toContain('--from')
  })

  it('needs --repo: a preview is decided against the repository, never the catalogue', async () => {
    const { code, err } = await run(['plan', '--from', '/tmp/plan.json'])
    expect(code).toBe(2)
    expect(err).toContain('--repo')
  })

  it('names the flag when handed an intent, rather than reporting a stray argument', async () => {
    const { code, err } = await run(['plan', 'give billing-api access to orders-db'])
    expect(code).toBe(2)
    expect(err).toContain('--from')
  })
})
