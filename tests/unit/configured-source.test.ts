import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runInitPlatform } from '../../src/cli/commands/init.js'
import { main, type MainDeps } from '../../src/cli/index.js'
import { sourceOf } from '../../src/cli/source.js'
import type { LlmClient } from '../../src/llm/client.js'

/**
 * A declarations repository configured once — `IDP_REPO`, or `repo:` in the
 * personal configuration file — and read from anywhere.
 *
 * `graph`, `show` and `ask` take the first of: `--repo` or `--demo`, the working
 * directory when it is a declarations repository, `IDP_REPO`, the file's
 * `repo`, the demo SI. `plan` takes `--repo`, `IDP_REPO`, the file — never the
 * working directory, which is the service it declares — and refuses without
 * one. Every environment here is injected, so nothing reads the developer's.
 */

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const EXAMPLES = path.resolve(import.meta.dirname, '../../examples')

/** One entity the demo SI does not declare, so a hit on it proves which SI was read. */
const LEDGER = [
  '---',
  'apiVersion: backstage.io/v1alpha1',
  'kind: Resource',
  'metadata:',
  '  name: ledger-db-prod',
  'spec:',
  '  type: database',
  '  owner: group:default/tiger',
  '',
].join('\n')

interface World {
  /** A directory that is no repository at all: where the user stands, usually. */
  elsewhere: string
  /** `IaC`, as `init platform` writes it, holding the ledger. */
  iac: string
  /** `demo-copy`, a copy of the demo SI: it declares billing-db-prod and no ledger. */
  demo: string
  /** HOME, holding nothing until `configure` writes the file. */
  home: string
}

const world = async (): Promise<World> => {
  const parent = await mkdtemp(path.join(tmpdir(), 'configured-source-'))
  const elsewhere = path.join(parent, 'elsewhere')
  const iac = path.join(parent, 'IaC')
  const demo = path.join(parent, 'demo-copy')
  const home = path.join(parent, 'home')
  await mkdir(elsewhere)
  await mkdir(home)
  await runInitPlatform({ root: iac, owner: '@acme/platform', version: '0.0.0' })
  await writeFile(path.join(iac, 'catalog', 'databases', 'ledger-db-prod.yml'), LEDGER, 'utf8')
  await cp(FIXTURES, demo, { recursive: true })
  return { elsewhere, iac, demo, home }
}

/** Writes `~/.config/idp-agent/config.yml` under the world's HOME. */
const configure = async (w: World, text: string): Promise<string> => {
  const file = path.join(w.home, '.config', 'idp-agent', 'config.yml')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, text, 'utf8')
  return file
}

const run = async (
  argv: string[],
  deps: MainDeps & { env: Record<string, string | undefined> },
): Promise<{ code: number; out: string; err: string; lines: string[] }> => {
  const out: string[] = []
  const err: string[] = []
  const code = await main(argv, {
    root: FIXTURES,
    ...deps,
    out: (chunk) => void out.push(chunk),
    err: (chunk) => void err.push(chunk),
  })
  const text = err.join('')
  return {
    code,
    out: out.join(''),
    err: text,
    lines: text.split('\n').filter((line) => line !== ''),
  }
}

/** A client that must never be called: the source is decided before any model is. */
const untouchable = (): LlmClient & { calls: number } => {
  const client = {
    calls: 0,
    generate: async (): Promise<never> => {
      client.calls += 1
      throw new Error('no model may be called here')
    },
  }
  return client
}

const DEMO = /demo SI/
const HOME_FILE = '~/.config/idp-agent/config.yml'

