import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { closingLines } from '../../src/cli/render/footer.js'
import { DOOR_WORDS } from '../support/fake-gh.js'
import type { DoorEntry } from '../support/github-answers.js'
import {
  LIVE_DOORS,
  QUEUED_PAUSES_MS,
  doorLine,
  doorOutcome,
  doorRefusals,
  queuedOutcome,
  type DoorRun,
  type LiveContext,
  type LiveDoor,
  type Observation,
} from '../live/github/doors.js'
import {
  GH_TOKEN_VARIABLES,
  LIVE_VARIABLES,
  cleanupTargets,
  liveBaseOf,
  mentionRenderedAsCode,
  liveGitEnvironment,
  liveRepository,
  neverMerged,
  remembered,
  reviewerConfigDir,
  reviewerEnvironment,
  scrubLiveEnvironment,
  stampedBranches,
} from '../live/guard.js'

/**
 * The live test reaches GitHub with the owner's own gh and git (stage 6 brief
 * § 10), so the default suite must never collect it: `vitest.config.ts`
 * excludes `tests/live/**`, and loads the floor under every child process.
 * The live configuration, `vitest.live.config.ts`, collects it and nothing
 * else, behind a guard that refuses to start without `IDP_GITHUB_LIVE_REPO`
 * (stage 6 plan, Task 6.4.1). What decides what the live run sends to GitHub
 * — the second account's environment, the test's own git's, which doors may
 * be sent, how GitHub's answer to one is read, what the cleanup may delete —
 * is pure, in `tests/live/guard.ts` and `tests/live/github/doors.ts`, and
 * proved here, since the default suite never collects the live file. This
 * file names no door: the words it needs are taken from `DOOR_WORDS` and from
 * `LIVE_DOORS`' own vectors.
 *
 * Read as text, never imported: importing a configuration calls
 * `enterRunDirectory()` in a worker whose pid is not the run's, which would
 * make a second run directory. What vitest collects is asked of vitest itself,
 * in a child process, with `list --filesOnly`, which globs and imports no test
 * file and no setup file.
 */

const ROOT = path.resolve(import.meta.dirname, '../..')
const CONFIG = path.join(ROOT, 'vitest.config.ts')
const LIVE_CONFIG = path.join(ROOT, 'vitest.live.config.ts')
const LIVE_TEST = 'tests/live/github/submit.live.test.ts'

/** The test files vitest would run under `config`, relative to the root, as `vitest list --filesOnly` names them. */
const listed = (config: string): string[] => {
  const json = execFileSync(
    process.execPath,
    [path.join(ROOT, 'node_modules/vitest/vitest.mjs'), 'list', '--filesOnly', '--json', '--config', config],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  return (JSON.parse(json) as { file: string }[]).map((entry) => path.relative(ROOT, entry.file).split(path.sep).join('/'))
}

describe('the default test configuration', () => {
  it('excludes tests/live/, keeping vitest’s own exclusions', async () => {
    // An `exclude` of our own replaces vitest's defaults, node_modules among
    // them, so they are spread first.
    const text = await readFile(CONFIG, 'utf8')
    expect(text).toContain("exclude: [...configDefaults.exclude, 'tests/live/**']")
    expect(text).toContain("include: ['tests/**/*.test.ts']")
  })

  it('loads the floor under every child process in every worker', async () => {
    const text = await readFile(CONFIG, 'utf8')
    const files = /setupFiles:\s*\[([^\]]*)\]/.exec(text)?.[1] ?? ''
    expect(files).toContain("'tests/setup/forge.ts'")
  })
})

