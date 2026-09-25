import { cp, mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runInitPlatform } from '../../src/cli/commands/init.js'
import { main, type MainDeps } from '../../src/cli/index.js'
import type {
  AgentName,
  GenerateRequest,
  GenerateResult,
  LlmClient,
} from '../../src/llm/client.js'

/**
 * `ask`, `graph` and `show` over a declarations repository named by `--repo`,
 * and over the demo SI when none is named — which they must then say.
 *
 * Every repository here is a scratch copy of the demo SI, placed under a
 * scratch working directory and named RELATIVELY: `--repo` is resolved against
 * `MainDeps.cwd`, never against wherever the test runner stands.
 */

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/si-demo')

/** One entity the demo SI does not declare, so a hit on it proves which SI was read. */
const LEDGER = [
  '---',
  'apiVersion: backstage.io/v1alpha1',
  'kind: Resource',
  'metadata:',
  '  name: ledger-db-prod',
  '  annotations:',
  '    company.fr/env: prod',
  'spec:',
  '  type: database',
  '  owner: group:default/tiger',
  '  dependsOn:',
  '    - resource:default/mysql-prod-01',
  '',
].join('\n')

/** A working directory holding `iac/`, a copy of the demo SI plus `extra` files. */
const workspace = async (extra: Record<string, string> = {}): Promise<string> => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'read-repo-'))
  await cp(FIXTURES, path.join(cwd, 'iac'), { recursive: true })
  for (const [file, content] of Object.entries(extra)) {
    await writeFile(path.join(cwd, 'iac', file), content, 'utf8')
  }
  return cwd
}

const run = async (
  argv: string[],
  deps: MainDeps = {},
): Promise<{ code: number; out: string; err: string }> => {
  const out: string[] = []
  const err: string[] = []
  const code = await main(argv, {
    // The demo root, pinned, so the no-flag path is the same SI the copies are
    // made of whatever the default resolves to.
    root: FIXTURES,
    ...deps,
    out: (chunk) => void out.push(chunk),
    err: (chunk) => void err.push(chunk),
  })
  return { code, out: out.join(''), err: err.join('') }
}

const DEMO = /demo SI/

describe('graph and show without --repo', () => {
  it.each([
    [['graph', '--env', 'prod']],
    [['show', 'billing-db-prod']],
  ])('%j says on stderr, once, that the SI is the fictional demo', async (argv) => {
    const { code, out, err } = await run(argv)
    expect(code).toBe(0)
    const lines = err.split('\n').filter((line) => line !== '')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(DEMO)
    expect(lines[0]).toMatch(/fictional/)
    expect(lines[0]).toContain('--repo')
    // stdout is the answer and stays pipeable.
    expect(out).not.toMatch(DEMO)
  })

  it('does not say it for validate, which reads the directory it was handed', async () => {
    const cwd = await workspace()
    const { err } = await run(['validate', path.join(cwd, 'iac')])
    expect(err).not.toMatch(DEMO)
  })
})