describe('graph and show with IDP_REPO, from anywhere', () => {
  it.each([
    [['show', 'ledger-db-prod']],
    [['graph', '--type', 'database']],
  ])('%j read it, and say so in one line naming the folder and IDP_REPO', async (argv) => {
    const w = await world()
    const { code, out, lines } = await run(argv, {
      cwd: w.elsewhere,
      env: { IDP_REPO: w.iac, HOME: w.home },
    })
    expect(code).toBe(0)
    expect(out).toContain('ledger-db-prod')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^reading the declarations repository IaC \(IDP_REPO\)/)
    expect(lines[0]).not.toMatch(DEMO)
  })

  it('refuses a relative IDP_REPO with 2: a default set once names one repository from every directory', async () => {
    // Relative to the working directory, an exported IDP_REPO would name a
    // different repository in each — and `IDP_REPO=.` would make the service
    // `plan` declares its own declarations repository.
    const w = await world()
    for (const IDP_REPO of ['../IaC', '.', 'IaC']) {
      for (const [argv, cwd] of [
        [['show', 'ledger-db-prod'], w.elsewhere],
        [['plan', '--from', path.join(EXAMPLES, 'declare-database.json')], w.iac],
      ] as const) {
        const { code, out, err, lines } = await run([...argv], { cwd, env: { IDP_REPO } })
        expect(code).toBe(2)
        expect(out).toBe('')
        expect(lines).toHaveLength(1)
        expect(err).toContain(`IDP_REPO=${IDP_REPO} is relative`)
        expect(err).toContain('absolute or start with ~')
        expect(err).not.toMatch(/^reading/m)
      }
    }
  })

  it.each([['/.'], ['/catalog/..'], ['/']])(
    'names an IDP_REPO written <repository>%s by its folder, never as . or ..',
    async (suffix) => {
      const w = await world()
      for (const argv of [
        ['show', 'ledger-db-prod'],
        ['plan', '--from', path.join(EXAMPLES, 'declare-database.json')],
      ]) {
        const { code, lines } = await run(argv, {
          cwd: w.elsewhere,
          env: { IDP_REPO: `${w.iac}${suffix}` },
        })
        expect(code).toBe(0)
        expect(lines[0]).toMatch(/^reading the declarations repository IaC \(IDP_REPO\)/)
      }
    },
  )

  it('locates it with the path rules of the platform it is handed', async () => {
    // A Windows path is absolute on Windows: refused as missing, not as relative.
    const refusal = sourceOf(
      { command: 'plan' },
      {
        cwd: () => {
          throw new Error('an absolute IDP_REPO needs no working directory')
        },
        env: { IDP_REPO: 'C:\\nowhere\\IaC' },
        platform: 'win32',
      },
    )
    await expect(refusal).rejects.toThrow('IDP_REPO=C:\\nowhere\\IaC is not a directory')
  })

  it('expands a ~ that reached it quoted', async () => {
    const w = await world()
    const inHome = path.join(w.home, 'IaC')
    await cp(w.iac, inHome, { recursive: true })
    const { code, lines } = await run(['show', 'ledger-db-prod'], {
      cwd: w.elsewhere,
      env: { IDP_REPO: '~/IaC', HOME: w.home },
    })
    expect(code).toBe(0)
    expect(lines[0]).toMatch(/IaC \(IDP_REPO\)/)
  })

  it('treats an empty IDP_REPO as unset, as every IDP_ variable is', async () => {
    const w = await world()
    const { code, err } = await run(['show', 'ledger-db-prod'], {
      cwd: w.elsewhere,
      env: { IDP_REPO: '' },
    })
    expect(code).toBe(1)
    expect(err).toMatch(DEMO)
  })

  it('refuses one that is not a directory with 2, naming IDP_REPO, and never falls back to the demo', async () => {
    const w = await world()
    const missing = path.join(w.elsewhere, 'nowhere')
    for (const argv of [['graph'], ['show', 'billing-db-prod']]) {
      const { code, out, err } = await run(argv, { cwd: w.elsewhere, env: { IDP_REPO: missing } })
      expect(code).toBe(2)
      expect(err).toContain('IDP_REPO')
      expect(err).toContain(missing)
      expect(err).toContain('is not a directory')
      expect(err).not.toMatch(DEMO)
      expect(out).toBe('')
    }
  })

  it('refuses it for ask too, before any model is called', async () => {
    const w = await world()
    const client = untouchable()
    const { code, err } = await run(['ask', 'which databases are there?'], {
      cwd: w.elsewhere,
      env: { IDP_REPO: path.join(w.elsewhere, 'nowhere') },
      client,
    })
    expect(code).toBe(2)
    expect(err).toContain('IDP_REPO')
    expect(client.calls).toBe(0)
  })

  it('reads a directory that is not detected as a declarations repository: it was named', async () => {
    const w = await world()
    const application = path.join(w.elsewhere, 'billing-api')
    await mkdir(application)
    await writeFile(path.join(application, 'mkdocs.yml'), 'site_name: Billing API\n', 'utf8')
    const { code, out, err } = await run(['graph'], {
      cwd: w.elsewhere,
      env: { IDP_REPO: application },
    })
    expect(code).toBe(1)
    expect(out).toContain('No entity matches')
    expect(err).not.toMatch(DEMO)
    // The line that blames the flag blames what named the repository instead.
    expect(err).toContain('billing-api declares no entity; IDP_REPO names the declarations repository')
  })
})

