import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { main } from '../../src/cli/index.js'
import type { Ask } from '../../src/cli/commands/plan.js'
import {
  forgeAttributes,
  openForSubmission,
  patchLines,
  refuseUnprotected,
  sayInFlight,
  type Confirm,
  type Opened,
  type SubmissionReport,
  type SubmissionSummary,
} from '../../src/cli/commands/submit.js'
import { closingLines, CLOSING, inFlightLines, localRoadLine, pullRequestLines, type PreviewStatus } from '../../src/cli/render/footer.js'
import { PATCH_LINES, type InFlightEntry, type InFlightPull, type InFlightVerdict } from '../../src/core/github/in-flight.js'
import { configRefusal } from '../../src/core/github/config.js'
import { GH_MINIMUM_VERSION } from '../../src/core/github/gh-version.js'
import { MERGE_NOTE, unguardedNote } from '../../src/core/github/protection.js'
import type { GitHubRoad, LocalRoad, PullRequest } from '../../src/forge/provider.js'
import { GH_LIMITS, parseIncluded, type GhExit, type GhProcess } from '../../src/process/gh.js'
import { REFUSED_EXIT } from '../../tools/fake-gh.js'
import { confirmingEnvironment } from '../support/ask.js'
import { DATABASE_PATH, INTENT, OPERATIONS, removeClones } from '../support/forge-fixture.js'
import { DOORS, MODELLED_DOORS, QUEUED_MERGE_DOOR, protectedMain } from '../support/fake-gh.js'
import {
  BILLING_GRANT,
  BILLING_GRANT_PATH,
  fakeSsh,
  GITHUB_URL,
  githubClone,
  moveGitHubBase,
  onMain,
  pullRequestBy,
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
): Promise<{ code: number; out: string; err: string; chunks: readonly { readonly to: 'out' | 'err'; readonly text: string }[] }> => {
  const out: string[] = []
  const err: string[] = []
  const chunks: { to: 'out' | 'err'; text: string }[] = []
  const code = await main(['plan', '--from', await planFile(clone), '--repo', clone.repo, '--submit', ...extra], {
    out: (chunk) => {
      out.push(chunk)
      chunks.push({ to: 'out', text: chunk })
    },
    err: (chunk) => {
      err.push(chunk)
      chunks.push({ to: 'err', text: chunk })
    },
    env: deps.env ?? clone.env,
    gh: deps.gh ?? clone.gh.process,
    ask,
    ...(deps.confirm === undefined ? {} : { confirm: deps.confirm }),
  })
  return { code, out: out.join(''), err: err.join(''), chunks }
}

