import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { main, renderEvent } from '../../src/cli/index.js'
import { runInitPlatform } from '../../src/cli/commands/init.js'
import { renderQuestions, renderStopped, type Ask } from '../../src/cli/commands/plan.js'
import type { AgentEvent } from '../../src/agents/events.js'
import { REPORT_TOOL } from '../../src/agents/tools/project-tools.js'
import { PROPOSE_TOOL } from '../../src/agents/tools/propose-tool.js'
import { VERDICT_TOOL } from '../../src/agents/reviewer.js'
import type { Plan } from '../../src/core/schemas/plan.js'
import type {
  AgentName,
  GenerateRequest,
  GenerateResult,
  LlmClient,
} from '../../src/llm/client.js'
import { hashTree } from '../support/tree.js'
import { applicationRoot, RepositoryArgumentError } from '../../src/cli/repository.js'

/**
 * Which directory `plan "<intent>"` inspects, and what it prints that a model
 * or a file wrote.
 *
 * The run this closes: standing in his declarations repository, somebody typed
 * `plan "give billing-api read access to the orders database in prod"
 * --repo .`, and the Inspector read the declarations repository as if it were
 * billing-api's — eight files, one of them refused as "an invalid Backstage
 * name" — before the Architect drafted anything. Nothing refused the argument,
 * because nothing asked which directory was which.
 */

/**
 * Written as escapes, never as the characters: a literal override in source
 * reorders the line it sits on in every editor and review that reads it.
 */
const ESC = '\u001B'
const RLO = '\u202E'

const scripted = (
  turns: Partial<Record<AgentName, GenerateResult[]>>,
): LlmClient & { seen: GenerateRequest[] } => {
  const spent = new Map<AgentName, number>()
  const seen: GenerateRequest[] = []
  return {
    seen,
    generate: async (request: GenerateRequest): Promise<GenerateResult> => {
      seen.push({ ...request, transcript: [...request.transcript] })
      const index = spent.get(request.agent) ?? 0
      spent.set(request.agent, index + 1)
      return (
        turns[request.agent]?.[index] ?? { text: '', toolCalls: [], finishReason: 'stop' }
      )
    },
  }
}

const turnCalling = (name: string, args: unknown): GenerateResult => ({
  text: '',
  toolCalls: [{ id: `call-${name}`, name, args }],
  finishReason: 'tool-calls',
})

const temp = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'idp-project-'))

/** The declarations repository, exactly as `init platform` leaves one. */
const scaffolded = async (folder = 'IaC'): Promise<string> => {
  const repo = path.join(await temp(), folder)
  await runInitPlatform({ root: repo, owner: '@acme/platform', version: '0.0.0-test' })
  return repo
}

