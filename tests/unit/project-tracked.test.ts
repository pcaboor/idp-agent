import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspect } from '../../src/agents/inspector.js'
import { buildProjectTools, REPORT_TOOL } from '../../src/agents/tools/project-tools.js'
import { main } from '../../src/cli/index.js'
import { runInitPlatform } from '../../src/cli/commands/init.js'
import { readProject } from '../../src/context/project-fs/snapshot.js'
import type { AgentEvent } from '../../src/agents/events.js'
import type { GenerateRequest, GenerateResult, LlmClient } from '../../src/llm/client.js'

/**
 * `project-fs` reads what git tracks, and nothing a checkout merely holds
 * (review priority 7: security-2's `.gitignore`, security-3).
 *
 * An untracked `.env`, a local override, a build artefact: none of them is part
 * of the service, and each is exactly where a secret sits. The repositories
 * below are real ones, made with the git on the machine, because "tracked" is
 * a fact only git can state.
 *
 * NO REAL SECRET IS WRITTEN HERE. Every secret-shaped string is assembled at run
 * time from a split prefix and a generated body, so no scanner reading this file
 * finds a token in it, and none was ever issued by anyone.
 */

const temp = (prefix = 'idp-tracked-'): Promise<string> => mkdtemp(path.join(tmpdir(), prefix))

/**
 * git, as a test drives it: never the repository a hook or a shell pointed
 * `GIT_DIR` at. A suite run from a pre-commit hook inherits `GIT_DIR` and
 * `GIT_INDEX_FILE`, and `git add` would then stage into this project's own index.
 */
const git = (cwd: string, ...args: string[]): string => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  )
  return execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd,
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8',
  })
}

const write = async (root: string, files: Record<string, string>): Promise<void> => {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, content)
  }
}

/** A repository whose `tracked` files are in the index and whose `untracked` are only on disk. */
const repository = async (
  tracked: Record<string, string>,
  untracked: Record<string, string> = {},
): Promise<string> => {
  const root = await temp()
  git(root, 'init', '-q')
  await write(root, tracked)
  if (Object.keys(tracked).length > 0) git(root, 'add', '--', ...Object.keys(tracked))
  await write(root, untracked)
  return root
}

const pathsOf = (snapshot: { files: ReadonlyArray<{ path: string }> }): string[] =>
  snapshot.files.map((file) => file.path)

const reasonFor = (
  snapshot: { skipped: ReadonlyArray<{ path: string; reason: string }> },
  candidate: string,
): string | undefined => snapshot.skipped.find((entry) => entry.path === candidate)?.reason

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const body = (length: number, alphabet = ALNUM, seed = 3): string =>
  Array.from({ length }, (_, index) => alphabet[(index * 29 + seed) % alphabet.length]).join('')
const join = (...parts: string[]): string => parts.join('')