describe('the live configuration', () => {
  it('loads tests/live/setup.ts and no other setup file, and no global setup', async () => {
    const text = await readFile(LIVE_CONFIG, 'utf8')
    expect(/setupFiles:\s*\[([^\]]*)\]/.exec(text)?.[1]?.trim()).toBe("'tests/live/setup.ts'")
    expect(text).not.toMatch(/globalSetup/)
    // Nothing of the default suite's floor: the live test reaches GitHub on purpose.
    expect(text).not.toMatch(/tests\/setup\//)
    expect(text).not.toMatch(/enterRunDirectory/)
  })

  it('collects tests/live/**/*.live.test.ts and nothing else, one file at a time, within § 15’s bound', async () => {
    const text = await readFile(LIVE_CONFIG, 'utf8')
    expect(text).toContain("include: ['tests/live/**/*.live.test.ts']")
    expect(text).toMatch(/fileParallelism:\s*false/)
    expect(text).toMatch(/testTimeout:\s*180_000/)
    expect(text).toMatch(/hookTimeout:\s*180_000/)
  })

  it('runs the steps in the order written, each once: no shuffle, nothing concurrent, no retry', async () => {
    const text = await readFile(LIVE_CONFIG, 'utf8')
    expect(text).toContain('sequence: { shuffle: false, concurrent: false }')
    expect(text).toMatch(/retry:\s*0,/)
    // And the live file refuses a step run twice or early, whatever the command line asked: its
    // ORDER is the order its steps are written in, every step of the answers file but the two hooks'.
    const live = await readFile(path.join(ROOT, LIVE_TEST), 'utf8')
    const written = [...live.matchAll(/^ {2}step\('(\w+)'/gm)].map(([, key]) => key)
    const order = /const ORDER: readonly StepKey\[\] = \[([^\]]*)\]/.exec(live)?.[1]?.match(/\w+/g) ?? []
    expect(order).toEqual(written)
    expect(written).toEqual(['baseRoutes', 'submitted', 'again', 'proposedAgain', 'competing', 'doors', 'afterApproval', 'noted'])
    expect(live).toContain("if (steps[key] !== 'not-run') throw new Error(")
  })

  it('runs its own git in liveGitEnvironment’s environment, never the owner’s whole one', async () => {
    const live = await readFile(path.join(ROOT, LIVE_TEST), 'utf8')
    const calls = [...live.matchAll(/run\('git',[\s\S]*?\}\)/g)].map(([call]) => call)
    expect(calls.length).toBeGreaterThanOrEqual(5)
    for (const call of calls) expect(call).not.toContain('ownerEnv')
    expect(live).toContain('const gitEnv: NodeJS.ProcessEnv = liveGitEnvironment(ownerEnv)')
    expect(live).toContain('const env = { ...gitEnv, GIT_INDEX_FILE: index }')
  })

  it('observes a queued door before judging it, and looks at what the run opened before its cleanup and after it', async () => {
    const live = await readFile(path.join(ROOT, LIVE_TEST), 'utf8')
    // tryDoor: a queued door is judged on what was observed after it, never on its 2xx.
    const tryDoor = /async function tryDoor\([\s\S]*?\n\}\n/.exec(live)?.[0] ?? ''
    expect(tryDoor).toContain("if (answered.reason === 'queued')")
    expect(tryDoor).toContain('queuedOutcome(answered, observations, context.baseSha)')
    expect(tryDoor).toContain('doorLine(')
    // The end: one look before the cleanup closes anything, one inside it before its directory goes,
    // the verdict recorded, and the run failing when it is not true.
    const hook = /afterAll\(async \(\) => \{([\s\S]*?)\n\}\)/.exec(live)?.[1] ?? ''
    expect(hook.indexOf('looks.push(await endLook())')).toBeGreaterThan(-1)
    expect(hook.indexOf('looks.push(await endLook())')).toBeLessThan(hook.indexOf('await cleanup()'))
    expect(hook.indexOf('neverMerged(looks, ')).toBeGreaterThan(hook.indexOf('await cleanup()'))
    expect(hook.indexOf('await record()')).toBeLessThan(hook.indexOf('throw new Error('))
    const cleanup = /async function cleanup\([\s\S]*?\n\}\n/.exec(live)?.[0] ?? ''
    expect(cleanup.indexOf('looks.push(await endLook())')).toBeGreaterThan(-1)
    expect(cleanup.indexOf('looks.push(await endLook())')).toBeLessThan(cleanup.indexOf('await rm(temporary'))
    expect(live).toContain("measured.neverMerged === true")
  })

  it('is what pnpm test:live:github runs, and nothing else runs it', async () => {
    const { scripts } = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(scripts['test:live:github']).toBe('vitest run --config vitest.live.config.ts')
    const others = Object.entries(scripts).filter(([name, script]) => name !== 'test:live:github' && /live/.test(script))
    expect(others).toEqual([])
    // CI runs the five commands, never the live test: it needs a logged-in gh.
    const ci = await readFile(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')
    expect(ci).not.toMatch(/test:live|vitest\.live/)
  })

  it('lists tests/live/github/submit.live.test.ts, and the default configuration does not', () => {
    expect(listed(LIVE_CONFIG)).toEqual([LIVE_TEST])
    const defaults = listed(CONFIG)
    expect(defaults.length).toBeGreaterThan(100)
    expect(defaults.filter((file) => file.startsWith('tests/live/'))).toEqual([])
  })
})