describe('graph and show with --repo', () => {
  it('gives the answer the demo gives over a copy of it, with no demo line', async () => {
    const cwd = await workspace()
    for (const argv of [['graph'], ['graph', '--env', 'prod'], ['show', 'billing-db-prod']]) {
      const demo = await run(argv)
      const repo = await run([...argv, '--repo', 'iac'], { cwd })
      expect(repo.code).toBe(demo.code)
      expect(repo.out).toBe(demo.out)
      expect(repo.err).toBe('')
    }
  })

  it('accepts --repo=<directory> too', async () => {
    const cwd = await workspace()
    const { code, out, err } = await run(['show', '--repo=iac', 'billing-db-prod'], { cwd })
    expect(code).toBe(0)
    expect(out).toContain('reached by services')
    expect(err).toBe('')
  })

  it('finds a name only the repository declares, which the demo does not', async () => {
    const cwd = await workspace({ 'catalog/databases/ledger-db-prod.yml': LEDGER })

    const repo = await run(['show', 'ledger-db-prod', '--repo', 'iac'], { cwd })
    expect(repo.code).toBe(0)
    expect(repo.out).toContain('resource:default/ledger-db-prod')

    const demo = await run(['show', 'ledger-db-prod'], { cwd })
    expect(demo.code).toBe(1)
    expect(demo.out).toContain('No entity named')
  })

  it('reports a malformed file by its repository path and answers from the rest', async () => {
    const cwd = await workspace({
      'catalog/databases/broken-db-prod.yml':
        'apiVersion: backstage.io/v1alpha1\nkind: Resource\nmetadata:\n  name: broken-db-prod\n',
    })
    const { code, out, err } = await run(['graph', '--env', 'prod', '--repo', 'iac'], { cwd })
    expect(code).toBe(0)
    expect(err).toMatch(/^skipped catalog\/databases\/broken-db-prod\.yml: /m)
    expect(out).toContain('billing-db-prod')
  })

  it.each([
    ['a path that is not there', async (cwd: string) => void cwd, 'nowhere'],
    [
      'a file',
      async (cwd: string) => writeFile(path.join(cwd, 'plan.json'), '{}', 'utf8'),
      'plan.json',
    ],
  ])('refuses %s with 2, naming it', async (_, arrange, repo) => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'read-repo-bad-'))
    await arrange(cwd)
    for (const argv of [['graph'], ['show', 'billing-db-prod']]) {
      const { code, out, err } = await run([...argv, '--repo', repo], { cwd })
      expect(code).toBe(2)
      expect(err).toContain(repo)
      expect(err).toContain('declarations repository')
      expect(err).not.toMatch(DEMO)
      expect(out).toBe('')
    }
  })

  it.each([
    [['graph', '--repo=']],
    [['graph', '--repo', '']],
    [['show', 'billing-db-prod', '--repo=']],
    [['show', 'billing-db-prod', '--repo', ' ']],
  ])('refuses an empty --repo with 2 rather than reading the working directory: %j', async (argv) => {
    // `--repo "$IAC"` with the variable unset. The working directory here IS a
    // declarations repository, so reading it would answer — from the wrong place.
    const cwd = path.join(await workspace(), 'iac')
    const { code, out, err } = await run(argv, { cwd })
    expect(code).toBe(2)
    expect(err).toContain('--repo names the declarations repository')
    expect(err).not.toMatch(DEMO)
    expect(out).toBe('')
  })

  it('reports every file it rejected and does not blame the flag when none survived', async () => {
    // The files are entity declarations that do not parse: the repository is
    // the right one, and "declares no entity" would send the user to look for
    // another.
    const cwd = await mkdtemp(path.join(tmpdir(), 'read-repo-rejected-'))
    await mkdir(path.join(cwd, 'iac', 'catalog'), { recursive: true })
    await writeFile(path.join(cwd, 'iac', 'catalog', 'a.yml'), 'kind: Resource\n', 'utf8')
    await writeFile(path.join(cwd, 'iac', 'catalog', 'b.yml'), 'x: [\n', 'utf8')

    const { code, out, err } = await run(['graph', '--repo', 'iac'], { cwd })

    expect(code).toBe(1)
    expect(out).toContain('No entity matches')
    expect(err).toMatch(/^skipped catalog\/a\.yml: /m)
    expect(err).toMatch(/^skipped catalog\/b\.yml: /m)
    expect(err).not.toMatch(/declares no entity/)
    expect(err).not.toMatch(DEMO)
  })

  describe('over a repository that is also a Backstage catalogue', () => {
    const group = (name: string): string =>
      `---\napiVersion: backstage.io/v1alpha1\nkind: Group\nmetadata:\n  name: ${name}\nspec:\n  type: team\n  children: []\n`
    const user =
      '---\napiVersion: backstage.io/v1alpha1\nkind: User\nmetadata:\n  name: jdoe\nspec:\n  memberOf: [tiger]\n'
    const MKDOCS = 'site_name: Declarations\nnav:\n  - Home: index.md\n'

    it('sums up what it did not load in one line, never one per document', async () => {
      const cwd = await workspace({
        'teams.yml': `${group('tiger')}\n${group('lion')}`,
        'jdoe.yml': user,
        'mkdocs.yml': MKDOCS,
      })

      const { code, out, err } = await run(['graph', '--env', 'prod', '--repo', 'iac'], { cwd })

      expect(code).toBe(0)
      expect(out).toContain('billing-db-prod')
      expect(err.split('\n').filter((line) => line.startsWith('not loaded:'))).toEqual([
        'not loaded: 4 documents this tool does not model (Group ×2, User ×1, not an entity ×1)',
      ])
      // Set aside, not refused: nothing about them reads as a failure.
      expect(err).not.toMatch(/skipped/)
      expect(err).not.toMatch(/tiger|lion|jdoe|mkdocs/)
    })

    it('does not call dangling a reference to a document it set aside', async () => {
      // The API is in the repository and counted as not loaded; "dangling"
      // would say it is not there at all.
      const ledger = LEDGER.replace(
        '    - resource:default/mysql-prod-01\n',
        '    - resource:default/mysql-prod-01\n    - api:default/ledger-events\n',
      )
      const cwd = await workspace({
        'ledger.yml': ledger,
        'ledger-events.yml':
          '---\napiVersion: backstage.io/v1alpha1\nkind: API\nmetadata:\n  name: ledger-events\n',
      })

      const { code, out, err } = await run(['graph', '--env', 'prod', '--repo', 'iac'], { cwd })

      expect(code).toBe(0)
      expect(out).toContain('ledger-db-prod')
      expect(err).toContain('not loaded: 1 document this tool does not model (API ×1)')
      expect(out).not.toMatch(/dangling/)
    })

    it('does not blame the flag for a repository holding only catalogue documents', async () => {
      // An organisation's catalogue — Groups and Users — is a catalogue, and
      // "--repo names the declarations repository" would send the user
      // looking for another one.
      const cwd = await mkdtemp(path.join(tmpdir(), 'read-repo-org-'))
      await mkdir(path.join(cwd, 'iac'), { recursive: true })
      await writeFile(path.join(cwd, 'iac', 'tiger.yml'), group('tiger'), 'utf8')

      const { code, err } = await run(['graph', '--repo', 'iac'], { cwd })

      expect(code).toBe(1)
      expect(err).toContain('not loaded: 1 document this tool does not model (Group ×1)')
      expect(err).not.toMatch(/declares no entity/)
    })

    it('still points at the flag when nothing it read was catalogue at all', async () => {
      // A mkdocs.yml and nothing else is what an application repository
      // looks like, which is the mistake that line exists for.
      const cwd = await mkdtemp(path.join(tmpdir(), 'read-repo-app-'))
      await mkdir(path.join(cwd, 'app'), { recursive: true })
      await writeFile(path.join(cwd, 'app', 'mkdocs.yml'), MKDOCS, 'utf8')

      const { err } = await run(['graph', '--repo', 'app'], { cwd })

      expect(err).toContain('not loaded: 1 document this tool does not model (not an entity ×1)')
      expect(err).toMatch(/declares no entity/)
    })
  })

  it('says so when the repository declares no entity, rather than looking like a miss', async () => {
    // The likeliest way to get here is `--repo` pointed at an application
    // repository instead of the declarations one.
    const cwd = await mkdtemp(path.join(tmpdir(), 'read-repo-empty-'))
    const { code, out, err } = await run(['graph', '--repo', '.'], { cwd })
    expect(code).toBe(1)
    expect(out).toContain('No entity matches')
    expect(err).toMatch(/no entity/)
    expect(err).not.toMatch(DEMO)
    // By its folder, never as the `.` it was typed as.
    expect(err).toContain(`${path.basename(cwd)} declares no entity`)
  })
})

