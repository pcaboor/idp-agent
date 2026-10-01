import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { main } from '../../src/cli/index.js'
import type { Ask } from '../../src/cli/commands/plan.js'
import {
  forgeAttributes,
  openForSubmission,
  refuseUnprotected,
  type Confirm,
  type SubmissionReport,
  type SubmissionSummary,
} from '../../src/cli/commands/submit.js'
import { closingLines, CLOSING, localRoadLine, pullRequestLines, type PreviewStatus } from '../../src/cli/render/footer.js'
import { configRefusal } from '../../src/core/github/config.js'
import { protectionText } from '../../src/core/github/protection.js'
import type { GitHubRoad, LocalRoad, PullRequest } from '../../src/forge/provider.js'
import { GH_LIMITS, parseIncluded, type GhExit, type GhProcess } from '../../src/process/gh.js'
import { REFUSED_EXIT } from '../../tools/fake-gh.js'
import { confirmingEnvironment } from '../support/ask.js'
import { INTENT, OPERATIONS, removeClones } from '../support/forge-fixture.js'
import { DOORS, MODELLED_DOORS } from '../support/fake-gh.js'
import {
  fakeSsh,
  GITHUB_URL,
  githubClone,
  moveGitHubBase,
  remoteRefs,
  requireUnrewritten,
  unprotect,
  type GitHubClone,
} from '../support/github-fixture.js'
import { git, observable } from '../support/git.js'

/**
 * `plan --from … --submit` to GitHub, through `main` (stage 6 brief § 3,
 * § 9, § 13, § 14): the clone of `githubClone()`, whose `main` tracks
 * `git@github.com:acme/iac.git`, a bare repository standing for GitHub's side,
 * the fake ssh that serves it, and the fake gh handed in as `MainDeps.gh`. The
 * push is the person's real `git push`; nothing leaves the machine and no real
 * gh or ssh starts (`tests/setup/forge.ts`).
 *
 * "Nothing written" is three facts: the clone as a person sees it, the bare
 * repository's refs, and the fake's pull requests.
 */

afterAll(removeClones)

const WHERE = 'github.com/acme/iac'
const SUBMITTING = "submitting to github.com/acme/iac, into main (origin, main's upstream), as ada (gh)"
const MERGING =
  'Merging it waits for one approval of its latest commit from someone other than you. No status check is ' +
  'required, so a system downstream could not refuse it (ADR-0012).'

/** A person at the prompt: `read` for the level, the draft's environment confirmed, nothing else. */
const ask: Ask = async (question) => (question.path.endsWith('.access') ? 'read' : confirmingEnvironment(question))

/** A gh nobody may start. */
const untouchable = (): GhProcess & { readonly calls: () => number } => {
  let calls = 0
  const process: GhProcess = async () => {
    calls += 1
    throw new Error('gh was started')
  }
  return Object.assign(process, { calls: () => calls })
}

/** The plan file, beside the clone and never inside it. */
const planFile = async (clone: GitHubClone): Promise<string> => {
  const file = path.join(path.dirname(clone.repo), 'plan.json')
  await writeFile(file, `${JSON.stringify({ intent: INTENT, operations: OPERATIONS }, null, 2)}\n`, 'utf8')
  return file
}

/** What a person, GitHub's refs and the fake's pull requests show, together. */
const state = async (clone: GitHubClone): Promise<string> =>
  [await observable(clone.repo), await remoteRefs(clone.bare), JSON.stringify(clone.gh.state.pulls ?? [])].join('\n--\n')