describe('readProject in a git repository', () => {
  it('reads the files git tracks and never an untracked one', async () => {
    const root = await repository(
      {
        'package.json': '{"name":"billing-api"}\n',
        'src/index.ts': 'export const x = 1\n',
        'config/app.yml': 'port: 8080\n',
      },
      {
        '.env': 'DB_PASSWORD=UNTRACKED-ENV\n',
        'config/local.yml': 'override: UNTRACKED-OVERRIDE\n',
        'tmp/build.log': 'UNTRACKED-ARTEFACT\n',
      },
    )
    // Unreadable, so a read would say "could not be read": the reason below
    // proves the file was never opened, not merely that its bytes were dropped.
    await chmod(path.join(root, 'config/local.yml'), 0o000)

    const snapshot = await readProject(root)

    expect(pathsOf(snapshot)).toEqual(['config/app.yml', 'package.json', 'src/index.ts'])
    expect(JSON.stringify(snapshot)).not.toMatch(/UNTRACKED/)
    // Counted, never named: the snapshot goes to a provider, and the name of a
    // file nobody committed — `notes/customer-x-incident.md` — is not the
    // service's to send. `.git` is the fourth: git tracks nothing in it.
    expect(JSON.stringify(snapshot.skipped)).not.toMatch(/local\.yml|tmp|\.env/)
    expect(reasonFor(snapshot, '.')).toBe('not read: 4 paths git does not track, and not named')
    expect(snapshot.selection).toBe('git')
  })

  it('refuses a tracked link to an untracked file', async () => {
    // Exclusion is decided on where a path leads: the link is tracked, the
    // bytes it leads to are not.
    const root = await repository({ 'package.json': '{"name":"x"}\n' }, {
      'local/override.yml': 'value: UNTRACKED-TARGET\n',
    })
    await symlink(path.join('local', 'override.yml'), path.join(root, 'config.yml'))
    git(root, 'add', '--', 'config.yml')

    const snapshot = await readProject(root)

    expect(JSON.stringify(snapshot.files)).not.toContain('UNTRACKED-TARGET')
    expect(reasonFor(snapshot, 'config.yml')).toBe('not read: git does not track it')
  })

  it('reads a service inside a monorepo, relative to the service', async () => {
    const root = await repository({
      'services/billing/package.json': '{"name":"billing-api"}\n',
      'services/orders/package.json': '{"name":"orders"}\n',
    }, { 'services/billing/.env.local': 'X=UNTRACKED\n', 'services/billing/notes.md': 'UNTRACKED' })

    const snapshot = await readProject(path.join(root, 'services', 'billing'))

    expect(pathsOf(snapshot)).toEqual(['package.json'])
    expect(reasonFor(snapshot, 'notes.md')).toBeUndefined()
    expect(reasonFor(snapshot, '.')).toBe('not read: 2 paths git does not track, and not named')
  })

  it('asks git about this repository, whatever GIT_DIR says', async () => {
    const elsewhere = await repository({ 'elsewhere.md': 'ELSEWHERE\n' })
    const root = await repository({ 'package.json': '{"name":"x"}\n' })
    const saved = process.env['GIT_DIR']
    process.env['GIT_DIR'] = path.join(elsewhere, '.git')
    try {
      const snapshot = await readProject(root)
      expect(pathsOf(snapshot)).toEqual(['package.json'])
    } finally {
      if (saved === undefined) delete process.env['GIT_DIR']
      else process.env['GIT_DIR'] = saved
    }
  })

  it("never runs a command the repository's own configuration names", async () => {
    // `git ls-files` runs `core.fsmonitor` — a command line from the
    // repository's `.git/config`, which is whatever the repository's author
    // left there. Inspecting a repository must not execute it.
    const root = await repository({ 'package.json': '{"name":"x"}\n' })
    const marker = path.join(await temp(), 'ran')
    git(root, 'config', 'core.fsmonitor', `touch '${marker}'; echo`)

    await readProject(root)

    await expect(stat(marker)).rejects.toThrow()
  })

  it('reads nothing when git cannot list what the repository tracks', async () => {
    // A repository git refuses to read (here, one whose index is garbage) is
    // still a repository: falling back to the walk would read what it holds
    // untracked, the one thing this rule exists to refuse.
    const root = await repository({ 'package.json': '{"name":"x"}\n' })
    await writeFile(path.join(root, '.git', 'index'), 'not an index')

    const snapshot = await readProject(root)

    expect(snapshot.files).toEqual([])
    expect(snapshot.selection).toBe('none')
    expect(snapshot.skipped).toEqual([
      {
        path: '.',
        reason: 'refused: git could not list the files this repository tracks, so none was read',
      },
    ])
  })
})