/**
 * A declarations repository as `init platform` writes one, named `IaC` like
 * the owner's, holding the ledger — so a hit on it proves which SI was read —
 * inside a scratch directory that is not one itself.
 */
const scaffolded = async (): Promise<{ parent: string; repo: string }> => {
  const parent = await mkdtemp(path.join(tmpdir(), 'read-repo-standing-'))
  const repo = path.join(parent, 'IaC')
  await runInitPlatform({ root: repo, owner: '@acme/platform', version: '0.0.0' })
  await writeFile(path.join(repo, 'catalog', 'databases', 'ledger-db-prod.yml'), LEDGER, 'utf8')
  return { parent, repo }
}

const STANDING = /^reading the declarations repository IaC \(the current directory\)/

describe('graph and show without --repo, standing in a declarations repository', () => {
  it.each([
    [['graph', '--env', 'prod']],
    [['show', 'ledger-db-prod']],
  ])('%j reads it, and says so on stderr in one line naming its folder', async (argv) => {
    const { repo } = await scaffolded()
    const { code, out, err } = await run(argv, { cwd: repo })
    expect(code).toBe(0)
    expect(out).toContain('ledger-db-prod')
    const lines = err.split('\n').filter((line) => line !== '')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(STANDING)
    expect(lines[0]).toContain('--repo')
    expect(lines[0]).toContain('--demo')
    expect(err).not.toMatch(DEMO)
    expect(out).not.toMatch(/current directory/)
  })

  it('gives the answer --repo . gives there, less the line', async () => {
    const { repo } = await scaffolded()
    for (const argv of [['graph'], ['show', 'ledger-db-prod']]) {
      const standing = await run(argv, { cwd: repo })
      const named = await run([...argv, '--repo', '.'], { cwd: repo })
      expect(standing.code).toBe(named.code)
      expect(standing.out).toBe(named.out)
      expect(named.err).not.toMatch(/current directory/)
    }
  })

  it('reads the demo SI from the folder above it: markers at the root, never a walk', async () => {
    const { parent } = await scaffolded()
    const { code, out, err } = await run(['show', 'ledger-db-prod'], { cwd: parent })
    expect(code).toBe(1)
    expect(out).toContain('No entity named')
    expect(err).toMatch(DEMO)
  })

  it('reads the demo SI from an application repository, which is not a declarations one', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'read-repo-application-'))
    await writeFile(
      path.join(cwd, 'catalog-info.yaml'),
      'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: billing-api\n',
      'utf8',
    )
    const demo = await run(['graph', '--env', 'prod'])
    const { code, out, err } = await run(['graph', '--env', 'prod'], { cwd })
    expect(code).toBe(demo.code)
    expect(out).toBe(demo.out)
    expect(err).toBe(demo.err)
    expect(err).toMatch(DEMO)
  })

  it('reads the demo SI there when --demo says so, with its own line', async () => {
    const { repo } = await scaffolded()
    const { code, out, err } = await run(['show', 'ledger-db-prod', '--demo'], { cwd: repo })
    expect(code).toBe(1)
    expect(out).toContain('No entity named')
    expect(err).toMatch(DEMO)
    expect(err).not.toMatch(/current directory/)
  })

  it('reads the repository --repo names, not the one it stands in', async () => {
    const { repo } = await scaffolded()
    await cp(FIXTURES, path.join(repo, '..', 'demo-copy'), { recursive: true })
    const { code, out, err } = await run(['show', 'billing-db-prod', '--repo', '../demo-copy'], {
      cwd: repo,
    })
    expect(code).toBe(0)
    expect(out).toContain('reached by services')
    expect(err).toBe('')
  })

  it.each([
    [['graph', '--demo', '--repo', '.']],
    [['show', 'ledger-db-prod', '--repo=.', '--demo']],
    [['ask', '--demo', '--repo', '.', 'which database holds the ledger?']],
  ])('refuses --demo with --repo with 2, reading neither: %j', async (argv) => {
    const { repo } = await scaffolded()
    const client = scripted(LEDGER_TURNS)
    const { code, out, err } = await run(argv, { cwd: repo, client })
    expect(code).toBe(2)
    // Its own refusal, not the unknown-option error `--demo` got before it existed.
    expect(err).toContain('--repo <directory> or --demo, never both')
    // The notice, not the help text printed after the refusal, which names the demo SI.
    expect(err).not.toMatch(/^reading/m)
    expect(out).toBe('')
    expect(client.seen).toEqual([])
  })

  it('does not blame --repo for an empty repository it stands in: nobody passed it', async () => {
    // Freshly scaffolded, which is a real state, and read because its
    // witnesses say what it is — so the one line is the standing one.
    const parent = await mkdtemp(path.join(tmpdir(), 'read-repo-standing-empty-'))
    const repo = path.join(parent, 'IaC')
    await runInitPlatform({ root: repo, owner: '@acme/platform', version: '0.0.0' })
    const { code, out, err } = await run(['graph'], { cwd: repo })
    expect(code).toBe(1)
    expect(out).toContain('No entity matches')
    const lines = err.split('\n').filter((line) => line !== '')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(STANDING)
  })

  it('flattens a folder name that carries escape sequences into its line', async () => {
    const { parent, repo } = await scaffolded()
    const hostile = path.join(parent, 'IaC\u001b[2J\u001b[31mred\nsecond')
    await rename(repo, hostile)
    const { code, err } = await run(['show', 'ledger-db-prod'], { cwd: hostile })
    expect(code).toBe(0)
    expect(err).toMatch(/^reading the declarations repository IaC/)
    expect(err).toContain('(the current directory)')
    expect(err).not.toContain('\u001b')
    expect(err.split('\n').filter((line) => line !== '')).toHaveLength(1)
  })
})

