import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigError } from '../../src/cli/config.js'
import {
  personalConfigFile,
  readPersonalConfig,
  shownPath,
} from '../../src/cli/personal.js'

/**
 * The personal configuration: `$XDG_CONFIG_HOME/idp-agent/config.yml`, else
 * `~/.config/idp-agent/config.yml`, else — on Windows — under `APPDATA`. Never
 * committed, never a credential, and located from the environment it is handed
 * alone, so no test here can reach the developer's own.
 */

describe('where the personal configuration lives', () => {
  it('is under XDG_CONFIG_HOME when that is set', () => {
    expect(personalConfigFile({ XDG_CONFIG_HOME: '/xdg', HOME: '/home/ada' }, 'linux')).toBe(
      '/xdg/idp-agent/config.yml',
    )
  })

  it('is under ~/.config otherwise, on macOS as on Linux', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      expect(personalConfigFile({ HOME: '/home/ada' }, platform)).toBe(
        '/home/ada/.config/idp-agent/config.yml',
      )
    }
  })

  it('ignores an XDG_CONFIG_HOME that is empty or relative, as the XDG specification says', () => {
    for (const XDG_CONFIG_HOME of ['', 'relative/config']) {
      expect(personalConfigFile({ XDG_CONFIG_HOME, HOME: '/home/ada' }, 'linux')).toBe(
        '/home/ada/.config/idp-agent/config.yml',
      )
    }
  })

  it('is under APPDATA on Windows, where there is no ~/.config', () => {
    expect(
      personalConfigFile(
        { APPDATA: 'C:\\Users\\ada\\AppData\\Roaming', USERPROFILE: 'C:\\Users\\ada' },
        'win32',
      ),
    ).toBe('C:\\Users\\ada\\AppData\\Roaming\\idp-agent\\config.yml')
  })

  it('is under XDG_CONFIG_HOME on Windows too, when someone set it', () => {
    expect(
      personalConfigFile({ XDG_CONFIG_HOME: 'D:\\config', APPDATA: 'C:\\AppData' }, 'win32'),
    ).toBe('D:\\config\\idp-agent\\config.yml')
  })

  it('is nowhere when the environment names no home: never the process’s own', () => {
    expect(personalConfigFile({}, 'linux')).toBeUndefined()
    expect(personalConfigFile({}, 'win32')).toBeUndefined()
  })

  it('is shown under ~ when it is in the home directory, and whole otherwise', () => {
    const env = { HOME: '/home/ada' }
    expect(shownPath('/home/ada/.config/idp-agent/config.yml', env, 'linux')).toBe(
      '~/.config/idp-agent/config.yml',
    )
    expect(shownPath('/xdg/idp-agent/config.yml', env, 'linux')).toBe('/xdg/idp-agent/config.yml')
    // A prefix of the name is not the directory.
    expect(shownPath('/home/adam/config.yml', env, 'linux')).toBe('/home/adam/config.yml')
  })
})

/** A scratch XDG_CONFIG_HOME holding `text` as the configuration, and the file's path. */
const configured = async (
  text: string | undefined,
): Promise<{ home: string; xdg: string; file: string; env: Record<string, string> }> => {
  // Two directories, so the file is not under HOME and is named whole.
  const home = await mkdtemp(path.join(tmpdir(), 'personal-home-'))
  const xdg = await mkdtemp(path.join(tmpdir(), 'personal-xdg-'))
  const file = path.join(xdg, 'idp-agent', 'config.yml')
  await mkdir(path.dirname(file), { recursive: true })
  if (text !== undefined) await writeFile(file, text, 'utf8')
  return { home, xdg, file, env: { XDG_CONFIG_HOME: xdg, HOME: home } }
}