describe('readProject where git cannot be trusted to answer', () => {
  it('reads nothing when the repository names another directory as its work tree', async () => {
    // `core.worktree` is the repository's own configuration: git answers
    // about the directory it names, and a listing of that one is not a
    // listing of this.
    const root = await repository({ 'package.json': '{"name":"x"}\n' }, { 'notes.md': 'UNTRACKED\n' })
    git(root, 'config', 'core.worktree', await temp())

    const snapshot = await readProject(root)

    expect(snapshot.selection).toBe('none')
    expect(snapshot.files).toEqual([])
  })

  it('reads nothing from a checkout whose .git file leads nowhere', async () => {
    // A submodule or a worktree copied out of its superproject: git says "not
    // a git repository", and the `.git` beside the files says it is one.
    const root = await temp()
    await write(root, {
      '.git': 'gitdir: ../.git/modules/app\n',
      'package.json': '{"name":"x"}\n',
      'notes.md': 'UNTRACKED\n',
    })

    const snapshot = await readProject(root)

    expect(snapshot.selection).toBe('none')
    expect(JSON.stringify(snapshot)).not.toContain('UNTRACKED')
  })

  describe('with no git on the PATH', () => {
    const withPath = async <T>(value: string, run: () => Promise<T>): Promise<T> => {
      const saved = process.env['PATH']
      process.env['PATH'] = value
      try {
        return await run()
      } finally {
        process.env['PATH'] = saved
      }
    }

    it('reads nothing beside a .git', async () => {
      const root = await repository({ 'package.json': '{"name":"x"}\n' }, { 'notes.md': 'UNTRACKED\n' })

      const snapshot = await withPath('', () => readProject(root))

      expect(snapshot.selection).toBe('none')
      expect(snapshot.files).toEqual([])
    })

    it('walks a directory with no .git', async () => {
      const root = await temp()
      await write(root, { 'package.json': '{"name":"x"}\n' })

      const snapshot = await withPath('', () => readProject(root))

      expect(snapshot.selection).toBe('walk')
      expect(pathsOf(snapshot)).toEqual(['package.json'])
    })

    it('never runs a git the inspected repository ships', async () => {
      // On Windows, a program is looked up in the working directory before
      // the PATH, so a `git.exe` at the root of the inspected repository ran.
      // A relative PATH entry does the same on every system, and is how this
      // test reaches the rule: git must not be looked up from the repository.
      const root = await repository({ 'package.json': '{"name":"x"}\n' })
      const marker = path.join(await temp(), 'ran')
      await writeFile(path.join(root, 'git'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 })

      const snapshot = await withPath(`.${path.delimiter}${process.env['PATH'] ?? ''}`, () => readProject(root))

      await expect(stat(marker)).rejects.toThrow()
      expect(snapshot.selection).toBe('git')
    })
  })
})

describe('readProject outside a git repository', () => {
  it('walks the directory with the whole filter, and says it did', async () => {
    // A fresh project, or a directory a test made: nothing is tracked because
    // nothing CAN be. Refusing would leave a service that is not committed yet
    // without an inspection; the walk is today's, with every rule, and the
    // selection is stated so the CLI can say so.
    const root = await temp()
    await write(root, { 'package.json': '{"name":"x"}\n', '.env': 'X=NOT-A-REPOSITORY\n' })

    const snapshot = await readProject(root)

    expect(pathsOf(snapshot)).toEqual(['package.json'])
    expect(JSON.stringify(snapshot.files)).not.toContain('NOT-A-REPOSITORY')
    expect(snapshot.selection).toBe('walk')
  })
})

/**
 * The whole path from a hostile repository to what the model is sent: the
 * snapshot, the Inspector's opening message, and every answer its two read
 * tools can give — `list_files`, and `read_file` on every path that was read
 * AND every path that was withheld.
 */