describe('graph and show when the working directory is gone', () => {
  // A shell can stand in a directory someone removed; process.cwd() then
  // throws. The demo SI needs no working directory, so neither --demo nor
  // the road that falls back to it may fail on one.
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const gone = (): void => {
    vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw Object.assign(new Error('ENOENT: no such file or directory, uv_cwd'), {
        code: 'ENOENT',
      })
    })
  }

  it.each([
    [['graph', '--env', 'prod', '--demo']],
    [['graph', '--env', 'prod']],
    [['show', 'billing-db-prod', '--demo']],
    [['show', 'billing-db-prod']],
  ])('%j reads the demo SI and says so', async (argv) => {
    gone()
    const { code, out, err } = await run(argv)
    expect(code).toBe(0)
    expect(out).toContain('billing-db-prod')
    expect(err.split('\n').filter((line) => line !== '')).toEqual([expect.stringMatching(DEMO)])
  })

  it('reads the demo SI when the injected working directory does not exist', async () => {
    const cwd = path.join(await mkdtemp(path.join(tmpdir(), 'read-repo-gone-')), 'nowhere')
    const { code, err } = await run(['show', 'billing-db-prod'], { cwd })
    expect(code).toBe(0)
    expect(err).toMatch(DEMO)
  })
})

/** Turns per agent, and every request kept as that turn saw it. */
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
      return turns[request.agent]?.[index] ?? { text: '', toolCalls: [], finishReason: 'stop' }
    },
  }
}