describe('graph and show with the personal configuration file', () => {
  it('reads its repo from anywhere, and names the file in its one line', async () => {
    const w = await world()
    await configure(w, `repo: ${w.iac}\n`)
    const { code, out, lines } = await run(['show', 'ledger-db-prod'], {
      cwd: w.elsewhere,
      env: { HOME: w.home },
    })
    expect(code).toBe(0)
    expect(out).toContain('ledger-db-prod')
    expect(lines).toEqual([
      `reading the declarations repository IaC (${HOME_FILE}); --repo <directory> reads another, --demo the fictional SI`,
    ])
  })

  it('finds it under XDG_CONFIG_HOME, and names it whole there', async () => {
    const w = await world()
    const xdg = path.join(path.dirname(w.home), 'xdg')
    const file = path.join(xdg, 'idp-agent', 'config.yml')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, 'repo: ../../IaC\n', 'utf8')
    const { code, lines } = await run(['show', 'ledger-db-prod'], {
      cwd: w.elsewhere,
      env: { XDG_CONFIG_HOME: xdg },
    })
    expect(code).toBe(0)
    expect(lines[0]).toContain(`IaC (${file})`)
  })

  it('expands ~ and resolves a relative repo against the file, not the working directory', async () => {
    const w = await world()
    await cp(w.iac, path.join(w.home, 'IaC'), { recursive: true })
    for (const repo of ['~/IaC', '../../IaC']) {
      await configure(w, `repo: ${repo}\n`)
      const { code, lines } = await run(['show', 'ledger-db-prod'], {
        cwd: w.elsewhere,
        env: { HOME: w.home },
      })
      expect(code).toBe(0)
      expect(lines[0]).toContain(`IaC (${HOME_FILE})`)
    }
  })

  it('is overridden by IDP_REPO, and not even read then', async () => {
    const w = await world()
    await configure(w, `repo: ${w.demo}\n`)
    const overridden = await run(['show', 'ledger-db-prod'], {
      cwd: w.elsewhere,
      env: { HOME: w.home, IDP_REPO: w.iac },
    })
    expect(overridden.code).toBe(0)
    expect(overridden.lines[0]).toMatch(/IaC \(IDP_REPO\)/)

    // First match wins: a file nobody consulted cannot refuse the run.
    await configure(w, 'repos: [unclosed\n')
    const unread = await run(['show', 'ledger-db-prod'], {
      cwd: w.elsewhere,
      env: { HOME: w.home, IDP_REPO: w.iac },
    })
    expect(unread.code).toBe(0)
  })

  it('refuses a repo that is not a directory with 2, naming the file', async () => {
    const w = await world()
    await configure(w, 'repo: /nowhere/at/all\n')
    const { code, out, err } = await run(['graph'], { cwd: w.elsewhere, env: { HOME: w.home } })
    expect(code).toBe(2)
    expect(err).toContain(HOME_FILE)
    expect(err).toContain('/nowhere/at/all is not a directory')
    expect(err).not.toMatch(DEMO)
    expect(out).toBe('')
  })

  it.each([
    ['a repo holding an escape sequence and a line break', 'repo: "/nowhere/\\e[31mRED\\nsecond line"\n'],
    ['a key holding an escape sequence', '"\\e[31mrepo": /srv/IaC\n'],
    ['a file that is not YAML, quoted back over several lines', 'repo: [unclosed\nother: x\n'],
  ])('refuses %s in one line, with no escape sequence in it', async (_, text) => {
    // What the file says is whatever someone wrote there, as a folder's name is.
    const w = await world()
    await configure(w, text)
    const { code, err, lines } = await run(['graph'], { cwd: w.elsewhere, env: { HOME: w.home } })
    expect(code).toBe(2)
    expect(err).toContain(HOME_FILE)
    expect(err).not.toContain('\u001b')
    expect(lines).toHaveLength(1)
  })

  it('refuses an IDP_REPO holding an escape sequence in one line, with none in it', async () => {
    const w = await world()
    const { code, err, lines } = await run(['graph'], {
      cwd: w.elsewhere,
      env: { IDP_REPO: '/nowhere/\u001b[31mRED\nsecond line' },
    })
    expect(code).toBe(2)
    expect(err).toContain('IDP_REPO=')
    expect(err).not.toContain('\u001b')
    expect(lines).toHaveLength(1)
  })

  it.each([
    ['a misspelt key', 'repos: /srv/IaC\n', 'repos'],
    ['a credential', 'repo: /srv/IaC\ntoken: s3cret\n', 'token'],
    ['a file that is not YAML', 'repo: [unclosed\n', 'is not YAML'],
  ])('refuses %s with 2, naming the file', async (_, text, named) => {
    const w = await world()
    await configure(w, text)
    const { code, out, err } = await run(['show', 'ledger-db-prod'], {
      cwd: w.elsewhere,
      env: { HOME: w.home },
    })
    expect(code).toBe(2)
    expect(err).toContain(HOME_FILE)
    expect(err).toContain(named)
    expect(err).not.toMatch(DEMO)
    expect(out).toBe('')
  })

  it('reads the demo SI when the file sets no repo, as when there is no file', async () => {
    const w = await world()
    await configure(w, '')
    const { code, err } = await run(['show', 'billing-db-prod'], {
      cwd: w.elsewhere,
      env: { HOME: w.home },
    })
    expect(code).toBe(0)
    expect(err).toMatch(DEMO)
  })
})