/** `plan --from <plan> --repo <clone> --submit`, and `extra`, as a person runs it against the fake. */
const submitting = async (
  clone: GitHubClone,
  extra: readonly string[] = [],
  deps: { readonly confirm?: Confirm; readonly gh?: GhProcess; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; out: string; err: string }> => {
  const out: string[] = []
  const err: string[] = []
  const code = await main(['plan', '--from', await planFile(clone), '--repo', clone.repo, '--submit', ...extra], {
    out: (chunk) => void out.push(chunk),
    err: (chunk) => void err.push(chunk),
    env: deps.env ?? clone.env,
    gh: deps.gh ?? clone.gh.process,
    ask,
    ...(deps.confirm === undefined ? {} : { confirm: deps.confirm }),
  })
  return { code, out: out.join(''), err: err.join('') }
}

/** The idp-agent branch the clone holds: exactly one. */
const ourBranch = async (repo: string): Promise<string> => {
  const listed = (await git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/idp-agent/')).split('\n').filter(Boolean)
  if (listed.length !== 1 || listed[0] === undefined) throw new Error(`expected one branch, found ${listed.join(', ')}`)
  return listed[0]
}

/** The commit a branch is at on GitHub's side, or undefined. */
const onGitHub = async (clone: GitHubClone, branch: string): Promise<string | undefined> =>
  git(clone.bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).catch(() => undefined)

/**
 * Each run starts a dozen real git processes, a push and the read-back's
 * waits (0.5 s, then 1.5 s, on a push that fails): seconds alone, more beside
 * the rest of the suite.
 */
const RUNS = 30_000

describe('plan --from --submit to GitHub', { timeout: RUNS }, () => {
  it('pushes with the person’s git and opens one pull request, whose URL the engine builds', async () => {
    const clone = await githubClone()
    const main0 = await git(clone.repo, 'rev-parse', 'main')
    const bareMain = await git(clone.bare, 'rev-parse', 'main')

    const { code, out, err } = await submitting(clone)

    expect(code, err).toBe(0)
    expect(err).toContain(SUBMITTING)
    const branch = await ourBranch(clone.repo)
    expect(out.trimEnd().split('\n').slice(-4)).toEqual([
      `2 files · submitted as ${branch} on top of main@${main0.slice(0, 7)} · main untouched`,
      'Pull request #1 opened on github.com/acme/iac: https://github.com/acme/iac/pull/1',
      MERGING,
      CLOSING,
    ])
    expect(await onGitHub(clone, branch)).toBe(await git(clone.repo, 'rev-parse', branch))
    expect(await git(clone.repo, 'rev-parse', 'main')).toBe(main0)
    expect(await git(clone.bare, 'rev-parse', 'main')).toBe(bareMain)
    expect(clone.gh.state.pulls).toHaveLength(1)
    expect(clone.gh.state.pulls?.[0]).toMatchObject({ number: 1, state: 'open', base: 'main', head: branch, author: 'ada' })
  })

  it('names the same pull request on a second run, asks nothing and writes nothing', async () => {
    const clone = await githubClone()
    expect((await submitting(clone)).code).toBe(0)
    const before = await state(clone)

    const { code, out } = await submitting(clone, [], {
      confirm: async () => {
        throw new Error('a run that wrote nothing asked a person')
      },
    })

    expect(code).toBe(0)
    const branch = await ourBranch(clone.repo)
    expect(out.trimEnd().split('\n').slice(-2)).toEqual([
      `2 files · already submitted as ${branch} · pull request #1 is open · nothing written`,
      CLOSING,
    ])
    expect(await state(clone)).toBe(before)
  })

  it('asks, at a terminal, whether to push with the person’s git and open the pull request with their gh', async () => {
    const clone = await githubClone()
    const before = await state(clone)
    const asked: SubmissionSummary[] = []

    const { code, out } = await submitting(clone, [], {
      confirm: async (summary) => {
        asked.push(summary)
        return false
      },
    })

    expect(code).toBe(0)
    expect(asked.map((summary) => summary.github)).toEqual([
      { host: 'github.com', repository: 'acme/iac', base: 'main', pushedAlready: false },
    ])
    expect(out.trimEnd().split('\n').slice(-2)).toEqual(['2 files · not submitted · nothing written', CLOSING])
    expect(await state(clone)).toBe(before)
  })

  it('asks only to open the pull request when an earlier run pushed the branch', async () => {
    const clone = await githubClone()
    clone.gh.fault({ route: 'open-pull-request', status: 502, times: 1 })

    const first = await submitting(clone)
    expect(first.code).toBe(1)
    const branch = await ourBranch(clone.repo)
    expect(first.out.trimEnd().split('\n').slice(-2)).toEqual([
      `2 files · ${branch} is on ${WHERE}, and the pull request was not opened: GitHub answered 502 through gh. ` +
        'Run the same command again to open it.',
      CLOSING,
    ])
    expect(await onGitHub(clone, branch)).toBe(await git(clone.repo, 'rev-parse', branch))
    expect(clone.gh.state.pulls ?? []).toEqual([])

    const asked: SubmissionSummary[] = []
    const declined = await submitting(clone, [], {
      confirm: async (summary) => {
        asked.push(summary)
        return false
      },
    })
    expect(declined.code).toBe(0)
    expect(asked.map((summary) => summary.github?.pushedAlready)).toEqual([true])

    const again = await submitting(clone, ['--json'])
    expect(again.code).toBe(0)
    const submission = (JSON.parse(again.out) as { submission: Record<string, unknown> }).submission
    expect(submission).toMatchObject({ outcome: 'created', pushed: false, pullRequest: { number: 1, state: 'opened' } })
    expect(clone.gh.state.pulls).toHaveLength(1)
  })

  it('reports the pull request in --json', async () => {
    const clone = await githubClone()
    const created = await submitting(clone, ['--json'])
    expect(created.code).toBe(0)
    const first = (JSON.parse(created.out) as { submission: Record<string, unknown> }).submission
    expect(Object.keys(first).sort()).toEqual(['base', 'branch', 'commit', 'outcome', 'pullRequest', 'pushed'])
    expect(Object.keys(first['pullRequest'] as object).sort()).toEqual(['base', 'host', 'number', 'repository', 'state', 'url'])
    expect(first).toMatchObject({
      outcome: 'created',
      pushed: true,
      pullRequest: {
        host: 'github.com',
        repository: 'acme/iac',
        number: 1,
        url: 'https://github.com/acme/iac/pull/1',
        state: 'opened',
        base: 'main',
      },
    })

    const again = await submitting(clone, ['--json'])
    expect(again.code).toBe(0)
    const second = (JSON.parse(again.out) as { submission: Record<string, unknown> }).submission
    expect(second).toEqual({
      ...first,
      outcome: 'already-submitted',
      pushed: false,
      pullRequest: { ...(first['pullRequest'] as object), state: 'open' },
    })

    const stopped = await githubClone()
    stopped.gh.fault({ route: 'open-pull-request', status: 502, times: 1 })
    const stop = await submitting(stopped, ['--json'])
    expect(stop.code).toBe(1)
    const third = (JSON.parse(stop.out) as { submission: Record<string, unknown> }).submission
    expect(Object.keys(third).sort()).toEqual(['branch', 'commit', 'outcome', 'reason'])
    expect(third).toMatchObject({ outcome: 'pushed-without-pull-request', branch: await ourBranch(stopped.repo) })
    expect(third['reason']).toContain('GitHub answered 502 through gh')
  })

  it('refuses an unprotected base before anything is written, and prints the ruleset to add', async () => {
    const clone = await githubClone()
    unprotect(clone.gh)
    const before = await state(clone)

    const { code, out } = await submitting(clone)

    expect(code).toBe(1)
    const lines = out.trimEnd().split('\n')
    expect(lines[0]).toBe(
      `not submitted — nothing on ${WHERE}'s main stops the person who would open this pull request from merging it:`,
    )
    expect(lines).toContain('  missing: a pull request rule requiring 1 approval')
    for (const line of protectionText()) expect(lines).toContain(line)
    expect(lines.at(-1)).toBe('Then run this again. Nothing was written.')
    expect(out).not.toContain('+++')
    expect(await state(clone)).toBe(before)

    const json = await submitting(clone, ['--json'])
    expect(json.code).toBe(1)
    const report = JSON.parse(json.out) as Record<string, unknown>
    expect(Object.keys(report)).toEqual(['submission'])
    const refused = report['submission'] as { outcome: string; reasons: string[] }
    expect(Object.keys(refused).sort()).toEqual(['outcome', 'reasons'])
    expect(refused.outcome).toBe('refused')
    expect(refused.reasons[0]).toBe(lines[0])
    expect(refused.reasons).toContain('  missing: a pull request rule requiring 1 approval')
    expect(await state(clone)).toBe(before)
  })

  it('refuses a clone that is not level with GitHub, naming both commits', async () => {
    const clone = await githubClone()
    const local = await git(clone.repo, 'rev-parse', 'main')
    await moveGitHubBase(clone)
    const ahead = await git(clone.bare, 'rev-parse', 'main')
    const before = await state(clone)

    const { code, out } = await submitting(clone)

    expect(code).toBe(1)
    expect(out.trimEnd()).toBe(
      `not submitted — ${WHERE}'s main is at ${ahead.slice(0, 7)} and this clone's main is at ${local.slice(0, 7)}: ` +
        'bring them level (git pull), then run this again. If you submitted this change before, the next run names ' +
        'its pull request. Nothing was written.',
    )
    expect(await state(clone)).toBe(before)
  })

  const NOT_LOGGED_IN =
    `main tracks ${WHERE}, and gh is not logged in to github.com, so idpa cannot read the rules that keep a pull ` +
    'request from merging unreviewed. Run `gh auth login --hostname github.com`, then run this again; or add --local ' +
    'to cut the branch in this clone only. Nothing was written.'

  it.each<readonly [string, (clone: GitHubClone) => GhProcess | undefined, string]>([
    [
      'gh missing',
      () => async () => ({ code: 'ENOENT', stdout: Buffer.alloc(0), stderr: '', timedOut: false }),
      `main tracks ${WHERE}, and gh is not installed, so idpa cannot read the rules that keep a pull request from ` +
        'merging unreviewed. Install it (https://cli.github.com) and run this again; or add --local to cut the branch ' +
        'in this clone only. Nothing was written.',
    ],
    [
      'gh logged out',
      (clone) => {
        clone.gh.logout()
        return undefined
      },
      NOT_LOGGED_IN,
    ],
    [
      'a login GitHub refuses',
      (clone) => {
        clone.gh.fault({ route: 'user', status: 401, times: 1 })
        return undefined
      },
      NOT_LOGGED_IN,
    ],
    [
      'a gh older than the oldest this build reads',
      (clone) => {
        clone.gh.state.version = '2.30.0'
        return undefined
      },
      'gh 2.30.0 is older than 2.40.0, the oldest this build reads; update gh, then run this again; or add --local to ' +
        'cut the branch in this clone only. Nothing was written.',
    ],
    [
      'a bot',
      (clone) => {
        clone.gh.state.accounts = [...clone.gh.state.accounts, { login: 'ada-bot', type: 'Bot' }]
        clone.gh.as('ada-bot')
        return undefined
      },
      "gh is logged in to github.com as ada-bot, which GitHub says is a Bot, not a person: the pull request's author " +
        'would be a bot, and whoever asked could approve it. Log gh in as yourself (gh auth login --hostname ' +
        'github.com), or add --local to cut the branch in this clone only. Nothing was written.',
    ],
  ])('refuses without a usable gh: exit 2, nothing written, --local named (%s)', async (_name, arrange, sentence) => {
    const clone = await githubClone()
    const gh = arrange(clone)
    const before = await state(clone)

    const { code, out, err } = await submitting(clone, [], gh === undefined ? {} : { gh })

    expect(code).toBe(2)
    expect(err.trimEnd()).toBe(sentence)
    expect(out).toBe('')
    expect(await state(clone)).toBe(before)
  })

  it.each([
    ['credential.helper', 'store --file=/tmp/canary-credential-store', 'credential.helper'],
    ['url.git@evil.example:.insteadOf', 'git@nowhere.example:', 'url.git@evil.example:.insteadof'],
  ])(
    'refuses a key of the clone’s own configuration before gh and before any write, naming it and never its value (%s)',
    async (key, value, listed) => {
      const clone = await githubClone()
      await git(clone.repo, 'config', '--local', key, value)
      const gh = untouchable()
      const before = await state(clone)

      const { code, out, err } = await submitting(clone, [], { gh })

      expect(code).toBe(2)
      expect(err.trimEnd()).toBe(configRefusal({ scope: 'local', key: listed }, 0))
      expect(err).toContain('(local)')
      for (const text of [out, err]) {
        for (const secret of ['canary-credential-store', 'git@nowhere.example:', 'evil.example']) {
          expect(text).not.toContain(secret)
        }
      }
      expect(out).toBe('')
      expect(gh.calls()).toBe(0)
      expect(await state(clone)).toBe(before)
    },
  )

  it.each<readonly [string, (clone: GitHubClone) => Promise<void>, readonly string[], string]>([
    [
      'no upstream',
      async (clone) => {
        await git(clone.repo, 'config', '--unset', 'branch.main.remote')
        await git(clone.repo, 'config', '--unset', 'branch.main.merge')
      },
      [],
      'main tracks no remote: nothing pushed',
    ],
    [
      'another host',
      async (clone) => {
        await git(clone.repo, 'remote', 'set-url', 'origin', 'git@gitlab.example.com:acme/iac.git')
      },
      [],
      'the remote is on gitlab.example.com, where this build opens no pull request: nothing pushed',
    ],
    ['--local', async () => undefined, ['--local'], '--local: nothing pushed by this run'],
  ])('takes stage 5’s road where no pull request can be opened, and never starts gh (%s)', async (_name, arrange, extra, line) => {
    const clone = await githubClone()
    await arrange(clone)
    const gh = untouchable()
    const refs = await remoteRefs(clone.bare)
    const main0 = await git(clone.repo, 'rev-parse', 'main')

    const { code, out, err } = await submitting(clone, extra, { gh })

    expect(code, err).toBe(0)
    const branch = await ourBranch(clone.repo)
    expect(out.trimEnd().split('\n').slice(-3)).toEqual([
      `2 files · submitted as ${branch} on top of main@${main0.slice(0, 7)} · main untouched`,
      line,
      CLOSING,
    ])
    expect(err).not.toContain('submitting to')
    expect(gh.calls()).toBe(0)
    expect(await remoteRefs(clone.bare)).toBe(refs)
  })

  // The branch-name grammar guards what GitHub's paths read; a branch that
  // tracks nothing is read on no path, so its name takes stage 5's road as it
  // did before the road was read (§ 13's table).
  it('takes stage 5’s road on a branch that tracks nothing, whatever its name', async () => {
    const clone = await githubClone()
    await git(clone.repo, 'checkout', '-q', '-b', 'wip%20')
    const gh = untouchable()
    const refs = await remoteRefs(clone.bare)
    const tip = await git(clone.repo, 'rev-parse', 'HEAD')

    const { code, out, err } = await submitting(clone, [], { gh })

    expect(code, err).toBe(0)
    const branch = await ourBranch(clone.repo)
    expect(out.trimEnd().split('\n').slice(-3)).toEqual([
      `2 files · submitted as ${branch} on top of wip%20@${tip.slice(0, 7)} · wip%20 untouched`,
      'wip%20 tracks no remote: nothing pushed',
      CLOSING,
    ])
    expect(gh.calls()).toBe(0)
    expect(await remoteRefs(clone.bare)).toBe(refs)
  })

  it('re-checks the rules after the confirmation, and writes nothing when they are gone', async () => {
    const clone = await githubClone()
    const before = await state(clone)

    const { code, out } = await submitting(clone, [], {
      confirm: async () => {
        unprotect(clone.gh)
        return true
      },
    })

    expect(code).toBe(1)
    const lines = out.trimEnd().split('\n')
    expect(lines.slice(-4)).toEqual([
      '2 files · not submitted:',
      expect.stringMatching(
        new RegExp(`^  nothing on ${WHERE}'s main stops the person who would open this pull request from merging it \\(missing: .+\\); idpa protection says what to add\\.$`),
      ),
      'Nothing was written.',
      CLOSING,
    ])
    expect(await state(clone)).toBe(before)
  })

  it('says the local branch stays when the push fails', async () => {
    const clone = await githubClone()
    const env = { ...clone.env, GIT_SSH_COMMAND: await fakeSsh(path.dirname(clone.repo), clone.bare, 'publickey') }
    const refs = await remoteRefs(clone.bare)

    const { code, out, err } = await submitting(clone, [], { env })

    expect(code).toBe(1)
    const branch = await ourBranch(clone.repo)
    expect(out).toContain('your git could not authenticate to github.com')
    expect(out.trimEnd().split('\n').slice(-2)).toEqual([
      `${branch} was cut in this clone, and no pull request was opened.`,
      CLOSING,
    ])
    for (const text of [out, err]) expect(text).not.toContain('Permission denied')
    expect(await remoteRefs(clone.bare)).toBe(refs)
    expect(clone.gh.state.pulls ?? []).toEqual([])
  })

  it.each([
    [
      'closed',
      { state: 'closed' as const, closed_at: '2026-10-02T09:00:00Z', merged_at: null },
      (branch: string) => [
        `2 files · not submitted — ${branch} was submitted as pull request #1 and closed on 2026-10-02 · nothing written`,
        'A closed request is not reopened by this tool: reopen it on GitHub, or change the request.',
        CLOSING,
      ],
    ],
    [
      'merged since reverted',
      { state: 'closed' as const, closed_at: '2026-10-02T09:00:00Z', merged_at: '2026-10-02T09:00:00Z' },
      (branch: string) => [
        `2 files · not submitted — ${branch} was merged as pull request #1, and main no longer carries it · nothing written`,
        "A reverted change is a reviewer's decision, which this tool does not re-request.",
        CLOSING,
      ],
    ],
  ])('refuses a pull request %s, and never reopens it', async (_name, change, expected) => {
    const clone = await githubClone()
    expect((await submitting(clone)).code).toBe(0)
    const [pull] = clone.gh.state.pulls ?? []
    if (pull === undefined) throw new Error('no pull request was opened')
    Object.assign(pull, change)
    const before = await state(clone)

    const { code, out } = await submitting(clone)

    expect(code).toBe(1)
    expect(out.trimEnd().split('\n').slice(-3)).toEqual(expected(await ourBranch(clone.repo)))
    expect(clone.gh.state.pulls?.[0]?.state).toBe('closed')
    expect(await state(clone)).toBe(before)
  })

  it('tries every door after a submission through main, and each is refused', async () => {
    const clone = await githubClone()
    expect((await submitting(clone)).code).toBe(0)
    const main = await git(clone.bare, 'rev-parse', 'main')

    for (const door of DOORS) {
      const exit: GhExit = await clone.gh.process(door.argv, {
        ...(door.stdin === undefined ? {} : { stdin: Buffer.from(door.stdin) }),
        env: {},
        limits: GH_LIMITS,
      })
      if (!MODELLED_DOORS.has(door.name)) {
        expect(exit.code, door.name).toBe(REFUSED_EXIT)
      } else if (door.argv[0] === 'api') {
        const status = parseIncluded(exit.stdout)?.status ?? 0
        expect(status >= 400 && status < 500, `${door.name}: ${String(status)}`).toBe(true)
      } else {
        expect(exit.code, door.name).toBe(1)
        expect(exit.stderr, door.name).toMatch(/was not (merged|approved)/)
      }
      expect(clone.gh.state.pulls?.[0]?.state, door.name).toBe('open')
      expect(await git(clone.bare, 'rev-parse', 'main'), door.name).toBe(main)
    }
  })

  it('refuses a plan writing into both repositories by name on a GitHub road, pointing at init --submit, and pushes nothing (D6)', async () => {
    // D6 is the clearance's, and this task changes nothing of it; its sentence
    // points at init --submit, which reaches GitHub since 6.3.2.
    const clone = await githubClone()
    const file = path.join(path.dirname(clone.repo), 'both.json')
    await writeFile(
      file,
      `${JSON.stringify(
        {
          intent: `${INTENT}, and billing-api as a production service in catalog-info.yaml`,
          operations: [
            ...OPERATIONS,
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
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    const vectors: string[][] = []
    const gh: GhProcess = async (argv, options) => {
      vectors.push([...argv])
      return clone.gh.process(argv, options)
    }
    const before = await state(clone)
    const out: string[] = []
    const err: string[] = []

    const code = await main(['plan', '--from', file, '--repo', clone.repo, '--submit'], {
      out: (chunk) => void out.push(chunk),
      err: (chunk) => void err.push(chunk),
      env: clone.env,
      gh,
      ask,
    })

    expect(code, err.join('')).toBe(1)
    expect(out.join('')).toContain('plan --submit cuts a branch in the declarations repository only — submit it with init --submit')
    expect(out.join('')).toContain('Nothing was written.')
    expect(await git(clone.repo, 'for-each-ref', 'refs/heads/idp-agent/')).toBe('')
    expect(await git(clone.bare, 'for-each-ref', 'refs/heads/idp-agent/')).toBe('')
    expect(vectors.filter((argv) => argv.includes('POST'))).toEqual([])
    expect(await state(clone)).toBe(before)
  })
})

describe('refuseUnprotected', { timeout: RUNS }, () => {
  it('judges a forge and its base once, and judges a base that moved again', async () => {
    // A road that reads the preflight early (the phrase's, 6.3.3) is not
    // read again by runIntent: § 8's routes once per run, within the budget.
    const clone = await githubClone()
    const opened = await openForSubmission(clone.repo, 'declarations', {
      env: clone.env,
      gh: clone.gh.process,
      route: 'intent',
    })
    expect(await refuseUnprotected(opened)).toBeUndefined()
    const once = clone.gh.sent.length
    expect(once).toBeGreaterThan(2)

    expect(await refuseUnprotected(opened)).toBeUndefined()
    expect(clone.gh.sent.length).toBe(once)

    const moved = { ...opened, base: { ...opened.base, commit: '0'.repeat(40) } }
    const refused = await refuseUnprotected(moved)
    expect(clone.gh.sent.length).toBeGreaterThan(once)
    expect(refused?.text).toContain('bring them level (git pull)')
  })
})

describe('the fixture that pushes', { timeout: RUNS }, () => {
  // A git configuration that rewrites github.com's URL sends the push, and
  // whatever credential helper the machine has, to the real GitHub: every
  // test, demo and key-reach leg that pushes checks the URL as the launcher's
  // git will read it before it pushes at all.
  it('refuses a machine whose git configuration rewrites github.com', async () => {
    const clone = await githubClone()
    expect(() => requireUnrewritten(clone.repo, clone.env)).not.toThrow()
    await writeFile(
      path.join(String(clone.env['HOME']), '.gitconfig'),
      '[url "https://github.com/"]\n\tinsteadOf = git@github.com:\n',
    )
    expect(() => requireUnrewritten(clone.repo, clone.env)).toThrow(/rewrites git@github\.com:acme\/iac\.git/)
  })
})

describe('the closing lines of a submission', () => {
  const BASE = { branch: 'main', commit: 'abc1234def5678' }
  const B = 'idp-agent/orders-db-prod-3f9c2a1b'
  const GITHUB: GitHubRoad = {
    kind: 'github',
    repository: { host: 'github.com', owner: 'acme', name: 'iac' },
    remote: 'origin',
    base: 'main',
    branch: 'main',
    pushUrl: GITHUB_URL,
  }
  const pull = (state: PullRequest['state']): PullRequest => ({
    host: 'github.com',
    repository: 'acme/iac',
    number: 3,
    url: 'https://github.com/acme/iac/pull/3',
    state,
    base: 'main',
  })

  it('closes every road on its own line, and never on NO_FORGE', () => {
    const rows: readonly (readonly [PreviewStatus, readonly string[]])[] = [
      [
        { kind: 'submitted', again: false, branch: B, base: BASE, road: { kind: 'local', why: 'no-upstream', branch: 'main' } },
        [`1 file · submitted as ${B} on top of main@abc1234 · main untouched`, 'main tracks no remote: nothing pushed', CLOSING],
      ],
      [
        { kind: 'submitted', again: false, branch: B, base: BASE, road: { kind: 'local', why: 'other-host', host: 'gitlab.example.com' } },
        [
          `1 file · submitted as ${B} on top of main@abc1234 · main untouched`,
          'the remote is on gitlab.example.com, where this build opens no pull request: nothing pushed',
          CLOSING,
        ],
      ],
      [
        { kind: 'submitted', again: true, branch: B, base: BASE, road: { kind: 'local', why: 'asked' } },
        [`1 file · already submitted as ${B} · nothing written`, '--local: nothing pushed by this run', CLOSING],
      ],
      [
        { kind: 'submitted', again: false, branch: B, base: BASE, road: GITHUB, pullRequest: pull('opened'), statusChecks: [] },
        [
          `1 file · submitted as ${B} on top of main@abc1234 · main untouched`,
          'Pull request #3 opened on github.com/acme/iac: https://github.com/acme/iac/pull/3',
          MERGING,
          CLOSING,
        ],
      ],
      [
        {
          kind: 'submitted',
          again: false,
          branch: B,
          base: BASE,
          road: GITHUB,
          pullRequest: pull('open'),
          statusChecks: ['ci/validate', 'downstream/tufin'],
        },
        [
          `1 file · submitted as ${B} on top of main@abc1234 · main untouched`,
          'Pull request #3 is open on github.com/acme/iac: https://github.com/acme/iac/pull/3',
          'Merging it waits for one approval of its latest commit from someone other than you, and for the status ' +
            'checks ci/validate, downstream/tufin.',
          CLOSING,
        ],
      ],
      [
        {
          kind: 'submitted',
          again: false,
          branch: B,
          base: { branch: 'main', commit: 'def5678abc' },
          road: GITHUB,
          pullRequest: pull('opened'),
          olderBase: 'abc1234def',
        },
        [
          `1 file · submitted as ${B} on top of main@abc1234, an older main (now def5678; GitHub shows whether it still ` +
            'merges cleanly) · main untouched',
          'Pull request #3 opened on github.com/acme/iac: https://github.com/acme/iac/pull/3',
          MERGING,
          CLOSING,
        ],
      ],
      [
        { kind: 'submitted', again: true, branch: B, base: BASE, road: GITHUB, pullRequest: pull('open') },
        [`1 file · already submitted as ${B} · pull request #3 is open · nothing written`, CLOSING],
      ],
      [
        {
          kind: 'submitted',
          again: true,
          branch: B,
          base: { branch: 'main', commit: 'def5678abc' },
          road: GITHUB,
          pullRequest: pull('open'),
          olderBase: 'abc1234def',
        },
        [
          `1 file · already submitted as ${B} · pull request #3 is open, on main@abc1234; main is now def5678, and ` +
            'GitHub shows whether it still merges cleanly · nothing written',
          CLOSING,
        ],
      ],
      [
        {
          kind: 'pushed-without-pull-request',
          branch: B,
          repository: WHERE,
          reason: 'the pull request was not opened: GitHub answered 502 through gh. Run the same command again to open it.',
        },
        [
          `1 file · ${B} is on github.com/acme/iac, and the pull request was not opened: GitHub answered 502 through gh. ` +
            'Run the same command again to open it.',
          CLOSING,
        ],
      ],
      [
        { kind: 'closed', branch: B, number: 3, merged: false, at: '2026-10-02', base: 'main' },
        [
          `1 file · not submitted — ${B} was submitted as pull request #3 and closed on 2026-10-02 · nothing written`,
          'A closed request is not reopened by this tool: reopen it on GitHub, or change the request.',
          CLOSING,
        ],
      ],
      [
        { kind: 'closed', branch: B, number: 3, merged: true, at: '2026-10-02', base: 'main' },
        [
          `1 file · not submitted — ${B} was merged as pull request #3, and main no longer carries it · nothing written`,
          "A reverted change is a reviewer's decision, which this tool does not re-request.",
          CLOSING,
        ],
      ],
      [
        { kind: 'refused', reasons: ['the push to github.com failed'], kept: B },
        ['1 file · not submitted:', '  the push to github.com failed', `${B} was cut in this clone, and no pull request was opened.`, CLOSING],
      ],
      [
        { kind: 'refused', reasons: ['a reason'] },
        ['1 file · not submitted:', '  a reason', 'Nothing was written.', CLOSING],
      ],
    ]
    for (const [status, expected] of rows) {
      const lines = closingLines(status, 1)
      expect(lines).toEqual(expected)
      expect(lines.join('\n')).not.toContain('no forge')
    }

    const roads: readonly (readonly [LocalRoad, string])[] = [
      [{ kind: 'local', why: 'no-upstream', branch: 'main' }, 'main tracks no remote: nothing pushed'],
      [
        { kind: 'local', why: 'other-host', host: 'this machine' },
        'the remote is on this machine, where this build opens no pull request: nothing pushed',
      ],
      [{ kind: 'local', why: 'asked' }, '--local: nothing pushed by this run'],
    ]
    for (const [road, line] of roads) expect(localRoadLine(road)).toBe(line)

    // A context is GitHub's: a bidi control in it is spelled out.
    expect(pullRequestLines(pull('opened'), { statusChecks: ['ci/\u202evalidate'] })[1]).toBe(
      'Merging it waits for one approval of its latest commit from someone other than you, and for the status checks ' +
        'ci/\\u202evalidate.',
    )
    expect(() => closingLines({ kind: 'submitted', again: false, branch: B, base: BASE, road: GITHUB }, 1)).toThrow()
  })

  it('names the road, the pull request and the gh calls, never the login', () => {
    const created: SubmissionReport = {
      outcome: 'created',
      branch: B,
      commit: 'c0ffee',
      base: BASE,
      pushed: true,
      pullRequest: pull('opened'),
    }
    const onGitHub = forgeAttributes(created, GITHUB, 17)
    expect(onGitHub).toEqual({
      'idp.forge.kind': 'github',
      'idp.forge.host': 'github.com',
      'idp.forge.repository': 'acme/iac',
      'idp.forge.base': 'main',
      'idp.forge.branch': B,
      'idp.forge.pull_request': 3,
      'idp.forge.outcome': 'created',
      'idp.forge.gh_calls': 17,
      'idp.forge.pushed': true,
    })
    expect(JSON.stringify(onGitHub)).not.toContain('ada')

    const local = forgeAttributes(
      { outcome: 'created', branch: B, commit: 'c0ffee', base: BASE, pushed: false },
      { kind: 'local', why: 'asked' },
      0,
    )
    expect(local).toEqual({
      'idp.forge.kind': 'local',
      'idp.forge.base': 'main',
      'idp.forge.branch': B,
      'idp.forge.outcome': 'created',
      'idp.forge.gh_calls': 0,
      'idp.forge.pushed': false,
    })
    expect(forgeAttributes({ outcome: 'declined', branch: B }, { kind: 'local', why: 'other-host', host: 'gitlab.example.com' }, 0)).toEqual({
      'idp.forge.kind': 'local',
      'idp.forge.host': 'gitlab.example.com',
      'idp.forge.branch': B,
      'idp.forge.outcome': 'declined',
      'idp.forge.gh_calls': 0,
      'idp.forge.pushed': false,
    })
    // A refusal that kept the branch may follow a push that landed (step 11's
    // read-back found nothing, or another commit): it claims neither way.
    expect(forgeAttributes({ outcome: 'refused', reasons: ['r'], kept: B }, GITHUB, 9)).not.toHaveProperty('idp.forge.pushed')
    expect(forgeAttributes({ outcome: 'refused', reasons: ['r'] }, GITHUB, 9)).toMatchObject({ 'idp.forge.pushed': false })
  })
})