/** An application repository, holding one file whose name says whose it is. */
const application = async (marker: string): Promise<string> => {
  const root = await temp()
  await writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'billing-api', dependencies: { pg: '^8' } }, null, 2)}\n`,
    'utf8',
  )
  await writeFile(path.join(root, marker), 'x\n', 'utf8')
  return root
}

const FACTS = {
  name: 'billing-api',
  type: 'service',
  lifecycle: 'production',
  runtime: 'node',
  owner: 'group:default/tiger',
  forgeHandle: '@acme/platform',
  dependencies: [{ name: 'pg', type: 'database' }],
}

const INTENT =
  'declare the database orders-db-prod in prod owned by group:default/tiger, then give ' +
  'component:default/billing-api a database-access granting read to resource:default/orders-db-prod'

const CREATE_DATABASE = {
  op: 'create-entity',
  entity: {
    kind: 'Resource',
    metadata: { name: 'orders-db-prod', env: 'prod' },
    spec: { type: 'database', owner: 'group:default/tiger' },
  },
}

const CREATE_ACCESS = {
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

const answering = (value: string): Ask => async (question) =>
  question.path.endsWith('.access') ? value : undefined

/**
 * `stream` leaves the events to the renderer a real run uses, on `err`, for
 * the tests about what reaches a terminal; otherwise they are collected.
 */
const run = async (
  args: string[],
  deps: Parameters<typeof main>[1] = {},
  { stream = false }: { stream?: boolean } = {},
) => {
  const out: string[] = []
  const err: string[] = []
  const events: AgentEvent[] = []
  const code = await main(args, {
    ...(stream ? {} : { events: (event: AgentEvent) => void events.push(event) }),
    ...deps,
    out: (chunk) => void out.push(chunk),
    err: (chunk) => void err.push(chunk),
  })
  return { code, out: out.join(''), err: err.join(''), events }
}

/** A client that must never be called: every refusal below comes first. */
const untouched = (): LlmClient & { seen: GenerateRequest[] } => scripted({})

describe('plan "<intent>" --project', () => {
  it('reads the directory --project names, resolved where the user stands', async () => {
    const repo = await scaffolded()
    const project = await application('billing-api.marker')
    const standing = await application('standing-here.marker')
    const client = scripted({
      inspector: [turnCalling('list_files', {}), turnCalling(REPORT_TOOL, FACTS)],
      architect: [turnCalling(PROPOSE_TOOL, { operations: [CREATE_DATABASE, CREATE_ACCESS] })],
      reviewer: [turnCalling(VERDICT_TOOL, { verdict: 'ok' })],
    })

    const { code } = await run(
      ['plan', INTENT, '--repo', repo, '--project', path.relative(standing, project)],
      { cwd: standing, client, ask: answering('read'), env: {} },
    )

    expect(code).toBe(0)
    // What `list_files` handed back is the second inspector turn's transcript:
    // the named repository's files, and none of the one the user stands in.
    const listed = JSON.stringify(
      client.seen.filter((request) => request.agent === 'inspector')[1]?.transcript,
    )
    expect(listed).toContain('billing-api.marker')
    expect(listed).not.toContain('standing-here.marker')
  })

  it('reads the working directory when --project is absent, as it always has', async () => {
    const repo = await scaffolded()
    const standing = await application('standing-here.marker')
    const client = scripted({
      inspector: [turnCalling('list_files', {}), turnCalling(REPORT_TOOL, FACTS)],
      architect: [turnCalling(PROPOSE_TOOL, { operations: [CREATE_DATABASE, CREATE_ACCESS] })],
      reviewer: [turnCalling(VERDICT_TOOL, { verdict: 'ok' })],
    })

    const { code } = await run(['plan', INTENT, '--repo', repo], {
      cwd: standing,
      client,
      ask: answering('read'),
      env: {},
    })

    expect(code).toBe(0)
    const listed = JSON.stringify(
      client.seen.filter((request) => request.agent === 'inspector')[1]?.transcript,
    )
    expect(listed).toContain('standing-here.marker')
  })

  it('refuses a --project that is not a directory, naming the flag', async () => {
    const repo = await scaffolded()
    const standing = await temp()
    const client = untouched()

    const { code, err, events } = await run(
      ['plan', INTENT, '--repo', repo, '--project', 'nowhere'],
      { cwd: standing, client, env: {} },
    )

    expect(code).toBe(2)
    expect(err).toContain('nowhere is not a directory')
    expect(err).toContain('plan --project names the application repository')
    expect(client.seen).toEqual([])
    expect(events).toEqual([])
  })

  it('refuses an empty --project rather than reading wherever it runs', async () => {
    // `--project "$SERVICE"` with the variable unset resolves to the working
    // directory, which is exactly the directory the flag was typed to avoid.
    const repo = await scaffolded()
    const client = untouched()

    const { code, err } = await run(['plan', INTENT, '--repo', repo, '--project', ''], {
      cwd: await temp(),
      client,
      env: {},
    })

    expect(code).toBe(2)
    expect(err).toContain('--project is empty')
    expect(client.seen).toEqual([])
  })

  it('reads the --repo it checked: both are resolved where the user stands', async () => {
    // A relative --repo, a `cwd` that is not the process's: the directory the
    // guard compared with the project is the one the preview is decided
    // against, not a second resolution of the same words somewhere else.
    const standing = await temp()
    const folder = `declarations-${path.basename(standing)}`
    await runInitPlatform({
      root: path.join(standing, folder),
      owner: '@acme/platform',
      version: '0.0.0-test',
    })
    const project = await application('billing-api.marker')
    const client = scripted({
      inspector: [turnCalling(REPORT_TOOL, FACTS)],
      architect: [turnCalling(PROPOSE_TOOL, { operations: [CREATE_DATABASE, CREATE_ACCESS] })],
      reviewer: [turnCalling(VERDICT_TOOL, { verdict: 'ok' })],
    })

    const { code, out, err } = await run(['plan', INTENT, '--repo', folder, '--project', project], {
      cwd: standing,
      client,
      ask: answering('read'),
      env: {},
    })

    expect(err).not.toContain('is not a directory')
    expect(code).toBe(0)
    expect(out).toContain('+++ b/catalog/databases/orders-db-prod.yml')
  })

  it('asks for the working directory only when a path needs it', async () => {
    // A shell can stand in a directory since removed, where `process.cwd()`
    // throws. Two absolute paths need none; an absent --project does.
    const repo = await scaffolded()
    const project = await application('billing-api.marker')
    const gone = (): string => {
      throw new Error('ENOENT: no such file or directory, uv_cwd')
    }

    await expect(applicationRoot({ repo, project, cwd: gone })).resolves.toEqual({
      repo,
      project,
    })
    const standing = applicationRoot({ repo, project: undefined, cwd: gone })
    await expect(standing).rejects.toBeInstanceOf(RepositoryArgumentError)
    await expect(standing).rejects.toThrow(/the working directory no longer exists.*--project <dir>/)
  })

  it('refuses --project with --from: there is no Inspector to point', async () => {
    const { code, err } = await run([
      'plan',
      '--from',
      '/tmp/plan.json',
      '--repo',
      '/tmp',
      '--project',
      '/tmp',
    ])

    expect(code).toBe(2)
    // Its own refusal, not parseArgs' "unknown option" — HELP names both flags
    // either way, so the words are what tell the two apart.
    expect(err).toContain('plan --from reads a plan and inspects nothing')
  })
})

describe('plan "<intent>" refuses to inspect the wrong repository', () => {
  const DECLARATIONS =
    'plan reads the application repository of the service you are declaring, and IaC ' +
    'is a declarations repository.'

  it('standing in a declarations repository, before a single model call', async () => {
    // The owner's run, as he typed it.
    const repo = await scaffolded()
    const before = await hashTree(repo)
    const client = untouched()

    const { code, out, err, events } = await run(['plan', INTENT, '--repo', '.'], {
      cwd: repo,
      client,
      env: {},
    })

    expect(code).toBe(2)
    expect(err).toContain(DECLARATIONS)
    expect(err).toContain('--project <dir>')
    expect(out).toBe('')
    expect(client.seen).toEqual([])
    expect(events).toEqual([])
    expect(await hashTree(repo)).toBe(before)
  })

  it('standing in one while --repo names another', async () => {
    const standing = await scaffolded()
    const repo = await scaffolded('declarations')
    const client = untouched()

    const { code, err } = await run(['plan', INTENT, '--repo', repo], {
      cwd: standing,
      client,
      env: {},
    })

    expect(code).toBe(2)
    expect(err).toContain(DECLARATIONS)
    expect(client.seen).toEqual([])
  })

  it('when --project itself names a declarations repository', async () => {
    const project = await scaffolded()
    const repo = await scaffolded('declarations')
    const client = untouched()

    const { code, err } = await run(['plan', INTENT, '--repo', repo, '--project', project], {
      cwd: await temp(),
      client,
      env: {},
    })

    expect(code).toBe(2)
    expect(err).toContain('IaC is a declarations repository')
    expect(client.seen).toEqual([])
  })

  it('when --project and --repo are one directory, however each is spelled', async () => {
    // Not a declarations repository by its markers — a fresh one holds none
    // before `init platform` — so only the comparison catches it. Through a
    // symbolic link, because a real path is what the two are compared by.
    const directory = await application('billing-api.marker')
    const link = path.join(await temp(), 'alias')
    await symlink(directory, link)
    const client = untouched()

    const { code, err } = await run(
      ['plan', INTENT, '--repo', `${directory}${path.sep}.`, '--project', link],
      { cwd: await temp(), client, env: {} },
    )

    expect(code).toBe(2)
    expect(err).toContain('the same directory')
    expect(err).toContain('--repo names the declarations repository')
    expect(client.seen).toEqual([])
  })

  it('standing in one of its declaration folders, --repo naming the repository above', async () => {
    // The owner's run, one `cd` deeper. A monorepo's service folder may sit
    // inside the declarations repository; `catalog/` and `dependencies/` are
    // where it keeps its declarations, and are never a service's repository.
    const repo = await scaffolded()
    for (const [standing, above] of [
      ['catalog', '..'],
      [path.join('catalog', 'databases'), path.join('..', '..')],
    ] as const) {
      const client = untouched()

      const { code, err } = await run(['plan', INTENT, '--repo', above], {
        cwd: path.join(repo, standing),
        client,
        env: {},
      })

      expect(code).toBe(2)
      expect(err).toContain(
        `IaC/${standing.split(path.sep).join('/')} is where the declarations repository --repo ` +
          'names keeps its declarations.',
      )
      expect(err).toContain('--project <dir>')
      expect(client.seen).toEqual([])
    }
  })

  it('but reads a service folder the declarations repository holds elsewhere', async () => {
    // A monorepo: the declarations and the service in one repository. The
    // service's folder is not a declaration folder, so it is read.
    const repo = await scaffolded()
    const service = path.join(repo, 'services', 'billing-api')
    await mkdir(service, { recursive: true })
    await writeFile(path.join(service, 'billing-api.marker'), 'x\n', 'utf8')
    const client = scripted({
      inspector: [turnCalling('list_files', {}), turnCalling(REPORT_TOOL, FACTS)],
      architect: [turnCalling(PROPOSE_TOOL, { operations: [CREATE_DATABASE, CREATE_ACCESS] })],
      reviewer: [turnCalling(VERDICT_TOOL, { verdict: 'ok' })],
    })

    const { code } = await run(['plan', INTENT, '--repo', repo, '--project', service], {
      cwd: await temp(),
      client,
      ask: answering('read'),
      env: {},
    })

    expect(code).toBe(0)
    const listed = JSON.stringify(
      client.seen.filter((request) => request.agent === 'inspector')[1]?.transcript,
    )
    expect(listed).toContain('billing-api.marker')
  })

  it('before it says no model is configured', async () => {
    // Nothing is configured, and the directory is wrong. The directory is the
    // mistake to fix first: configuring a model would only lead back here.
    const repo = await scaffolded()

    const { code, err } = await run(['plan', INTENT, '--repo', '.'], { cwd: repo, env: {} })

    expect(code).toBe(2)
    expect(err).toContain(DECLARATIONS)
    expect(err).not.toContain('no model configured')
  })

  it('names the folder with nothing in it a terminal would obey', async () => {
    const repo = await scaffolded(`IaC\u001B[2J${RLO}`)

    const { code, err } = await run(['plan', INTENT, '--repo', '.'], {
      cwd: repo,
      client: untouched(),
      env: {},
    })

    expect(code).toBe(2)
    expect(err).not.toContain('\u001B')
    expect(err).not.toContain(RLO)
    // The whole sequence goes, and the override is spelled out.
    expect(err).toContain('IaC\\u202e is a declarations repository')
  })
})

/**
 * Every shape a terminal obeys, in one string: clear the screen and home the
 * cursor, write the clipboard (OSC 52), an 8-bit CSI, a right-to-left override
 * and a carriage return that would overwrite the line it is on.
 */
const PAYLOAD = `${ESC}[2J${ESC}[H${ESC}]52;c;ZXZpbA==\u0007\u009B31m${RLO}evil\r+++ b/fake.yml`

const inert = (text: string): void => {
  expect(text).not.toContain(ESC)
  expect(text).not.toContain('\u0007')
  expect(text).not.toContain('\u009B')
  expect(text).not.toContain(RLO)
  expect(text).not.toContain('\r')
}

/** The payload, as a file may be named: everything but the slash. */
const NAMED = `${ESC}[2J${ESC}]52;c;ZXZpbA==\u0007\u009B31m${RLO}evil\r`

const CONSUMER = 'component:default/reporting-worker'

/**
 * A declarations repository holding one readwrite grant, and a plan file that
 * adds `CONSUMER` to it. Where the grant is filed, what its `dependencyOf`
 * looks like and a comment inside it are the test's to choose.
 */
const amending = async ({
  file = 'billing-api-billing-db-prod.yml',
  comment = 'the grant',
  dependencyOf = '  dependencyOf:\n    - component:default/billing-api',
}: { file?: string; comment?: string; dependencyOf?: string } = {}) => {
  const root = path.join(await temp(), 'repo')
  await runInitPlatform({ root, owner: '@acme/platform', version: '0.0.0-test' })
  await mkdir(path.join(root, 'dependencies/access'), { recursive: true })
  await writeFile(
    path.join(root, 'dependencies/access', file),
    [
      '---',
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
      `  # ${comment}`,
      dependencyOf,
      '',
    ].join('\n'),
    'utf8',
  )
  const from = path.join(path.dirname(root), 'plan.json')
  await writeFile(
    from,
    JSON.stringify({
      intent: `let ${CONSUMER} use resource:default/billing-api-billing-db-prod, the readwrite access`,
      operations: [
        {
          op: 'update-entity',
          entityRef: 'resource:default/billing-api-billing-db-prod',
          patch: { patch: 'add-dependency-of', consumer: CONSUMER, access: 'readwrite' },
        },
      ],
    }),
    'utf8',
  )
  return { root, from }
}