describe('what wins over a configured repository', () => {
  it('the declarations repository the user stands in', async () => {
    const w = await world()
    await configure(w, `repo: ${w.demo}\n`)
    const { code, out, lines } = await run(['show', 'ledger-db-prod'], {
      cwd: w.iac,
      env: { HOME: w.home, IDP_REPO: w.demo },
    })
    expect(code).toBe(0)
    expect(out).toContain('ledger-db-prod')
    expect(lines).toEqual([
      'reading the declarations repository IaC (the current directory); --repo <directory> reads another, --demo the fictional SI',
    ])
  })

  it('--repo, silently', async () => {
    const w = await world()
    await configure(w, `repo: ${w.iac}\n`)
    const { code, out, err } = await run(['show', 'billing-db-prod', '--repo', w.demo], {
      cwd: w.iac,
      env: { HOME: w.home, IDP_REPO: w.iac },
    })
    expect(code).toBe(0)
    expect(out).toContain('reached by services')
    expect(err).toBe('')
  })

  it('--repo, even when what is configured would be refused', async () => {
    const w = await world()
    await configure(w, 'repos: typo\n')
    const { code } = await run(['show', 'billing-db-prod', '--repo', w.demo], {
      cwd: w.elsewhere,
      env: { HOME: w.home, IDP_REPO: '/nowhere/at/all' },
    })
    expect(code).toBe(0)
  })

  it('--demo', async () => {
    const w = await world()
    await configure(w, `repo: ${w.iac}\n`)
    const { code, err } = await run(['show', 'ledger-db-prod', '--demo'], {
      cwd: w.iac,
      env: { HOME: w.home, IDP_REPO: w.iac },
    })
    expect(code).toBe(1)
    expect(err).toMatch(DEMO)
    expect(err).not.toMatch(/IDP_REPO\)|current directory/)
  })
})