describe('reading the personal configuration', () => {
  it('returns nothing when there is no file, which is not an error', async () => {
    const { env } = await configured(undefined)
    expect(await readPersonalConfig(env, 'linux')).toBeUndefined()
  })

  it('returns nothing when no file can be located at all', async () => {
    expect(await readPersonalConfig({}, 'linux')).toBeUndefined()
  })

  it('reads an empty file as one that sets nothing', async () => {
    const { env, file } = await configured('')
    const config = await readPersonalConfig(env, 'linux')
    expect(config?.file).toBe(file)
    expect(config?.repo).toBeUndefined()
  })

  it('reads an absolute repo as it is written', async () => {
    const { env } = await configured('repo: /srv/IaC\n')
    expect((await readPersonalConfig(env, 'linux'))?.repo).toBe('/srv/IaC')
  })

  it('expands ~ against HOME', async () => {
    const { env, home } = await configured('repo: ~/work/IaC\n')
    expect((await readPersonalConfig(env, 'linux'))?.repo).toBe(path.join(home, 'work/IaC'))
    const bare = await configured('repo: "~"\n')
    expect((await readPersonalConfig(bare.env, 'linux'))?.repo).toBe(bare.home)
  })

  it('resolves a relative repo against the file’s own directory, never the working one', async () => {
    const { env, xdg } = await configured('repo: ../../IaC\n')
    // The file is <xdg>/idp-agent/config.yml, so ../.. is <xdg>'s parent.
    expect((await readPersonalConfig(env, 'linux'))?.repo).toBe(path.join(path.dirname(xdg), 'IaC'))
  })

  it('refuses a ~ it cannot expand, naming the file', async () => {
    const { xdg, file } = await configured('repo: ~/IaC\n')
    const reading = readPersonalConfig({ XDG_CONFIG_HOME: xdg }, 'linux')
    await expect(reading).rejects.toThrow(ConfigError)
    await expect(readPersonalConfig({ XDG_CONFIG_HOME: xdg }, 'linux')).rejects.toThrow(file)
  })

  it.each([
    ['a misspelt key', 'repos: /srv/IaC\n', /repos/],
    ['a credential, which has no field', 'repo: /srv/IaC\ntoken: s3cret\n', /token/],
    ['an empty repo', 'repo: ""\n', /repo/],
    ['a repo that is not a string', 'repo: 3\n', /repo/],
    ['a list instead of a mapping', '- /srv/IaC\n', /configuration/],
  ])('refuses %s, naming the file and the key', async (_, text, key) => {
    const { env, file } = await configured(text)
    const reading = readPersonalConfig(env, 'linux')
    await expect(reading).rejects.toThrow(ConfigError)
    await expect(readPersonalConfig(env, 'linux')).rejects.toThrow(key)
    await expect(readPersonalConfig(env, 'linux')).rejects.toThrow(file)
  })

  it.each([['repo: ~\n'], ['repo:\n'], ['repo: null\n']])(
    'refuses %j as empty, and says a bare ~ is YAML’s null that must be quoted',
    async (text) => {
      const { env, file } = await configured(text)
      await expect(readPersonalConfig(env, 'linux')).rejects.toThrow(ConfigError)
      await expect(readPersonalConfig(env, 'linux')).rejects.toThrow(
        `${file}: repo is empty — a bare ~ is YAML's null; write repo: "~" to name the home directory`,
      )
    },
  )

  it('refuses a file that is not YAML, naming it', async () => {
    const { env, file } = await configured('repo: [unclosed\n')
    await expect(readPersonalConfig(env, 'linux')).rejects.toThrow(ConfigError)
    await expect(readPersonalConfig(env, 'linux')).rejects.toThrow(`${file} is not YAML`)
  })

  it('refuses a file it cannot read, rather than calling it absent', async () => {
    const { env, file } = await configured(undefined)
    await mkdir(file)
    await expect(readPersonalConfig(env, 'linux')).rejects.toThrow(`cannot read ${file}`)
  })

  it('names the file under ~ when it lives there', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'personal-home-'))
    const file = path.join(home, '.config', 'idp-agent', 'config.yml')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, 'repos: x\n', 'utf8')
    await expect(readPersonalConfig({ HOME: home }, 'linux')).rejects.toThrow(
      '~/.config/idp-agent/config.yml is not a configuration',
    )
  })
})

describe('the suite never reads the developer’s own configuration', () => {
  // tests/setup/personal.ts: IDP_REPO removed, XDG_CONFIG_HOME pointed into the
  // run directory. Every `main` a test calls without an injected `env` reads
  // `process.env`, so without it a developer's IDP_REPO or config.yml would
  // silently change what half the suite reads.
  it('has no IDP_REPO', () => {
    expect(process.env['IDP_REPO']).toBeUndefined()
  })

  it('locates the configuration inside the run directory', () => {
    const file = personalConfigFile(process.env)
    expect(file).toBeDefined()
    expect(path.relative(tmpdir(), file ?? '/').startsWith('..')).toBe(false)
    // And nothing is there: a run directory is created empty for each run.
    expect(existsSync(file ?? '/')).toBe(false)
  })

  it('hands the same to a process a test starts, such as the CLI', () => {
    const child = spawnSync(
      process.execPath,
      ['-p', "JSON.stringify([process.env.XDG_CONFIG_HOME, process.env.IDP_REPO ?? null])"],
      { encoding: 'utf8' },
    )
    expect(JSON.parse(child.stdout)).toEqual([process.env['XDG_CONFIG_HOME'], null])
  })
})