describe('what the Inspector is sent carries no secret', () => {
  const SECRETS = [
    join('sk-a', 'nt-api03-') + body(93, `${ALNUM}-_`) + 'AA',
    join('sk-p', 'roj-') + body(120, `${ALNUM}-_`, 5),
    join('github', '_pat_') + body(22) + '_' + body(59, ALNUM, 7),
    join('g', 'hp_') + body(36, ALNUM, 11),
    join('glp', 'at-') + body(20, ALNUM, 13),
    join('xo', 'xb-') + '1234567890-9876543210-' + body(24, ALNUM, 17),
    join('AK', 'IA') + body(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 19),
    join('AI', 'za') + body(35, ALNUM, 23),
    join('sk_', 'live_') + body(24, ALNUM, 29),
    join('Qx7', 'mPz2Lw9'),
    join('Adm1n', 'Prod!'),
  ]
  // What a reviewer saw reach the model after the filter was rewritten: a
  // value on the next line, a flag, a compound key, a quoted comma, a URL with
  // no user, an XML element, a subscript, a JSON escape. Twelve generated
  // characters each, distinct, so a leak names its file.
  const REVIEWED = Array.from({ length: 7 }, (_, index) => body(12, ALNUM, 31 + index * 2))
  const [nextLine, flag, compound, comma, redis, xml, subscript] = REVIEWED as [
    string, string, string, string, string, string, string,
  ]
  const escaped = join('k-a', 'nt-api03-') + body(93, `${ALNUM}-_`, 41) + 'AA'
  const [anthropic, openai, pat, ghp, glpat, slack, aws, google, stripe, urlPassword, literal] =
    SECRETS as [string, string, string, string, string, string, string, string, string, string, string]

  const HOSTILE = {
    'package.json': JSON.stringify(
      { name: 'billing-api', dependencies: { jsonwebtoken: '^9.0.2', pg: '^8.11.0' } },
      null,
      2,
    ),
    'chart/values.yaml': 'auth:\n  existingSecret: billing-db\n',
    'config/llm.yaml': `anthropic: ${anthropic}\n`,
    'src/client.py': `client = OpenAI("${openai}")\n`,
    'scripts/clone.sh': `git clone https://x-access-token:${pat}@github.com/acme/x.git\n`,
    'docs/setup.md': `Use ${ghp} or ${glpat} for now.\n`,
    'config/notify.yml': `slack: ${slack}\ngoogle: ${google}\n`,
    'deploy/aws.tf': `access_key = "${aws}"\n`,
    'config/billing.rb': `Stripe.api_key = '${stripe}'\n`,
    'config/database.yml': `url: postgres://billing:${urlPassword}@db/billing\n`,
    'docker-compose.yml':
      'services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: ${DB_PASSWORD}\n' +
      `  admin:\n    environment:\n      PGADMIN_DEFAULT_PASSWORD: ${literal}\n`,
    'config/app.yml': `db:\n  password:\n    !${nextLine}\n`,
    Dockerfile: `FROM mysql:8\nRUN mysqladmin -u root --password=${flag} ping\n`,
    'config/jwt.yml': `jwtsecret: ${compound}\n`,
    'config/comma.yml': `password: "Q7,${comma}"\n`,
    'redis.properties': `redis.url=redis://:${redis}@cache:6379/0\n`,
    'settings.xml': `<settings><servers><server><password>${xml}</password></server></servers></settings>\n`,
    'src/settings.py': `config['password'] = '${subscript}'\n`,
    'deploy/values.json': `{"llm": {"anthropic": "\\u0073${escaped}"}}\n`,
  }
  const WITHHELD = [...SECRETS, ...REVIEWED, escaped]

  const capturing = (turns: GenerateResult[]): LlmClient & { seen: GenerateRequest[] } => {
    const client = {
      seen: [] as GenerateRequest[],
      generate: async (request: GenerateRequest): Promise<GenerateResult> => {
        client.seen.push({ ...request, transcript: [...request.transcript] })
        return turns[client.seen.length - 1] ?? { text: '', toolCalls: [], finishReason: 'stop' }
      },
    }
    return client
  }

  it('from a git repository, tracked secrets and an untracked .env alike', async () => {
    const root = await repository(HOSTILE, { '.env': `ANTHROPIC_API_KEY=${anthropic}\n` })
    const snapshot = await readProject(root)

    const tools = buildProjectTools(snapshot)
    const outcomes = [
      tools.run({ id: 'l', name: 'list_files', args: {} }),
      ...[...snapshot.files.map((file) => file.path), ...snapshot.skipped.map((one) => one.path)]
        .map((wanted, index) => tools.run({ id: `r${index}`, name: 'read_file', args: { path: wanted } })),
    ]
    const reads = snapshot.files.map((file, index) => ({
      id: `c${index}`,
      name: 'read_file',
      args: { path: file.path },
    }))
    const client = capturing([
      { text: '', toolCalls: [{ id: 'l', name: 'list_files', args: {} }], finishReason: 'tool-calls' },
      { text: '', toolCalls: reads.slice(0, 4), finishReason: 'tool-calls' },
      { text: '', toolCalls: reads.slice(4, 8), finishReason: 'tool-calls' },
      { text: '', toolCalls: [{ id: 'f', name: REPORT_TOOL, args: {} }], finishReason: 'tool-calls' },
    ])
    const events: AgentEvent[] = []
    await inspect(client, snapshot, (event) => void events.push(event))

    const sent = JSON.stringify({ snapshot, outcomes, seen: client.seen, events })
    for (const secret of WITHHELD) expect(sent).not.toContain(secret)
    // And the manifests are still there to be read: a filter that refused
    // everything would pass the line above.
    expect(pathsOf(snapshot)).toEqual(['chart/values.yaml', 'package.json'])
  })

  it('from a directory git does not know, the same', async () => {
    const root = await temp()
    await write(root, { ...HOSTILE, '.env': `ANTHROPIC_API_KEY=${anthropic}\n` })
    const snapshot = await readProject(root)

    const sent = JSON.stringify(snapshot)
    for (const secret of WITHHELD) expect(sent).not.toContain(secret)
    expect(pathsOf(snapshot)).toEqual(['chart/values.yaml', 'package.json'])
  })
})