describe('what plan prints that a model or a file wrote', () => {
  it('a question, on stdout, flattened to its one line', async () => {
    const repo = await scaffolded()
    const project = await application('billing-api.marker')
    const owned = {
      ...CREATE_DATABASE,
      entity: {
        ...CREATE_DATABASE.entity,
        spec: { type: 'database', owner: { unknown: `${PAYLOAD}\n\n1 file · nothing written` } },
      },
    }
    const client = scripted({
      inspector: [turnCalling(REPORT_TOOL, FACTS)],
      architect: [turnCalling(PROPOSE_TOOL, { operations: [owned] })],
    })

    const { code, out } = await run(['plan', INTENT, '--repo', repo], {
      cwd: project,
      client,
      env: {},
    })

    expect(code).toBe(3)
    inert(out)
    expect(out).toContain('evil')
    // One line: a question cannot print a closing line of its own under it.
    expect(out).toMatch(/^ {6}.*evil.*1 file · nothing written$/m)
  })

  it('the Reviewer’s reason on a stop, as one line', async () => {
    const repo = await scaffolded()
    const project = await application('billing-api.marker')
    const rejected = turnCalling(VERDICT_TOOL, { verdict: 'reject', reason: PAYLOAD })
    const proposed = turnCalling(PROPOSE_TOOL, { operations: [CREATE_DATABASE, CREATE_ACCESS] })
    const client = scripted({
      inspector: [turnCalling(REPORT_TOOL, FACTS)],
      architect: [proposed, proposed, proposed],
      reviewer: [rejected, rejected, rejected],
    })

    const { code, out, err } = await run(['plan', INTENT, '--repo', repo], {
      cwd: project,
      client,
      ask: answering('read'),
      env: {},
    }, { stream: true })

    expect(code).toBe(1)
    inert(out)
    inert(err)
    expect(out).toMatch(/^refused at the reviewer gate: .*evil.*fake\.yml$/m)
  })

  it('the partial plan on a stop, escaped where it cannot be removed', () => {
    // JSON.stringify escapes C0 and leaves DEL, C1 and the bidi controls raw.
    // Spelled out as \u escapes, the text is still JSON, and still this plan.
    const plan: Plan = {
      intent: 'whatever the drafter wrote',
      operations: [
        {
          op: 'create-entity',
          entity: {
            kind: 'Component',
            metadata: { name: 'billing-api' },
            spec: {
              type: `service\u009B2J\u007F${RLO}`,
              lifecycle: 'production',
              owner: { unknown: PAYLOAD },
            },
          },
        },
      ],
    } as Plan

    const { text } = renderStopped(plan, 'reviewer', PAYLOAD)

    inert(text)
    expect(text).not.toContain('\u007F')
    expect(text).toContain('\\u009b')
    expect(text).toContain('\\u202e')
    const json = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)
    expect(JSON.parse(json)).toEqual(plan.operations)
  })

  it('every question renderQuestions prints, whoever drafted it', () => {
    const { text } = renderQuestions([
      { path: 'operations.0.entity.spec.owner', question: `${PAYLOAD}\nsecond line` },
    ])
    inert(text)
    expect(text).toContain('\\u202eevil')
    expect(text).not.toContain('\nsecond line')
  })

  it('the lines that say where an owner came from', () => {
    const derived = renderEvent({
      type: 'derived',
      path: 'operations.1.entity.spec.owner',
      owner: `group:default/${PAYLOAD}`,
      from: [`component:default/${PAYLOAD}`],
    })
    const overridden = renderEvent({
      type: 'overridden',
      path: 'operations.1.entity.spec.owner',
      owner: `group:default/${PAYLOAD}`,
      determined: `group:default/${PAYLOAD}`,
      from: [`component:default/${PAYLOAD}`],
    })
    for (const line of [derived, overridden]) {
      inert(line ?? '')
      expect(line).not.toContain('\n')
    }
  })

  it('a context line the diff quotes from a repository file', async () => {
    // YAML accepts a raw ESC in a comment, the reader loads the file, and the
    // three lines of context around an amended grant are that file's bytes.
    const { root, from } = await amending({ comment: PAYLOAD })

    const { code, out } = await run(['plan', '--from', from, '--repo', root], {
      ask: answering('readwrite'),
    })

    expect(code).toBe(0)
    expect(out).toContain(`+    - ${CONSUMER}`)
    inert(out)
    // Spelled out rather than removed: the diff is a statement about bytes,
    // and a reviewer has to see that the file holds something odd there.
    expect(out).toContain('\\u001b[2J')
  })

  it('a violation, which names the file somebody named', async () => {
    // Filed away from where its name says, so the re-check faults the file the
    // plan edits, by its name, and the name is the payload.
    const { root, from } = await amending({ file: `${NAMED}.yml` })

    const { code, out } = await run(['plan', '--from', from, '--repo', root], {
      ask: answering('readwrite'),
    })

    expect(code).toBe(1)
    inert(out)
    expect(out).toMatch(/^error +dependencies\/access\/.*evil.*\.yml: .*$/m)
  })

  it('a violation whose message quotes another file by its name', async () => {
    // The grant declared twice, the second time under the payload: the plan
    // edits the first, and the duplicate it now sits in names both files.
    const { root, from } = await amending()
    const access = path.join(root, 'dependencies/access')
    await writeFile(
      path.join(access, `${NAMED}.yml`),
      await readFile(path.join(access, 'billing-api-billing-db-prod.yml'), 'utf8'),
      'utf8',
    )

    const { code, out } = await run(['plan', '--from', from, '--repo', root], {
      ask: answering('readwrite'),
    })

    expect(code).toBe(1)
    inert(out)
    expect(out).toMatch(/^error +.*: .* is declared in .*evil.*$/m)
  })

  it('an operation that produced no change, whose reason names the file', async () => {
    // A flow sequence is a shape the surgery refuses to split, so the grant is
    // dropped with a reason naming the file it could not amend.
    const { root, from } = await amending({
      file: `${NAMED}.yml`,
      dependencyOf: '  dependencyOf: [component:default/billing-api]',
    })

    const { out } = await run(['plan', '--from', from, '--repo', root], {
      ask: answering('readwrite'),
    })

    inert(out)
    expect(out).toMatch(/^ {2}! operations\.0 — could not add .*evil.*$/m)
  })

  it('a policy message, which quotes the value it refuses', async () => {
    // The environment is a question, the answer is the payload, and the
    // answer is vouched for — the user said it — so the policy is what refuses
    // it, quoting it: the plan touches <it>, but the request said prod. Over
    // a repository that already uses prod, so the word is an environment.
    const { root } = await amending()
    const from = path.join(await temp(), 'plan.json')
    await writeFile(
      from,
      JSON.stringify({
        intent: 'declare the database orders-db in prod owned by group:default/tiger',
        operations: [
          {
            op: 'create-entity',
            entity: {
              kind: 'Resource',
              metadata: { name: 'orders-db', env: { unknown: 'which environment?' } },
              spec: { type: 'database', owner: 'group:default/tiger' },
            },
          },
        ],
      }),
      'utf8',
    )
    const ask: Ask = async (question) => (question.path.endsWith('.env') ? PAYLOAD : undefined)

    const { code, out } = await run(['plan', '--from', from, '--repo', root], { ask })

    expect(code).toBe(1)
    inert(out)
    expect(out).toMatch(/^ {8}the plan touches .*evil.*fake\.yml, but .*$/m)
  })

  it('a plan file that is not JSON, quoted by the parser', async () => {
    const from = path.join(await temp(), 'plan.json')
    await writeFile(from, `${ESC}]52;c;ZXZpbA==\u0007${RLO}`, 'utf8')

    const { code, err } = await run(['plan', '--from', from, '--repo', await temp()])

    expect(code).toBe(2)
    expect(err).toContain('is not JSON')
    inert(err)
  })

  it('a plan file whose excerpt holds line breaks, on one line', async () => {
    // The parser quotes about ten characters of the file, raw: enough for a
    // line break and the start of a line shaped like a diff header.
    const from = path.join(await temp(), 'plan.json')
    await writeFile(from, 'x\n\n--- a/catalog/x.yml\n', 'utf8')

    const { code, err } = await run(['plan', '--from', from, '--repo', await temp()])

    expect(code).toBe(2)
    expect(err).toContain('is not JSON')
    expect(err.trimEnd()).not.toContain('\n')
  })
})

describe('what init prints that a model wrote', () => {
  it('a question about the Component it would declare', async () => {
    const project = await application('billing-api.marker')
    const component = {
      op: 'create-entity',
      entity: {
        kind: 'Component',
        metadata: { name: 'billing-api' },
        spec: { type: 'service', lifecycle: 'production', owner: { unknown: PAYLOAD } },
      },
    }
    const client = scripted({
      inspector: [turnCalling(REPORT_TOOL, { ...FACTS, owner: { unknown: PAYLOAD } })],
      architect: [turnCalling(PROPOSE_TOOL, { operations: [component] })],
    })

    const { code, out, err } = await run(
      ['init', '--repo', project],
      { client, env: {} },
      { stream: true },
    )

    expect(code).toBe(3)
    inert(out)
    inert(err)
    expect(out).toContain('evil')
  })
})