describe('the demo SI, when nothing names a repository', () => {
  it('says how to make one the default', async () => {
    const w = await world()
    const { code, lines } = await run(['show', 'billing-db-prod'], {
      cwd: w.elsewhere,
      env: { HOME: w.home },
    })
    expect(code).toBe(0)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(DEMO)
    expect(lines[0]).toContain('--repo <directory>')
    expect(lines[0]).toContain('IDP_REPO')
    expect(lines[0]).toContain(HOME_FILE)
  })
})

describe('plan with a configured declarations repository', () => {
  const FROM = path.join(EXAMPLES, 'declare-database.json')

  it.each([
    ['IDP_REPO', (w: World) => ({ IDP_REPO: w.iac }), 'IDP_REPO'],
    ['the file', (w: World) => ({ HOME: w.home }), HOME_FILE],
  ])('previews against %s with no --repo, from anywhere, and says so', async (_, env, origin) => {
    const w = await world()
    await configure(w, `repo: ${w.iac}\n`)
    const { code, out, err } = await run(['plan', '--from', FROM], {
      cwd: w.elsewhere,
      env: env(w),
    })
    expect(code).toBe(0)
    expect(out).toContain('+++ b/catalog/databases/orders-db-prod.yml')
    expect(err).toMatch(new RegExp(`^reading the declarations repository IaC \\(${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`))
    expect(err).not.toMatch(DEMO)
  })

  it('reaches the model check for an intent: the repository is no longer what is missing', async () => {
    const w = await world()
    const { code, err } = await run(['plan', 'declare the database orders-db-prod in prod'], {
      cwd: w.elsewhere,
      env: { IDP_REPO: w.iac },
    })
    expect(code).toBe(2)
    expect(err).toMatch(/no model configured/)
    expect(err).not.toContain('plan needs --repo')
  })

  it('never takes the working directory as its declarations repository', async () => {
    // For plan the working directory is the service being declared.
    const w = await world()
    const { code, out, err } = await run(['plan', '--from', FROM], { cwd: w.iac, env: {} })
    expect(code).toBe(2)
    expect(out).toBe('')
    expect(err).toContain('plan needs --repo <directory>')
    expect(err).toContain('IDP_REPO')
    expect(err).toContain('config.yml')
    expect(err).not.toMatch(/^reading/m)
    // The usage printed after it no longer says --repo is required.
    expect(err).toContain('plan --from <plan.json> [--repo <directory>]')
    expect(err).toContain('plan "<intent>" [--repo <directory>]')
    expect(err).not.toMatch(/ --repo <directory> \[--json\]/)
  })

  it('takes --repo over what is configured, without consulting it', async () => {
    const w = await world()
    await configure(w, 'repos: typo\n')
    const { code, err } = await run(['plan', '--from', FROM, '--repo', w.iac], {
      cwd: w.elsewhere,
      env: { HOME: w.home, IDP_REPO: '/nowhere/at/all' },
    })
    expect(code).toBe(0)
    expect(err).not.toMatch(/^reading/m)
  })

  it('refuses a configured path that is not a directory with 2, naming where it came from', async () => {
    const w = await world()
    const viaVariable = await run(['plan', '--from', FROM], {
      cwd: w.elsewhere,
      env: { IDP_REPO: '/nowhere/at/all' },
    })
    expect(viaVariable.code).toBe(2)
    expect(viaVariable.err).toContain('IDP_REPO')

    await configure(w, 'repo: /nowhere/at/all\n')
    const viaFile = await run(['plan', '--from', FROM], { cwd: w.elsewhere, env: { HOME: w.home } })
    expect(viaFile.code).toBe(2)
    expect(viaFile.err).toContain(HOME_FILE)
  })
})