describe('the live guard', () => {
  const NOT_SET =
    'IDP_GITHUB_LIVE_REPO is not set: the live test runs only on purpose, against your throwaway repository ' +
    '(docs/submitting.md, "Proving it on your repository").'

  it('throws on an environment without IDP_GITHUB_LIVE_REPO, naming the variable', () => {
    expect(() => liveRepository({})).toThrow(NOT_SET)
    expect(() => liveRepository({ IDP_GITHUB_LIVE_REPO: '' })).toThrow(NOT_SET)
    // Another case of the name is not the variable.
    expect(() => liveRepository({ idp_github_live_repo: 'acme/idpa-live' })).toThrow(NOT_SET)
  })

  it('refuses a repository without idpa-live in its name, a URL, a third segment and an owner outside the login grammar, never quoting the value', () => {
    const refused = [
      'acme/iac',
      'acme/idpa-liv',
      'https://github.com/acme/idpa-live',
      'git@github.com:acme/idpa-live.git',
      'acme/idpa-live/extra',
      '-acme/idpa-live',
      'ac_me/idpa-live',
      'robot[bot]/idpa-live',
      `${'a'.repeat(40)}/idpa-live`,
      'acme/idpa-live with space',
      'acme/..',
      'acme',
      '/idpa-live',
    ]
    for (const value of refused) {
      let message = ''
      try {
        liveRepository({ IDP_GITHUB_LIVE_REPO: value })
      } catch (error) {
        message = (error as Error).message
      }
      expect(message, value).toMatch(/^IDP_GITHUB_LIVE_REPO /)
      expect(message, value).not.toContain(value)
    }
  })

  it('accepts acme/idpa-live and acme/my-idpa-live-2', () => {
    expect(liveRepository({ IDP_GITHUB_LIVE_REPO: 'acme/idpa-live' })).toEqual({ owner: 'acme', name: 'idpa-live' })
    expect(liveRepository({ IDP_GITHUB_LIVE_REPO: 'acme/my-idpa-live-2' })).toEqual({ owner: 'acme', name: 'my-idpa-live-2' })
  })

  it('refuses a relative reviewer directory, and answers undefined when it is unset', () => {
    expect(reviewerConfigDir({})).toBeUndefined()
    expect(reviewerConfigDir({ IDP_GITHUB_LIVE_REVIEWER_GH_CONFIG_DIR: '' })).toBeUndefined()
    expect(reviewerConfigDir({ IDP_GITHUB_LIVE_REVIEWER_GH_CONFIG_DIR: '/home/ada/.config/gh-idpa-reviewer' })).toBe(
      '/home/ada/.config/gh-idpa-reviewer',
    )
    expect(() => reviewerConfigDir({ IDP_GITHUB_LIVE_REVIEWER_GH_CONFIG_DIR: '.config/gh-idpa-reviewer' })).toThrow(
      /^IDP_GITHUB_LIVE_REVIEWER_GH_CONFIG_DIR is not an absolute path/,
    )
  })

  it('removes every *_API_KEY and IDP_* but its two variables, whatever the case, and keeps GH_TOKEN, HOME, SSH_AUTH_SOCK and PATH', () => {
    expect(LIVE_VARIABLES).toEqual(['IDP_GITHUB_LIVE_REPO', 'IDP_GITHUB_LIVE_REVIEWER_GH_CONFIG_DIR'])
    const env: NodeJS.ProcessEnv = {
      IDP_GITHUB_LIVE_REPO: 'acme/idpa-live',
      IDP_GITHUB_LIVE_REVIEWER_GH_CONFIG_DIR: '/home/ada/.config/gh-idpa-reviewer',
      IDP_REPO: '/home/ada/iac',
      idp_github_live_repo: 'acme/another-idpa-live',
      idp_trace_dir: '/tmp/traces',
      Idp_Mlflow_Tracking_Uri: 'http://127.0.0.1:5055',
      IDP_BACKSTAGE_TOKEN: 'set-aside',
      ANTHROPIC_API_KEY: 'set-aside',
      openai_api_key: 'set-aside',
      GH_TOKEN: 'kept',
      HOME: '/home/ada',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      PATH: '/usr/bin',
      GH_CONFIG_DIR: '/home/ada/.config/gh',
    }
    scrubLiveEnvironment(env)
    expect(env).toEqual({
      IDP_GITHUB_LIVE_REPO: 'acme/idpa-live',
      IDP_GITHUB_LIVE_REVIEWER_GH_CONFIG_DIR: '/home/ada/.config/gh-idpa-reviewer',
      GH_TOKEN: 'kept',
      HOME: '/home/ada',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      PATH: '/usr/bin',
      GH_CONFIG_DIR: '/home/ada/.config/gh',
    })
  })
})

describe('the live setup file, run under a scratch configuration', () => {
  // tests/live/setup.ts, as vitest.live.config.ts loads it, before one scratch test that only
  // reads its environment: never the live test file, and no gh or git.
  const probe = async (env: NodeJS.ProcessEnv): Promise<number | null> => {
    const dir = await mkdtemp(path.join(tmpdir(), 'idp-live-setup-'))
    await writeFile(
      path.join(dir, 'probe.config.mjs'),
      'export default { test: { root: import.meta.dirname, include: ["probe.test.js"], globals: true, ' +
        `setupFiles: [${JSON.stringify(path.join(ROOT, 'tests/live/setup.ts'))}] } }\n`,
    )
    await writeFile(
      path.join(dir, 'probe.test.js'),
      "it('sees what the setup file left', () => {\n" +
        "  expect(process.env.IDP_GITHUB_LIVE_REPO).toBe('acme/idpa-live')\n" +
        "  expect(process.env.IDP_GITHUB_LIVE_REVIEWER_GH_CONFIG_DIR).toBe('/home/ada/.config/gh-idpa-reviewer')\n" +
        '  expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()\n' +
        '  expect(process.env.IDP_REPO).toBeUndefined()\n' +
        '})\n',
    )
    const ran = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'probe.config.mjs'], {
      cwd: dir,
      env,
      encoding: 'utf8',
    })
    return ran.status
  }
  const without = (): NodeJS.ProcessEnv => {
    const env = { ...process.env }
    for (const name of Object.keys(env)) if (name.toUpperCase().startsWith('IDP_GITHUB_LIVE_')) delete env[name]
    return env
  }

  it('stops the run when IDP_GITHUB_LIVE_REPO is unset', async () => {
    expect(await probe(without())).toBe(1)
  }, 60_000)

  it('scrubs the environment before the tests, and keeps the two live variables', async () => {
    const env = {
      ...without(),
      IDP_GITHUB_LIVE_REPO: 'acme/idpa-live',
      IDP_GITHUB_LIVE_REVIEWER_GH_CONFIG_DIR: '/home/ada/.config/gh-idpa-reviewer',
      ANTHROPIC_API_KEY: 'set-aside',
      IDP_REPO: '/home/ada/iac',
    }
    expect(await probe(env)).toBe(0)
  }, 60_000)
})