const calling = (name: string, args: unknown): GenerateResult => ({
  text: '',
  toolCalls: [{ id: `call-${name}`, name, args }],
  finishReason: 'tool-calls',
})

/** A model that looks for the ledger and answers with what the tool returned. */
const LEDGER_TURNS = {
  supervisor: [{ text: 'QUESTION', toolCalls: [], finishReason: 'stop' }],
  analyst: [
    calling('search_entities', { nameContains: 'ledger' }),
    calling('answer', { outcome: 'entities', refs: ['resource:default/ledger-db-prod'] }),
  ],
} satisfies Partial<Record<AgentName, GenerateResult[]>>

describe('ask with --repo', () => {
  it("answers from the repository's entities, through the Analyst's own tools", async () => {
    const cwd = await workspace({ 'catalog/databases/ledger-db-prod.yml': LEDGER })
    const client = scripted(LEDGER_TURNS)

    const { code, out, err } = await run(
      ['ask', '--repo', 'iac', 'which', 'database', 'holds', 'the', 'ledger?'],
      { cwd, client },
    )

    expect(code).toBe(0)
    expect(out).toContain('resource:default/ledger-db-prod')
    expect(err).not.toMatch(DEMO)
    // The tool the model called read the repository: the row came from it.
    const results = client.seen
      .flatMap((request) => request.transcript)
      .filter((turn) => turn.role === 'tool')
    expect(JSON.stringify(results)).toContain('ledger-db-prod')
  })

  it('never hands the flag to the model as part of the question', async () => {
    const cwd = await workspace({ 'catalog/databases/ledger-db-prod.yml': LEDGER })
    const client = scripted(LEDGER_TURNS)

    await run(['ask', 'which database holds the ledger?', '--repo=iac'], { cwd, client })

    const said = client.seen
      .flatMap((request) => request.transcript)
      .filter((turn) => turn.role === 'user')
      .map((turn) => turn.text)
    expect(said.join('\n')).toContain('which database holds the ledger?')
    expect(said.join('\n')).not.toContain('--repo')
  })

  it('cannot answer with the ledger from the demo SI, which does not declare it', async () => {
    // The control: the same turns, no flag. The witness check refuses a
    // reference no tool returned, so this is exit 3 and not a quiet hit.
    const client = scripted(LEDGER_TURNS)
    const { code, err } = await run(['ask', 'which database holds the ledger?'], { client })
    expect(code).toBe(3)
    expect(err).toMatch(DEMO)
  })

  it('answers from the repository it stands in when no --repo is given', async () => {
    const { repo } = await scaffolded()
    const { code, out, err } = await run(['ask', 'which database holds the ledger?'], {
      cwd: repo,
      client: scripted(LEDGER_TURNS),
    })
    expect(code).toBe(0)
    expect(out).toContain('resource:default/ledger-db-prod')
    expect(err).toMatch(STANDING)
    expect(err).not.toMatch(DEMO)
  })

  it('reads the demo SI with --demo, standing in the same repository', async () => {
    const { repo } = await scaffolded()
    const { code, err } = await run(['ask', '--demo', 'which database holds the ledger?'], {
      cwd: repo,
      client: scripted(LEDGER_TURNS),
    })
    expect(code).toBe(3)
    expect(err).toMatch(DEMO)
  })

  it('refuses an empty --repo with 2 and never reaches the model', async () => {
    const cwd = path.join(await workspace(), 'iac')
    const client = scripted(LEDGER_TURNS)
    const { code, err } = await run(['ask', 'which database holds the ledger?', '--repo='], {
      cwd,
      client,
    })
    expect(code).toBe(2)
    expect(err).toContain('ask --repo names the declarations repository')
    expect(client.seen).toEqual([])
  })

  it('refuses an unknown option with 2 and never reaches the model', async () => {
    const client = scripted(LEDGER_TURNS)
    const { code } = await run(['ask', '--wat', 'which database holds the ledger?'], { client })
    expect(code).toBe(2)
    expect(client.seen).toEqual([])
  })
})
