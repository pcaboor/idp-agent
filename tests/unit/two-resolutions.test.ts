import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runInitPlatform } from '../../src/cli/commands/init.js'
import type { Env } from '../../src/cli/personal.js'
import { declarationsFor, sourceOf, type SourceContext } from '../../src/cli/source.js'

/**
 * A run resolves twice: what it reads (`sourceOf`) and what a change is decided
 * against (`declarationsFor`, `plan`'s chain). With no Backstage configured the
 * two are one repository — every run today — and these rows say so road by
 * road, before slice 1.5 gives the read a source the change never takes.
 */

interface World {
  /** A directory that is no repository at all: where the user stands. */
  elsewhere: string
  /** `IaC`, as `init platform` writes it: its markers make it one. */
  iac: string
  /** HOME, holding nothing until a road writes the personal file. */
  home: string
}

/** What a road sets: the flags typed, the directory stood in, the environment, the file. */
interface Road {
  repo?: string
  demo?: boolean
  cwd?: string
  env?: Env
  /** The personal file's text, written under the world's HOME. */
  file?: string
}

const world = async (): Promise<World> => {
  const parent = await mkdtemp(path.join(tmpdir(), 'two-resolutions-'))
  const elsewhere = path.join(parent, 'elsewhere')
  const iac = path.join(parent, 'IaC')
  const home = path.join(parent, 'home')
  await mkdir(elsewhere)
  await mkdir(home)
  await runInitPlatform({ root: iac, owner: '@acme/platform', version: '0.0.0' })
  return { elsewhere, iac, home }
}

/** The context a road resolves in: the world's HOME, never the developer's. */
const contextOf = async (w: World, road: Road): Promise<SourceContext> => {
  if (road.file !== undefined) {
    const file = path.join(w.home, '.config', 'idp-agent', 'config.yml')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, road.file, 'utf8')
  }
  return { cwd: () => road.cwd ?? w.elsewhere, env: { HOME: w.home, ...road.env } }
}

const requestOf = (road: Road): { command: 'idpa'; repo?: string; demo?: boolean } => ({
  command: 'idpa',
  ...(road.repo !== undefined ? { repo: road.repo } : {}),
  ...(road.demo !== undefined ? { demo: road.demo } : {}),
})

describe('what a change is decided against, resolved apart from what the run reads', () => {
  // One row per road of the chain, each in a world of its own.
  it.each<[string, (w: World) => Road, ((w: World) => object) | undefined]>([
    ['--repo', (w) => ({ repo: w.iac }), (w) => ({ kind: 'repo', root: w.iac, origin: { by: 'flag' } })],
    [
      'the working directory',
      (w) => ({ cwd: w.iac }),
      (w) => ({ kind: 'repo', root: w.iac, origin: { by: 'working-directory' } }),
    ],
    [
      'IDP_REPO',
      (w) => ({ env: { IDP_REPO: w.iac } }),
      (w) => ({ kind: 'repo', root: w.iac, origin: { by: 'variable', name: 'IDP_REPO' } }),
    ],
    [
      'the file',
      (w) => ({ file: `repo: ${w.iac}\n` }),
      // The file as notices and blame show it: under HOME, so written from `~`.
      (w) => ({
        kind: 'repo',
        root: w.iac,
        origin: { by: 'file', file: path.join('~', '.config', 'idp-agent', 'config.yml') },
      }),
    ],
    ['--demo', (w) => ({ demo: true, env: { IDP_REPO: w.iac } }), undefined],
    ['nothing', () => ({}), undefined],
  ])('%s', async (_, roadOf, expectedOf) => {
    const w = await world()
    const road = roadOf(w)
    const context = await contextOf(w, road)
    const declarations = await declarationsFor(requestOf(road), context)
    expect(declarations).toEqual(expectedOf === undefined ? undefined : expect.objectContaining(expectedOf(w)))
    // And the read resolves the same repository, or the demo SI where no
    // change is decided: with no Backstage the two resolutions are one.
    const read = await sourceOf(requestOf(road), context)
    expect(read).toEqual(declarations ?? expect.objectContaining({ kind: 'demo' }))
  })

  it('refuses what the read refuses, naming the command that was typed', async () => {
    const w = await world()
    const missing = path.join(w.elsewhere, 'missing')
    await expect(
      declarationsFor({ command: 'idpa' }, await contextOf(w, { env: { IDP_REPO: 'relative' } })),
    ).rejects.toThrow(/IDP_REPO=relative is relative/)
    await expect(
      declarationsFor({ command: 'idpa' }, await contextOf(w, { env: { IDP_REPO: missing } })),
    ).rejects.toThrow(/is not a directory; IDP_REPO names the declarations repository idpa reads/)
    await expect(
      declarationsFor({ command: 'idpa', repo: missing }, await contextOf(w, {})),
    ).rejects.toThrow(/idpa --repo names the declarations repository/)
  })
})