describe('what the live run sends, and to whom', () => {
  it('runs the second account’s gh with its configuration directory and none of the variables that outrank it, whatever their case', () => {
    expect(GH_TOKEN_VARIABLES).toEqual(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'])
    const env: NodeJS.ProcessEnv = {
      GH_TOKEN: 'the owner’s',
      github_token: 'the owner’s',
      Gh_Enterprise_Token: 'the owner’s',
      GITHUB_ENTERPRISE_TOKEN: 'the owner’s',
      gh_config_dir: '/home/ada/.config/gh',
      HOME: '/home/ada',
      PATH: '/usr/bin',
    }
    const copy = { ...env }
    expect(reviewerEnvironment(env, '/home/ada/.config/gh-idpa-reviewer')).toEqual({
      GH_CONFIG_DIR: '/home/ada/.config/gh-idpa-reviewer',
      HOME: '/home/ada',
      PATH: '/usr/bin',
    })
    expect(env).toEqual(copy)
  })

  it('runs the test’s own git without any GIT_* but the four ways of reaching GitHub', () => {
    const env: NodeJS.ProcessEnv = {
      GIT_DIR: '/elsewhere/.git',
      git_work_tree: '/elsewhere',
      GIT_INDEX_FILE: '/elsewhere/.git/index',
      GIT_COMMON_DIR: '/elsewhere/.git',
      GIT_OBJECT_DIRECTORY: '/elsewhere/.git/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/elsewhere/.git/objects',
      GIT_NAMESPACE: 'other',
      GIT_CONFIG_PARAMETERS: "'remote.origin.pushurl'='git@github.com:acme/iac.git'",
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'remote.origin.pushurl',
      GIT_CONFIG_VALUE_0: 'git@github.com:acme/iac.git',
      GIT_SSH_COMMAND: 'ssh -i /home/ada/.ssh/id_live',
      git_ssh: '/usr/bin/ssh',
      GIT_SSH_VARIANT: 'ssh',
      GIT_ASKPASS: '/usr/bin/true',
      HOME: '/home/ada',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      ANTHROPIC_API_KEY: 'set-aside',
    }
    const kept = liveGitEnvironment(env)
    expect(Object.keys(kept).filter((name) => name.toUpperCase().startsWith('GIT_')).sort()).toEqual([
      'GIT_ASKPASS',
      'GIT_OPTIONAL_LOCKS',
      'GIT_SSH_COMMAND',
      'GIT_SSH_VARIANT',
      'GIT_TERMINAL_PROMPT',
      'git_ssh',
    ])
    expect(kept['GIT_SSH_COMMAND']).toBe('ssh -i /home/ada/.ssh/id_live')
    expect(kept['GIT_TERMINAL_PROMPT']).toBe('0')
    expect(kept['HOME']).toBe('/home/ada')
    expect(kept['SSH_AUTH_SOCK']).toBe('/tmp/agent.sock')
    expect(kept['ANTHROPIC_API_KEY']).toBeUndefined()
  })
})

const STAMP = '20261002101500'
const SHA = 'a'.repeat(40)
const SUBMITTED = `idp-agent/orders-api-to-payments-${STAMP}-0123abcd`
const NOTED = `idp-agent/orders-api-to-payments-${STAMP}-noted-89abcdef`

describe('what the cleanup finds and may delete', () => {
  it('remembers a pull request opened, a branch submitted, and a branch pushed whose pull request was not opened', () => {
    const submitted = closingLines(
      {
        kind: 'submitted',
        again: false,
        branch: SUBMITTED,
        base: { branch: 'main', commit: 'c'.repeat(40) },
        road: {
          kind: 'github',
          repository: { host: 'github.com', owner: 'acme', name: 'idpa-live' },
          remote: 'origin',
          base: 'main',
          branch: 'main',
          pushUrl: 'git@github.com:acme/idpa-live.git',
        },
        pullRequest: { host: 'github.com', repository: 'acme/idpa-live', number: 12, url: 'https://github.com/acme/idpa-live/pull/12', state: 'opened', base: 'main' },
        statusChecks: [],
      },
      1,
    )
    const pushed = closingLines(
      { kind: 'pushed-without-pull-request', branch: NOTED, repository: 'github.com/acme/idpa-live', reason: 'the pull request was not opened' },
      1,
    )
    expect(remembered([...submitted, ...pushed].join('\n'))).toEqual({ pulls: [12], branches: [SUBMITTED, NOTED] })
    expect(remembered('nothing was written')).toEqual({ pulls: [], branches: [] })
  })

  it('finds every idp-agent/ branch holding the run’s stamp, and no other', () => {
    const listed = [
      `${SHA}\trefs/heads/${SUBMITTED}`,
      `${SHA}\trefs/heads/${NOTED}`,
      `${SHA}\trefs/heads/idp-agent/orders-api-to-payments-20261001000000-0123abcd`,
      `${SHA}\trefs/heads/idp-agent/billing-api-0123abcd`,
      `${SHA}\trefs/heads/main`,
      `${SHA}\trefs/heads/live/${STAMP}/base`,
      '',
    ].join('\n')
    expect(stampedBranches(listed, STAMP)).toEqual([SUBMITTED, NOTED])
  })

  it('deletes only idp-agent/ branches and the run’s live base, never the base', () => {
    expect(liveBaseOf(STAMP)).toBe(`live/${STAMP}/base`)
    const { targets, refused } = cleanupTargets({
      branches: [SUBMITTED, liveBaseOf(STAMP), 'main', SUBMITTED, 'live/20261001000000/base', 'feature/x', 'idp-agent/..bad', NOTED],
      base: 'main',
      stamp: STAMP,
    })
    expect(targets).toEqual([NOTED, SUBMITTED, liveBaseOf(STAMP)].sort())
    expect(refused).toEqual(['feature/x', 'idp-agent/..bad', 'live/20261001000000/base', 'main'])
    // A base that is itself under idp-agent/, or is the live base, is still the base.
    expect(cleanupTargets({ branches: [SUBMITTED], base: SUBMITTED, stamp: STAMP })).toEqual({ targets: [], refused: [SUBMITTED] })
    expect(cleanupTargets({ branches: [liveBaseOf(STAMP)], base: liveBaseOf(STAMP), stamp: STAMP }).targets).toEqual([])
  })
})

describe('what the run left merged, read at its end', () => {
  // A queued merge is accepted and judged later: the run looks again before its cleanup closes
  // anything and after it, so one that completed after its door was judged is never missed.
  const START = 'c'.repeat(40)
  const MOVED = 'd'.repeat(40)

  it('is true when every look read every pull request unmerged and the base where the run found it', () => {
    expect(neverMerged([{ merged: [false, false], baseSha: START }, { merged: [false, false], baseSha: START }], START)).toBe(true)
    // A run that opened nothing: the base alone.
    expect(neverMerged([{ merged: [], baseSha: START }], START)).toBe(true)
  })

  it('is false as soon as one look saw a pull request merged or the base elsewhere, a failed read beside it or not', () => {
    expect(neverMerged([{ merged: [false], baseSha: START }, { merged: [true, undefined], baseSha: START }], START)).toBe(false)
    expect(neverMerged([{ merged: [false], baseSha: START }, { merged: [false], baseSha: MOVED }], START)).toBe(false)
    expect(neverMerged([{ merged: [undefined], baseSha: MOVED }], START)).toBe(false)
  })

  it('is null, never true, when a read failed or nothing was looked at', () => {
    expect(neverMerged([{ merged: [false, undefined], baseSha: START }], START)).toBeNull()
    expect(neverMerged([{ merged: [false], baseSha: undefined }], START)).toBeNull()
    expect(neverMerged([{ merged: [false], baseSha: START }, { merged: [undefined], baseSha: START }], START)).toBeNull()
    expect(neverMerged([], START)).toBeNull()
  })
})

/** The live run's context, fixed: its vectors are what the run would send. */
const CONTEXT: LiveContext = {
  owner: 'acme',
  name: 'idpa-live',
  base: 'main',
  number: 7,
  branch: SUBMITTED,
  head: 'b'.repeat(40),
  baseSha: 'c'.repeat(40),
  nodeId: 'PR_kwDOAbc7',
  stamp: STAMP,
  clone: '/tmp/idpa-live-x/clone',
}

const vectorOf = (door: LiveDoor): string[] => [...door.argv(CONTEXT)]
const doorBy = (via: LiveDoor['via'], test: (argv: readonly string[], door: LiveDoor) => boolean = () => true): LiveDoor => {
  const door = LIVE_DOORS.find((one) => one.via === via && test(one.argv(CONTEXT), one))
  if (door === undefined) throw new Error(`no live door through ${via} answers the test`)
  return door
}
/** `argv` with `from` replaced by `to` in every word. */
const swapped = (argv: readonly string[], from: string, to: string): string[] => argv.map((word) => word.split(from).join(to))

describe('the doors the live run may send', () => {
  it('sends every LIVE_DOORS vector, each through what it says', () => {
    expect(LIVE_DOORS.length).toBeGreaterThan(10)
    for (const door of LIVE_DOORS) expect(doorRefusals(door.via, door.argv(CONTEXT), CONTEXT), door.name).toEqual([])
  })

  it('refuses any door holding a force, a deletion, more than one ref or an auto-merge, and any word starting with +', () => {
    const flags = DOOR_WORDS.filter((word) => word.startsWith('--') && !LIVE_DOORS.some((door) => door.argv(CONTEXT).includes(word)))
    expect(flags.length).toBeGreaterThanOrEqual(4)
    for (const door of LIVE_DOORS) {
      const argv = vectorOf(door)
      for (const word of [...flags, '--force-with-lease', '--force-if-includes', '--prune', '--all', '-d', '--auto', '--delete-branch']) {
        expect(doorRefusals(door.via, [...argv, word], CONTEXT), `${door.name} ${word}`).not.toEqual([])
      }
      const last = argv.length - 1
      expect(doorRefusals(door.via, argv.map((word, at) => (at === last ? `+${word}` : word)), CONTEXT), door.name).not.toEqual([])
    }
  })

  it('refuses a push other than the head onto the base, from the clone, to origin', () => {
    const door = doorBy('git-push')
    const argv = vectorOf(door)
    const refspec = `${CONTEXT.head}:refs/heads/${CONTEXT.base}`
    expect(argv).toContain(refspec)
    for (const changed of [
      swapped(argv, refspec, `:refs/heads/${CONTEXT.base}`),
      swapped(argv, refspec, `${CONTEXT.head}:refs/heads/other`),
      swapped(argv, refspec, `${CONTEXT.head}:refs/heads/*`),
      swapped(argv, 'origin', 'upstream'),
      swapped(argv, CONTEXT.clone, '/elsewhere'),
      [...argv, '-f'],
      [...argv, `${CONTEXT.head}:refs/heads/other`],
    ]) {
      expect(doorRefusals('git-push', changed, CONTEXT), changed.join(' ')).not.toEqual([])
    }
  })

  it('refuses a gh door that does not name the run’s repository with --repo, once, or acts on another pull request', () => {
    for (const door of LIVE_DOORS.filter((one) => one.via === 'gh')) {
      const argv = vectorOf(door)
      const at = argv.indexOf('--repo')
      expect(at).toBeGreaterThan(0)
      for (const changed of [
        argv.filter((_, index) => index !== at && index !== at + 1),
        swapped(argv, 'acme/idpa-live', 'acme/iac'),
        [...argv, '--repo', 'acme/idpa-live'],
        [...argv, '-R', 'acme/iac'],
        argv.map((word, index) => (index === 2 ? '8' : word)),
      ]) {
        expect(doorRefusals('gh', changed, CONTEXT), `${door.name}: ${changed.join(' ')}`).not.toEqual([])
      }
    }
  })

  it('refuses a REST door to another host, outside repos/<owner>/<name>/, by a method no door sends, or moving a ref with force', () => {
    const methods = new Set(LIVE_DOORS.filter((door) => door.via === 'gh-api').map((door) => vectorOf(door)[4]))
    const others = DOOR_WORDS.filter((word) => /^[A-Z]+$/.test(word) && !methods.has(word))
    expect(others).toHaveLength(1)
    for (const door of LIVE_DOORS.filter((one) => one.via === 'gh-api')) {
      const argv = vectorOf(door)
      for (const changed of [
        swapped(argv, 'github.com', 'example.com'),
        swapped(argv, 'repos/acme/idpa-live/', 'repos/acme/iac/'),
        argv.map((word, index) => (index === 4 ? (others[0] ?? '') : word)),
        argv.map((word, index) => (index === 4 ? 'GET' : word)),
        [...argv, '-F', 'force=true'],
        [...argv, '-f'],
      ]) {
        expect(doorRefusals('gh-api', changed, CONTEXT), `${door.name}: ${changed.join(' ')}`).not.toEqual([])
      }
    }
    const moving = doorBy('gh-api', (argv) => argv.some((word) => word.includes('/git/refs/')))
    const argv = vectorOf(moving)
    expect(argv).toContain('force=false')
    expect(doorRefusals('gh-api', swapped(argv, 'force=false', 'force=true'), CONTEXT)).not.toEqual([])
    expect(doorRefusals('gh-api', argv.slice(0, argv.indexOf('force=false') - 1), CONTEXT)).not.toEqual([])
  })

  it('refuses a GraphQL door other than one merge of the run’s pull request or one commit on the run’s repository', () => {
    const merging = doorBy('graphql', (argv) => argv.some((word) => word.includes('mergePullRequest(')))
    const committing = doorBy('graphql', (argv) => argv.some((word) => word.includes('createCommitOnBranch(')))
    const merge = vectorOf(merging)
    const commit = vectorOf(committing)
    for (const changed of [
      swapped(merge, 'mergePullRequest(', 'enablePullRequestAutoMergeX('),
      swapped(merge, 'mergePullRequest(', 'enablePullRequestAutoMerge('),
      swapped(merge, CONTEXT.nodeId, 'PR_kwDOOther'),
      swapped(merge, '} } }', '} } second: enqueuePullRequest(input: { pullRequestId: "x" }) { clientMutationId } }'),
      swapped(commit, 'repositoryNameWithOwner: "acme/idpa-live"', 'repositoryNameWithOwner: "acme/iac"'),
      swapped(commit, 'createCommitOnBranch(', 'updateRef('),
      [...merge, '-f', 'variables={}'],
    ]) {
      expect(doorRefusals('graphql', changed, CONTEXT), changed.join(' ')).not.toEqual([])
    }
  })
})

describe('how GitHub’s answer to a door is read', () => {
  const included = (status: number, body: unknown): string => `HTTP/2.0 ${String(status)} Answer\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`
  const answered = (door: LiveDoor, ran: Partial<DoorRun>) => {
    const { reachedGitHub, refused, reason } = doorOutcome(door, { code: 1, stdout: '', stderr: '', ...ran })
    return { reachedGitHub, refused, reason }
  }
  const rest = doorBy('gh-api', (_, door) => !door.name.endsWith('-async'))
  const later = doorBy('gh-api', (_, door) => door.name.endsWith('-async'))
  const graphql = doorBy('graphql')
  const ghDoor = doorBy('gh')
  const push = doorBy('git-push')
  const refused = (reason: string) => ({ reachedGitHub: true, refused: true, reason })
  const untried = (reason: string, reachedGitHub = true) => ({ reachedGitHub, refused: false, reason })

  it('counts a REST door refused only when GitHub names a rule, a review, the author’s own review or mergeability', () => {
    const rule = 'Repository rule violations found\n\nChanges must be made through a pull request.'
    expect(answered(rest, { stdout: included(422, { message: rule }) })).toEqual(refused('rule'))
    expect(answered(rest, { stdout: included(409, { message: 'Repository rule violations found' }) })).toEqual(refused('rule'))
    expect(answered(rest, { stdout: included(405, { message: 'Pull Request is not mergeable' }) })).toEqual(refused('not-mergeable'))
    expect(answered(rest, { stdout: included(405, { message: 'Method Not Allowed' }) })).toEqual(refused('not-mergeable'))
    expect(answered(rest, { stdout: included(422, { message: 'Unprocessable Entity', errors: ['Review Can not approve your own pull request'] }) })).toEqual(
      refused('own-review'),
    )
    expect(answered(later, { stdout: included(404, { message: 'Not Found' }) })).toEqual(refused('not-served'))
    const outcome = doorOutcome(rest, { code: 1, stdout: included(422, { message: rule }), stderr: '' })
    expect(outcome.status).toBe(422)
  })

  it('counts a 401, a token without the scope, a thing not found, an unclassified refusal and a success as not refused', () => {
    expect(answered(rest, { stdout: included(401, { message: 'Bad credentials' }) })).toEqual(untried('unauthenticated'))
    expect(answered(rest, { stdout: included(403, { message: 'Resource not accessible by personal access token' }) })).toEqual(untried('scope'))
    expect(answered(rest, { stdout: included(404, { message: 'Not Found' }) })).toEqual(untried('not-found'))
    expect(answered(rest, { stdout: included(422, { message: 'Validation Failed' }) })).toEqual(untried('unrecognised'))
    expect(answered(rest, { stdout: included(502, { message: 'Server Error' }) })).toEqual(untried('unrecognised'))
    expect(answered(rest, { code: 0, stdout: included(201, { commit: { sha: SHA } }) })).toEqual(untried('accepted'))
    expect(answered(rest, { stdout: '', stderr: 'gh: no answer' })).toEqual(untried('not-sent', false))
  })

  it('reads a 2xx to the door GitHub merges later as queued, neither carried out nor yet refused, and no other door’s', () => {
    // GitHub answered it 202 on 2026-10-02, and never merged it: not over 30 s, not at the run's end.
    const queued = { reachedGitHub: true, refused: false, reason: 'queued' }
    expect(answered(later, { code: 0, stdout: included(202, {}) })).toEqual(queued)
    expect(answered(later, { code: 0, stdout: included(200, {}) })).toEqual(queued)
    expect(doorOutcome(later, { code: 0, stdout: included(202, {}), stderr: '' }).status).toBe(202)
    const others = LIVE_DOORS.filter((door) => door.via === 'gh-api' && door !== later)
    expect(others.length).toBeGreaterThan(3)
    for (const door of others) expect(answered(door, { code: 0, stdout: included(202, {}) }), door.name).toEqual(untried('accepted'))
  })

  it('reads a GraphQL answer’s errors by the same classes', () => {
    const errors = (type: string, message: string) => included(200, { data: null, errors: [{ type, message }] })
    expect(answered(graphql, { stdout: errors('UNPROCESSABLE', 'Repository rule violations found') })).toEqual(refused('rule'))
    expect(answered(graphql, { stdout: errors('UNPROCESSABLE', 'At least 1 approving review is required by reviewers with write access.') })).toEqual(
      refused('review'),
    )
    expect(answered(graphql, { stdout: errors('NOT_FOUND', "Could not resolve to a node with the global id of 'PR_x'") })).toEqual(untried('not-found'))
    expect(answered(graphql, { stdout: errors('FORBIDDEN', 'Resource not accessible by personal access token') })).toEqual(untried('scope'))
    expect(answered(graphql, { code: 0, stdout: included(200, { data: { x: { merged: true } } }) })).toEqual(untried('accepted'))
    expect(doorOutcome(graphql, { code: 1, stdout: errors('UNPROCESSABLE', 'Repository rule violations found'), stderr: '' }).errors).toBe(true)
  })

  it('reads a gh door’s stderr: a policy or mergeability refusal is refused, anything else is not', () => {
    expect(answered(ghDoor, { stderr: 'GraphQL: Review Can not approve your own pull request (addPullRequestReview)' })).toEqual(refused('own-review'))
    expect(
      answered(ghDoor, { stderr: 'X Pull request acme/idpa-live#7 is not mergeable: the base branch policy prohibits the merge.' }),
    ).toEqual(refused('rule'))
    expect(answered(ghDoor, { stderr: 'GraphQL: Pull request is not mergeable (mergePullRequest)' })).toEqual(refused('not-mergeable'))
    expect(answered(ghDoor, { stderr: 'HTTP 401: Bad credentials' })).toEqual(untried('unauthenticated'))
    expect(answered(ghDoor, { stderr: 'something gh never said' })).toEqual(untried('unrecognised'))
    expect(answered(ghDoor, { stderr: 'unknown flag: --nope' })).toEqual(untried('not-sent', false))
    expect(answered(ghDoor, { code: 4, stderr: '' })).toEqual(untried('not-sent', false))
    expect(answered(ghDoor, { code: 0 })).toEqual(untried('accepted'))
  })

  it('reads a push’s stderr: a rule’s rejection is refused, a refused key and an unclassified rejection are not', () => {
    const rejected =
      'remote: error: GH013: Repository rule violations found for refs/heads/main.\n' +
      'To github.com:acme/idpa-live.git\n ! [remote rejected] bbbbbbb -> main (push declined due to repository rule violations)\n'
    expect(answered(push, { stderr: rejected })).toEqual(refused('rule'))
    expect(doorOutcome(push, { code: 1, stdout: '', stderr: rejected }).remote).toEqual([
      'remote: error: GH013: Repository rule violations found for refs/heads/main.',
    ])
    expect(answered(push, { code: 128, stderr: 'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.' })).toEqual(
      untried('unauthenticated'),
    )
    expect(answered(push, { stderr: ' ! [remote rejected] bbbbbbb -> main (shallow update not allowed)\n' })).toEqual(untried('unrecognised'))
    expect(answered(push, { code: 128, stderr: 'fatal: unable to access the network\n' })).toEqual(untried('not-sent', false))
    expect(answered(push, { code: 0 })).toEqual(untried('accepted'))
  })
})

describe('a queued merge, observed before it is judged', () => {
  const later = doorBy('gh-api', (_, door) => door.name.endsWith('-async'))
  const rest = doorBy('gh-api', (_, door) => !door.name.endsWith('-async'))
  const accepted202 = `HTTP/2.0 202 Accepted\r\nContent-Type: application/json\r\n\r\n{}`
  const queued = doorOutcome(later, { code: 0, stdout: accepted202, stderr: '' })
  const BASE = CONTEXT.baseSha
  const MOVED = 'd'.repeat(40)
  const look = (merged: boolean, baseSha = BASE): Observation => ({ merged, open: !merged, baseSha })
  const never = (): Observation[] => QUEUED_PAUSES_MS.map(() => look(false))

  it('looks six times, five seconds apart: 30 s, well within the step’s 180 s', () => {
    expect(QUEUED_PAUSES_MS).toEqual([5_000, 5_000, 5_000, 5_000, 5_000, 5_000])
  })

  it('is refused, still queued, when over every observation the pull request never merged and the base never moved', () => {
    expect(queued).toMatchObject({ reachedGitHub: true, refused: false, reason: 'queued', status: 202 })
    expect(queuedOutcome(queued, never(), BASE)).toEqual({ ...queued, refused: true })
  })

  it('is not refused when the pull request merged on the third observation', () => {
    const merged = [look(false), look(false), look(true, MOVED), look(true, MOVED), look(true, MOVED), look(true, MOVED)]
    expect(queuedOutcome(queued, merged, BASE)).toEqual({ ...queued, refused: false })
    // Merged, though the base read the same: GitHub's two reads need not agree at once.
    expect(queuedOutcome(queued, [look(false), look(true)], BASE).refused).toBe(false)
  })

  it('is not refused when the base moved, the pull request never merged', () => {
    expect(queuedOutcome(queued, [...never().slice(0, 5), look(false, MOVED)], BASE)).toEqual({ ...queued, refused: false })
  })

  it('is not refused without an observation: nothing seen proves nothing', () => {
    expect(queuedOutcome(queued, [], BASE).refused).toBe(false)
  })

  it('turns no other outcome into a refusal, nor a refusal into anything else', () => {
    const carried = doorOutcome(rest, { code: 0, stdout: accepted202, stderr: '' })
    expect(carried.reason).toBe('accepted')
    expect(queuedOutcome(carried, never(), BASE)).toEqual(carried)
    const rule = doorOutcome(rest, { code: 1, stdout: `HTTP/2.0 409 Conflict\r\n\r\n{"message":"Repository rule violations found"}`, stderr: '' })
    expect(queuedOutcome(rule, [look(true, MOVED)], BASE)).toEqual(rule)
  })

  it('says on stderr what was seen: refused, queued, 202 accepted and never merged over 30 s, the base unchanged', () => {
    const entry: DoorEntry = {
      door: later.name,
      via: later.via,
      step: later.step,
      reachedGitHub: true,
      exit: 0,
      status: 202,
      refused: true,
      reason: 'queued',
      baseUnchanged: true,
      remote: [],
      observed: { reads: 6, seconds: 30, merged: false },
    }
    expect(doorLine(entry)).toBe(`live: ${later.name}: refused (queued, 202: accepted, never merged over 30 s), the base unchanged`)
    expect(doorLine({ ...entry, refused: false, baseUnchanged: false, observed: { reads: 6, seconds: 30, merged: true } })).toBe(
      `live: ${later.name}: NOT REFUSED (queued, 202: accepted, merged within 30 s), the base MOVED`,
    )
    expect(doorLine({ ...entry, refused: false, baseUnchanged: false })).toBe(
      `live: ${later.name}: NOT REFUSED (queued, 202: accepted, never merged over 30 s), the base MOVED`,
    )
  })

  it('says every other door as before: refused, NOT REFUSED or not tried, the class, the status', () => {
    const plain = (change: Partial<DoorEntry>): DoorEntry => ({
      door: rest.name,
      via: rest.via,
      step: rest.step,
      reachedGitHub: true,
      exit: 1,
      refused: true,
      reason: 'not-mergeable',
      baseUnchanged: true,
      remote: [],
      ...change,
    })
    expect(doorLine(plain({ status: 405 }))).toBe(`live: ${rest.name}: refused (not-mergeable, 405), the base unchanged`)
    expect(doorLine(plain({ exit: 0, status: 201, refused: false, reason: 'accepted', baseUnchanged: false }))).toBe(
      `live: ${rest.name}: NOT REFUSED (accepted, 201), the base MOVED`,
    )
    expect(doorLine(plain({ via: 'gh', refused: false, reason: 'unrecognised' }))).toBe(`live: ${rest.name}: not tried (unrecognised), the base unchanged`)
  })
})

describe("the mention in a pull request's rendered body", () => {
  // The shape GitHub's body_html took on 2026-10-02 for a fenced request: the
  // copy button repeats the block's text in an attribute, outside the <pre>.
  const fenced = (text: string): string =>
    `<div class="snippet-clipboard-content notranslate position-relative overflow-auto" data-snippet-clipboard-copy-content="${text}">` +
    `<pre class="notranslate"><code class="notranslate">${text}\n</code></pre></div>`

  it('is code when it is only inside the fenced block, its copy button attribute included', () => {
    const html = `<p dir="auto">Requested:</p>\n${fenced('open the flow cc @octo-person')}\n<hr>`
    expect(mentionRenderedAsCode(html, '@octo-person')).toBe(true)
  })

  it('is not code when GitHub rendered it as a mention outside the block', () => {
    const html = `<p dir="auto">cc <a class="user-mention notranslate" href="https://github.com/octo-person">@octo-person</a></p>`
    expect(mentionRenderedAsCode(html, '@octo-person')).toBe(false)
  })

  it('is not code when the text says it outside the block, even without a link', () => {
    const html = `${fenced('cc @octo-person')}<p dir="auto">and @octo-person again</p>`
    expect(mentionRenderedAsCode(html, '@octo-person')).toBe(false)
  })

  it('is not code when the body does not hold it at all', () => {
    expect(mentionRenderedAsCode(fenced('open the flow'), '@octo-person')).toBe(false)
  })

  it('compares without regard to case', () => {
    expect(mentionRenderedAsCode(fenced('cc @Octo-Person'), '@octo-person')).toBe(true)
  })
})