describe('the CLI says how the application repository was read', () => {
  const FACTS = {
    name: 'billing-api',
    type: 'service',
    lifecycle: 'production',
    runtime: 'node',
    owner: 'group:default/tiger',
    forgeHandle: '@acme/platform',
  }
  const reporting = (): LlmClient => ({
    generate: async (request: GenerateRequest): Promise<GenerateResult> =>
      request.agent === 'inspector'
        ? { text: '', toolCalls: [{ id: 'f', name: REPORT_TOOL, args: FACTS }], finishReason: 'tool-calls' }
        : { text: '', toolCalls: [], finishReason: 'stop' },
  })

  const run = async (args: string[], deps: Parameters<typeof main>[1]) => {
    const err: string[] = []
    const code = await main(args, {
      events: () => undefined,
      ...deps,
      out: () => undefined,
      err: (chunk) => void err.push(chunk),
    })
    return { code, err: err.join('') }
  }

  const declarations = async (): Promise<string> => {
    const repo = path.join(await temp(), 'IaC')
    await runInitPlatform({ root: repo, owner: '@acme/platform', version: '0.0.0-test' })
    return repo
  }

  it('names a project that is not a git repository, on stderr', async () => {
    const project = await temp()
    await write(project, { 'package.json': '{"name":"billing-api"}\n' })

    const { err } = await run(['plan', 'declare billing-api', '--repo', await declarations(), '--project', project], {
      client: reporting(),
      env: {},
    })

    expect(err).toContain(
      `${path.basename(project)} is not a git repository: the Inspector read every file the filter let through, untracked ones included`,
    )
  })

  it('says nothing of the kind for a git repository', async () => {
    const project = await repository({ 'package.json': '{"name":"billing-api"}\n' })

    const { err } = await run(['plan', 'declare billing-api', '--repo', await declarations(), '--project', project], {
      client: reporting(),
      env: {},
    })

    expect(err).not.toContain('is not a git repository')
  })

  it('refuses init in the home directory, before a model is chosen', async () => {
    // security-3: `plan` has skipped the home directory since #63; `init` read
    // it whole. A terminal opens in `~`.
    const home = await temp('idp-home-')
    await write(home, { 'package.json': '{"name":"stray"}\n', 'Documents/salaries.csv': 'x\n' })
    let called = false
    const client: LlmClient = {
      generate: async () => {
        called = true
        return { text: '', toolCalls: [], finishReason: 'stop' }
      },
    }

    const { code, err } = await run(['init'], { cwd: home, env: { HOME: home }, client })

    expect(code).toBe(2)
    expect(err).toContain('is your home directory')
    expect(called).toBe(false)
  })

  it('refuses init at the filesystem root', async () => {
    const { code, err } = await run(['init', '--project', path.parse(process.cwd()).root], {
      env: {},
      client: reporting(),
    })

    expect(code).toBe(2)
    expect(err).toContain('is the filesystem root')
  })
})