/** How many times `line` is said on stderr, a line of its own. */
const saidOnStderr = (err: string, line: string): number => err.split('\n').filter((one) => one === line).length

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
      { host: 'github.com', repository: 'acme/iac', base: 'main', pushedAlready: false, authorMayMergeAlone: false },
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

  it('opens the pull request on an unprotected base, says the note on stderr and in its body, and exits 0', async () => {
    const clone = await githubClone()
    unprotect(clone.gh)
    const main0 = await git(clone.repo, 'rev-parse', 'main')

    const { code, out, err } = await submitting(clone)

    expect(code, err).toBe(0)
    expect(err.split('\n').slice(0, 2)).toEqual([SUBMITTING, MERGE_NOTE])
    expect(saidOnStderr(err, MERGE_NOTE)).toBe(1)
    expect(out).not.toContain(MERGE_NOTE)
    expect(out).not.toContain('Add a ruleset')
    const branch = await ourBranch(clone.repo)
    expect(out.trimEnd().split('\n').slice(-4)).toEqual([
      `2 files · submitted as ${branch} on top of main@${main0.slice(0, 7)} · main untouched`,
      'Pull request #1 opened on github.com/acme/iac: https://github.com/acme/iac/pull/1',
      'No status check is required, so a system downstream could not refuse it (ADR-0012).',
      CLOSING,
    ])
    expect(clone.gh.state.pulls).toHaveLength(1)
    expect(clone.gh.state.pulls?.[0]?.body.split('\n')).toContain(MERGE_NOTE)

    const other = await githubClone()
    unprotect(other.gh)
    const json = await submitting(other, ['--json'])
    expect(json.code, json.err).toBe(0)
    expect(saidOnStderr(json.err, MERGE_NOTE)).toBe(1)
    const report = JSON.parse(json.out) as { submission: Record<string, unknown> }
    expect(Object.keys(report.submission).sort()).toEqual(['base', 'branch', 'commit', 'note', 'outcome', 'pullRequest', 'pushed'])
    expect(report.submission).toMatchObject({ outcome: 'created', note: 'author-may-merge', pushed: true, pullRequest: { number: 1 } })
    expect(other.gh.state.pulls?.[0]?.body.split('\n')).toContain(MERGE_NOTE)
  })

  it('asks without promising an approval where the author may merge alone', async () => {
    const clone = await githubClone()
    unprotect(clone.gh)
    const asked: SubmissionSummary[] = []

    const { code, err } = await submitting(clone, [], {
      confirm: async (summary) => {
        asked.push(summary)
        return false
      },
    })

    expect(code).toBe(0)
    expect(asked.map((summary) => summary.github)).toEqual([
      { host: 'github.com', repository: 'acme/iac', base: 'main', pushedAlready: false, authorMayMergeAlone: true },
    ])
    expect(saidOnStderr(err, MERGE_NOTE)).toBe(1)
    expect(clone.gh.state.pulls ?? []).toEqual([])
  })

  it('says the base-unguarded line, and keeps promising the approval, where only force pushes are unguarded', async () => {
    const clone = await githubClone()
    clone.gh.state.repositories = clone.gh.state.repositories.map((one) => ({
      ...one,
      rulesets: one.rulesets.map((ruleset) => ({ ...ruleset, rules: ruleset.rules.filter((rule) => rule.type !== 'non_fast_forward') })),
    }))
    const asked: SubmissionSummary[] = []

    const { code, out, err } = await submitting(clone, [], {
      confirm: async (summary) => {
        asked.push(summary)
        return true
      },
    })

    expect(code, err).toBe(0)
    const line = unguardedNote('main', ['non-fast-forward'])
    expect(saidOnStderr(err, line)).toBe(1)
    expect(err).not.toContain(MERGE_NOTE)
    expect(asked[0]?.github?.authorMayMergeAlone).toBe(false)
    expect(out.trimEnd().split('\n').slice(-2)).toEqual([MERGING, CLOSING])
    // The same words in the body, the base written as code.
    expect(clone.gh.state.pulls?.[0]?.body.split('\n')).toContain(unguardedNote('main', ['non-fast-forward'], 'markdown'))
  })

  it('refuses a repository gh’s account cannot push to, before anything is written', async () => {
    const clone = await githubClone()
    clone.gh.state.repositories = [protectedMain({ bare: clone.bare, permissions: { ada: { admin: false, maintain: false, push: false } } })]
    const before = await state(clone)

    const { code, out, err } = await submitting(clone)

    expect(code).toBe(1)
    expect(out.trimEnd().split('\n')).toEqual([
      'not submitted — github.com/acme/iac cannot take a pull request from this run:',
      "  missing: push access: gh's account cannot push to acme/iac",
      'Then run this again. Nothing was written.',
    ])
    expect(err).not.toContain('note:')
    expect(await state(clone)).toBe(before)

    const json = await submitting(clone, ['--json'])
    expect(json.code).toBe(1)
    const report = JSON.parse(json.out) as Record<string, unknown>
    expect(Object.keys(report)).toEqual(['submission'])
    expect(report['submission']).toEqual({
      outcome: 'refused',
      reasons: [
        'not submitted — github.com/acme/iac cannot take a pull request from this run:',
        "  missing: push access: gh's account cannot push to acme/iac",
      ],
    })
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
      `gh 2.30.0 is older than ${GH_MINIMUM_VERSION}, the oldest this build reads; update gh, then run this again; or add --local to ` +
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

  it('reads the rules after the confirmation, and opens the pull request with the note when they are gone', async () => {
    const clone = await githubClone()

    const { code, out, err, chunks } = await submitting(clone, [], {
      confirm: async () => {
        unprotect(clone.gh)
        return true
      },
    })

    expect(code, err).toBe(0)
    const lines = out.trimEnd().split('\n')
    expect(lines.slice(-3)).toEqual([
      'Pull request #1 opened on github.com/acme/iac: https://github.com/acme/iac/pull/1',
      'No status check is required, so a system downstream could not refuse it (ADR-0012).',
      CLOSING,
    ])
    // The preflight found none, so the note is said once, just above the closing lines.
    expect(saidOnStderr(err, MERGE_NOTE)).toBe(1)
    const note = chunks.findIndex((chunk) => chunk.to === 'err' && chunk.text.includes(MERGE_NOTE))
    const closing = chunks.findIndex((chunk) => chunk.to === 'out' && chunk.text.includes('Pull request #1 opened'))
    expect(note).toBeGreaterThan(-1)
    expect(note).toBeLessThan(closing)
    expect(clone.gh.state.pulls?.[0]?.body.split('\n')).toContain(MERGE_NOTE)
  })

  it('says step 11’s note again when its words differ from the preflight’s: force pushes, then deletions', async () => {
    const clone = await githubClone()
    const protectedRepositories = clone.gh.state.repositories
    /** The protected base, the rules of `types` taken out of every ruleset. */
    const without = (...types: readonly string[]): void => {
      clone.gh.state.repositories = protectedRepositories.map((one) => ({
        ...one,
        rulesets: one.rulesets.map((ruleset) => ({ ...ruleset, rules: ruleset.rules.filter((rule) => !types.includes(rule.type)) })),
      }))
    }
    without('non_fast_forward')

    const { code, err, chunks } = await submitting(clone, [], {
      confirm: async () => {
        without('deletion')
        return true
      },
    })

    expect(code, err).toBe(0)
    const before = unguardedNote('main', ['non-fast-forward'])
    const after = unguardedNote('main', ['deletion'])
    // Both said once, in that order: the second is what the body says.
    expect(saidOnStderr(err, before)).toBe(1)
    expect(saidOnStderr(err, after)).toBe(1)
    expect(err.indexOf(before)).toBeLessThan(err.indexOf(after))
    const said = chunks.findIndex((chunk) => chunk.to === 'err' && chunk.text.includes(after))
    const closing = chunks.findIndex((chunk) => chunk.to === 'out' && chunk.text.includes('Pull request #1 opened'))
    expect(said).toBeLessThan(closing)
    const body = clone.gh.state.pulls?.[0]?.body.split('\n') ?? []
    expect(body).toContain(unguardedNote('main', ['deletion'], 'markdown'))
    expect(body).not.toContain(unguardedNote('main', ['non-fast-forward'], 'markdown'))
  })

  it('says step 11’s note when it is another note than the preflight’s, and the body carries step 11’s', async () => {
    const clone = await githubClone()
    const protectedRepositories = clone.gh.state.repositories
    unprotect(clone.gh)

    const { code, out, err } = await submitting(clone, [], {
      confirm: async () => {
        // The ruleset comes back, without its deletion rule.
        clone.gh.state.repositories = protectedRepositories.map((one) => ({
          ...one,
          rulesets: one.rulesets.map((ruleset) => ({ ...ruleset, rules: ruleset.rules.filter((rule) => rule.type !== 'deletion') })),
        }))
        return true
      },
    })

    expect(code, err).toBe(0)
    const after = unguardedNote('main', ['deletion'])
    expect(saidOnStderr(err, MERGE_NOTE)).toBe(1)
    expect(saidOnStderr(err, after)).toBe(1)
    expect(err.indexOf(MERGE_NOTE)).toBeLessThan(err.indexOf(after))
    // Step 11's read decides the body and the closing lines: an approval is required there.
    expect(out.trimEnd().split('\n').slice(-2)).toEqual([MERGING, CLOSING])
    const body = clone.gh.state.pulls?.[0]?.body.split('\n') ?? []
    expect(body).toContain(unguardedNote('main', ['deletion'], 'markdown'))
    expect(body).not.toContain(MERGE_NOTE)
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
      } else if (door.name === QUEUED_MERGE_DOOR.name) {
        // Accepted, as GitHub accepts it (2026-10-02), and judged later: the pull request and main say it was refused.
        expect(parseIncluded(exit.stdout)?.status, door.name).toBe(202)
      } else if (door.argv[0] === 'api') {
        const status = parseIncluded(exit.stdout)?.status ?? 0
        expect(status >= 400 && status < 500, `${door.name}: ${String(status)}`).toBe(true)
      } else {
        expect(exit.code, door.name).toBe(1)
        expect(exit.stderr, door.name).toMatch(/was not (merged|approved)/)
      }
      expect(clone.gh.state.pulls?.[0]?.state, door.name).toBe('open')
      expect(clone.gh.state.pulls?.[0]?.merged_at, door.name).toBeNull()
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

describe('what is in flight on plan --from --submit (6.3.6)', { timeout: RUNS }, () => {
  /** Two people who may push, ada logged in. */
  const two = (): Promise<GitHubClone> =>
    githubClone({ model: { accounts: [{ login: 'ada', type: 'User' }, { login: 'grace', type: 'User' }] } }).then((clone) => {
      clone.gh.state.repositories = clone.gh.state.repositories.map((one) => ({
        ...one,
        permissions: { ...one.permissions, grace: { admin: false, maintain: false, push: true } },
      }))
      return clone
    })

  it('names a change already proposed by another account, exit 0, nothing written', async () => {
    const clone = await two()
    clone.gh.as('grace')
    expect((await submitting(clone)).code).toBe(0)
    clone.gh.as('ada')
    const before = await state(clone)

    const { code, out, err } = await submitting(clone, [], {
      confirm: async () => {
        throw new Error('a change already proposed was put to a person')
      },
    })

    expect(code, err).toBe(0)
    expect(saidOnStderr(err, 'already proposed by grace in pull request #1')).toBe(1)
    expect(out.trimEnd().split('\n').slice(-2)).toEqual([
      `2 files · already proposed in pull request #1 on ${WHERE}: https://github.com/acme/iac/pull/1 · nothing written`,
      CLOSING,
    ])
    expect(out).not.toContain('grace')
    expect(await state(clone)).toBe(before)

    const json = await submitting(clone, ['--json'])
    expect(json.code).toBe(0)
    const submission = (JSON.parse(json.out) as { submission: Record<string, unknown> }).submission
    expect(Object.keys(submission).sort()).toEqual(['branch', 'number', 'outcome', 'url'])
    expect(submission).toEqual({
      outcome: 'already-proposed',
      branch: await ourBranch(clone.repo),
      number: 1,
      url: 'https://github.com/acme/iac/pull/1',
    })
    expect(json.out).not.toContain('grace')
  })

  it('refuses a change a pull request in flight already changes differently, shows its patch on stderr, exit 1', async () => {
    const clone = await two()
    const forged = '1 file · submitted as idp-agent/forged-0123abcd on top of main@0000000 · main untouched'
    await pullRequestBy(clone, { login: 'grace', edits: { [DATABASE_PATH]: `kind: Resource\n# ${forged}\n` } })
    const theirs = clone.gh.state.pulls?.[0]?.head ?? ''
    const before = await state(clone)

    const { code, out, err } = await submitting(clone, [], {
      confirm: async () => {
        throw new Error('a competing change was put to a person')
      },
    })

    expect(code).toBe(1)
    expect(out.trimEnd().split('\n').slice(-4)).toEqual([
      '2 files · not submitted:',
      `  pull request #1 on ${WHERE} already changes ${DATABASE_PATH}, differently: https://github.com/acme/iac/pull/1`,
      'Review it there, or run this again once it is merged or closed. Nothing was written.',
      CLOSING,
    ])
    expect(out).not.toContain('grace')
    expect(out).not.toContain(theirs)
    expect(out).not.toContain(forged)
    const lines = err.split('\n')
    expect(lines).toContain(`pull request #1 is by grace, from ${theirs}`)
    const at = lines.indexOf(`In pull request #1, ${DATABASE_PATH}:`)
    expect(at).toBeGreaterThan(-1)
    const patch = lines.slice(at + 1).filter((line) => line.startsWith('    '))
    expect(patch.some((line) => line.includes(forged)), err).toBe(true)
    // The forged line is on stderr, indented under its heading, and nowhere else.
    expect(lines.filter((line) => line.includes(forged)).every((line) => line.startsWith('    '))).toBe(true)
    expect(await state(clone)).toBe(before)

    const json = await submitting(clone, ['--json'])
    const submission = (JSON.parse(json.out) as { submission: Record<string, unknown> }).submission
    expect(submission).toEqual({
      outcome: 'refused',
      reasons: [`pull request #1 on ${WHERE} already changes ${DATABASE_PATH}, differently: https://github.com/acme/iac/pull/1`],
      inFlight: [{ number: 1, url: 'https://github.com/acme/iac/pull/1', paths: [DATABASE_PATH] }],
    })
    expect(json.out).not.toContain('grace')
  })

  it('names the person’s own pull request as already submitted, exit 0, while another account’s competes with it', async () => {
    const clone = await two()
    expect((await submitting(clone)).code).toBe(0)
    await pullRequestBy(clone, { login: 'grace', edits: { [DATABASE_PATH]: 'kind: Resource\n# other\n' } })
    const before = await state(clone)

    const { code, out, err } = await submitting(clone, [], {
      confirm: async () => {
        throw new Error('a change already submitted was put to a person')
      },
    })

    expect(code, err).toBe(0)
    const branch = await ourBranch(clone.repo)
    expect(out.trimEnd().split('\n').slice(-2)).toEqual([
      `2 files · already submitted as ${branch} · pull request #1 is open · nothing written`,
      CLOSING,
    ])
    expect(err).not.toContain('grace')
    expect(await state(clone)).toBe(before)
  })

  it('says what is in flight changed while the person read the diff, then refuses the competing change step 8 found, exit 1', async () => {
    const clone = await two()
    let theirs = ''

    const { code, out, err } = await submitting(clone, [], {
      confirm: async () => {
        await pullRequestBy(clone, { login: 'grace', edits: { [DATABASE_PATH]: 'kind: Resource\n# grace was faster\n' } })
        theirs = clone.gh.state.pulls?.[0]?.head ?? ''
        return true
      },
    })

    expect(code, err).toBe(1)
    const lines = err.split('\n')
    const changed = lines.indexOf('what is in flight changed while you read the diff:')
    expect(changed, err).toBeGreaterThan(-1)
    expect(lines.slice(changed + 1, changed + 5)).toEqual([
      `pull request #1 is by grace, from ${theirs}`,
      `In pull request #1, ${DATABASE_PATH}:`,
      '    @@ -0,0 +1,2 @@',
      '    +kind: Resource',
    ])
    expect(saidOnStderr(err, 'what is in flight changed while you read the diff:')).toBe(1)
    expect(out.trimEnd().split('\n').slice(-4)).toEqual([
      '2 files · not submitted:',
      `  pull request #1 on ${WHERE} already changes ${DATABASE_PATH}, differently: https://github.com/acme/iac/pull/1`,
      'Review it there, or run this again once it is merged or closed. Nothing was written.',
      CLOSING,
    ])
    expect(clone.gh.state.pulls).toHaveLength(1)
  })

  it('says nothing changed in flight when step 8 finds what was shown before the question', async () => {
    const clone = await two()

    const { code, err } = await submitting(clone, [], { confirm: async () => true })

    expect(code, err).toBe(0)
    expect(err).not.toContain('what is in flight changed')
  })

  it('asks, and opens, beside a pull request on another file of the same entities', async () => {
    const clone = await two()
    await onMain(clone, { [BILLING_GRANT_PATH]: BILLING_GRANT })
    await pullRequestBy(clone, { login: 'grace', edits: { [BILLING_GRANT_PATH]: BILLING_GRANT.replace('readwrite', 'read') } })
    const theirs = clone.gh.state.pulls?.[0]?.head ?? ''
    const asked: SubmissionSummary[] = []

    const { code, out, err } = await submitting(clone, [], {
      confirm: async (summary) => {
        asked.push(summary)
        return true
      },
    })

    expect(code, err).toBe(0)
    const beside = `In flight beside it on ${WHERE}: pull request #1, changing ${BILLING_GRANT_PATH}`
    expect(asked[0]?.preview.split('\n')).toContain(beside)
    expect(out.split('\n')).toContain(beside)
    expect(out).toContain('Pull request #2 opened on github.com/acme/iac: https://github.com/acme/iac/pull/2')
    expect(saidOnStderr(err, `pull request #1 is by grace, from ${theirs}`)).toBe(1)
    expect(out).not.toContain('grace')
    const body = clone.gh.state.pulls?.find((one) => one.number === 2)?.body ?? ''
    expect(body).toContain('Opened beside pull request 1, open into `main`, which change other files of the same entities.')
  })

  it('reads nothing of what is in flight with --local', async () => {
    const clone = await two()
    await pullRequestBy(clone, { login: 'grace', edits: { [DATABASE_PATH]: 'kind: Resource\n' } })
    const gh = untouchable()

    const { code } = await submitting(clone, ['--local'], { gh })

    expect(code).toBe(0)
    expect(gh.calls()).toBe(0)
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
        {
          kind: 'submitted',
          again: false,
          branch: B,
          base: BASE,
          road: GITHUB,
          pullRequest: pull('opened'),
          statusChecks: [],
          note: 'author-may-merge',
        },
        [
          `1 file · submitted as ${B} on top of main@abc1234 · main untouched`,
          'Pull request #3 opened on github.com/acme/iac: https://github.com/acme/iac/pull/3',
          'No status check is required, so a system downstream could not refuse it (ADR-0012).',
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
          pullRequest: pull('opened'),
          statusChecks: ['ci/validate', 'downstream/tufin'],
          note: 'author-may-merge',
        },
        [
          `1 file · submitted as ${B} on top of main@abc1234 · main untouched`,
          'Pull request #3 opened on github.com/acme/iac: https://github.com/acme/iac/pull/3',
          'Merging it waits for the status checks ci/validate, downstream/tufin.',
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
          pullRequest: pull('opened'),
          statusChecks: [],
          note: 'base-unguarded',
        },
        [
          `1 file · submitted as ${B} on top of main@abc1234 · main untouched`,
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

describe('the lines of what is in flight (6.3.6)', () => {
  const ROAD: GitHubRoad = {
    kind: 'github',
    repository: { host: 'github.com', owner: 'acme', name: 'iac' },
    remote: 'origin',
    base: 'main',
    branch: 'main',
    pushUrl: GITHUB_URL,
  }
  const FILES = (number: number): string => `https://github.com/acme/iac/pull/${String(number)}/files`
  const lines = (count: number, prefix = 'l'): string => Array.from({ length: count }, (_, at) => `+${prefix}${String(at)}`).join('\n')
  const pull = (number: number, files: InFlightPull['files'], more: Partial<InFlightPull> = {}): InFlightPull => ({
    number,
    by: 'grace',
    branch: `idp-agent/change-${String(number).padStart(8, '0')}`,
    head: 'c'.repeat(40),
    files,
    complete: true,
    ...more,
  })

  it('shows 40 lines of a path’s patch, then where the rest is, and says where GitHub shows none', () => {
    const entry: InFlightEntry = {
      pull: pull(1, [
        { path: 'a.yml', removed: false, blob: 'a'.repeat(40), patch: lines(45) },
        { path: 'b.yml', removed: false, blob: 'b'.repeat(40), patch: '' },
        { path: 'c.yml', removed: true },
      ]),
      paths: ['a.yml', 'b.yml', 'c.yml'],
    }

    expect(patchLines([entry], ROAD)).toEqual([
      'In pull request #1, a.yml:',
      ...Array.from({ length: 40 }, (_, at) => `    +l${String(at)}`),
      `    … 5 more lines: ${FILES(1)}`,
      'In pull request #1, b.yml:',
      `    (GitHub shows no patch for it: ${FILES(1)})`,
      'In pull request #1, c.yml:',
      `    (GitHub shows no patch for it: ${FILES(1)})`,
    ])
  })

  it('shows 120 lines of patch in a run, whatever the pull requests, then only where the rest is', () => {
    const entries: InFlightEntry[] = [1, 2, 3, 4].map((number) => ({
      pull: pull(number, [{ path: 'a.yml', removed: false, blob: 'a'.repeat(40), patch: lines(50, `p${String(number)}-`) }]),
      paths: ['a.yml'],
    }))

    const shown = patchLines(entries, ROAD)

    expect(shown.filter((line) => /^ {4}\+/.test(line))).toHaveLength(PATCH_LINES.perRun)
    expect(shown.slice(-2)).toEqual(['In pull request #4, a.yml:', `    … 50 more lines: ${FILES(4)}`])
    expect(shown.filter((line) => line.startsWith('    … '))).toEqual([
      `    … 10 more lines: ${FILES(1)}`,
      `    … 10 more lines: ${FILES(2)}`,
      `    … 10 more lines: ${FILES(3)}`,
      `    … 50 more lines: ${FILES(4)}`,
    ])
  })

  it('cuts a line of patch at 200 characters, counted in code points, and spells out what a terminal obeys', () => {
    const long = `+${'🙂'.repeat(200_000)}`
    const entry: InFlightEntry = {
      pull: pull(1, [{ path: 'a.yml', removed: false, blob: 'a'.repeat(40), patch: `${long}\n+\u001b[31mred\u202e` }]),
      paths: ['a.yml'],
    }

    expect(patchLines([entry], ROAD)).toEqual([
      'In pull request #1, a.yml:',
      `    +${'🙂'.repeat(199)}…`,
      '    +\\u001b[31mred\\u202e',
    ])
    expect(PATCH_LINES.perLine).toBe(200)
  })

  it('names five pull requests beside a change, then how many more, and says which list was cut', () => {
    const beside = {
      repository: 'github.com/acme/iac',
      pulls: [1, 2, 3, 4, 5, 6].map((number) => ({ number, paths: [`p${String(number)}.yml`], complete: number !== 2 })),
    }

    expect(inFlightLines(beside)).toEqual([
      'In flight beside it on github.com/acme/iac: pull request #1, changing p1.yml',
      'In flight beside it on github.com/acme/iac: pull request #2, changing p2.yml (more than 100 files; the first 100 compared)',
      'In flight beside it on github.com/acme/iac: pull request #3, changing p3.yml',
      'In flight beside it on github.com/acme/iac: pull request #4, changing p4.yml',
      'In flight beside it on github.com/acme/iac: pull request #5, changing p5.yml',
      '… and 1 more',
    ])
    expect(inFlightLines({ ...beside, pulls: beside.pulls.slice(0, 5) })).toHaveLength(5)
  })

  it('says five pull requests touching the service before the model, then how many more', async () => {
    const pulls: InFlightEntry[] = [1, 2, 3, 4, 5, 6].map((number) => ({ pull: pull(number, []), paths: ['components/billing-api.yml'] }))
    const verdict: InFlightVerdict = { kind: 'beside', pulls }
    const opened = { root: '/r', road: ROAD, base: { branch: 'main', commit: 'c'.repeat(40) }, forge: { inFlight: async () => verdict } } as unknown as Opened
    const notices: string[] = []

    const ended = await sayInFlight(opened, { what: 'component:default/billing-api', paths: ['components/billing-api.yml'] }, {
      notice: (line) => notices.push(line),
    })

    expect(ended).toBeUndefined()
    expect(notices).toEqual([
      ...[1, 2, 3, 4, 5].map(
        (number) =>
          `in flight on github.com/acme/iac, touching component:default/billing-api: pull request #${String(number)} by grace ` +
          `(idp-agent/change-${String(number).padStart(8, '0')}), changing components/billing-api.yml`,
      ),
      '… and 1 more',
      'this run drafts the change, then compares it with them before anything is written',
    ])
  })
})
