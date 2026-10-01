import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { main, type MainDeps } from '../../src/cli/index.js'
import { renderProtection, renderUnprotected } from '../../src/cli/render/protection.js'
import { configRefusal } from '../../src/core/github/config.js'
import { judgeProtection, protectionText, type ProtectionVerdict } from '../../src/core/github/protection.js'
import { repositoryAnswer, rulesAnswer, rulesetAnswer } from '../../src/core/github/answers.js'
import type { GhIdentity, GitHubRoad } from '../../src/forge/provider.js'
import type { LlmClient } from '../../src/llm/client.js'
import type { FakeModel } from '../support/fake-gh.js'
import { clone as scaffolded, removeClones, scratch } from '../support/forge-fixture.js'
import { fakeGitHub, protectedMain, protectingRuleset, repository, type FakeGitHub } from '../support/fake-gh.js'
import { committed, git, observable, stored } from '../support/git.js'

/**
 * `idpa protection` (stage 6 brief § 8): through `main`, as a person types
 * it, over clones whose upstream is `origin` on `git@github.com:acme/iac.git`
 * — set with `git config`, nothing fetched — and the fake gh handed in as
 * `MainDeps.gh`. It reads, and only reads: no model is configured and the
 * client throws if called; the clone is the same, ref for ref and object for
 * object, after every case.
 */

afterAll(removeClones)

const GITHUB = 'git@github.com:acme/iac.git'

/** A model this command must never reach. */
const untouchable: LlmClient = {
  generate: () => {
    throw new Error('idpa protection called a model')
  },
}

/**
 * A committed clone — a declarations repository when `markers`, as init
 * platform leaves one — whose `main` tracks `remote`'s `main`, or nothing when
 * `remote` is null.
 */
const tracking = async (
  remote: string | null = GITHUB,
  options: { markers?: boolean } = {},
): Promise<{ repo: string; home: string }> => {
  let repo: string
  if (options.markers === true) {
    repo = await scaffolded()
  } else {
    repo = path.join(await scratch('idp-protection-'), 'iac')
    await mkdir(repo)
    await committed(repo)
  }
  if (remote !== null) {
    await git(repo, 'remote', 'add', 'origin', remote)
    await git(repo, 'config', 'branch.main.remote', 'origin')
    await git(repo, 'config', 'branch.main.merge', 'refs/heads/main')
  }
  const home = path.join(path.dirname(repo), 'home')
  await mkdir(home, { recursive: true })
  return { repo, home }
}

interface Ran {
  readonly code: number
  readonly out: string
  readonly err: string
}

/** `idpa <argv>` over `fake`, from `cwd`, with an environment of the run's own and nothing configured. */
const run = async (
  argv: string[],
  fake: FakeGitHub,
  where: { cwd: string; home: string },
  extra: Partial<MainDeps> = {},
): Promise<Ran> => {
  let out = ''
  let err = ''
  const code = await main(argv, {
    cwd: where.cwd,
    env: { PATH: process.env['PATH'], HOME: where.home, XDG_CONFIG_HOME: path.join(where.home, '.config') },
    gh: fake.process,
    client: untouchable,
    out: (chunk) => {
      out += chunk
    },
    err: (chunk) => {
      err += chunk
    },
    ...extra,
  })
  return { code, out, err }
}

/** `idpa protection --repo <repo>`, with the clone checked to be the same before and after. */
const check = async (
  fake: FakeGitHub,
  remote: string | null = GITHUB,
  prepare?: (repo: string) => Promise<void>,
): Promise<Ran> => {
  const clone = await tracking(remote)
  if (prepare !== undefined) await prepare(clone.repo)
  const before = [await observable(clone.repo), await stored(clone.repo)]
  const ran = await run(['protection', '--repo', clone.repo], fake, { cwd: clone.home, home: clone.home })
  expect([await observable(clone.repo), await stored(clone.repo)]).toEqual(before)
  return ran
}

const CHECKING = "checking github.com/acme/iac's main (origin, main's upstream), as ada (gh)\n"

const HOLDING = [
  "github.com/acme/iac's main keeps a pull request from merging until someone other than its opener approves its latest commit, as gh reads it for ada:",
  '  a pull request before merging, 1 approval (ruleset 1)',
  '  approval of the most recent push (ruleset 1)',
  '  force pushes blocked, deletions restricted (ruleset 1)',
  '  ada (gh, admin) cannot bypass ruleset 1 (current_user_can_bypass: never)',
  '  bypass list: empty',
  'Reported, not required:',
  '  review from Code Owners: not required',
  '  status checks: none required, so a system downstream could not refuse a merge (ADR-0012)',
  '  signed commits: not required',
  '  merge queue: none',
  'What no read can see:',
  "  an administrator can edit or disable the ruleset outside idpa, and then merge; GitHub records it in the ruleset's history",
  "  the credential your git pushes with: a deploy key or another account's key in the bypass list could move main without a pull request; push as ada (docs/submitting.md)",
  '  whether GitHub Actions or an app may approve pull requests here (Settings → Actions → General → Workflow permissions)',
  'Also advised: a ruleset on refs/heads/idp-agent/** blocking force pushes and deletions, so a branch under review is never rewritten.',
]

const UNPROTECTED = [
  "github.com/acme/iac's main does not stop the person who would open a pull request from merging it:",
  '  missing: a pull request rule requiring 1 approval',
  '  missing: approval of the most recent push',
  '  missing: block force pushes',
  '  missing: restrict deletions',
  'Add a ruleset on main (Settings → Rules → Rulesets):',
  ...protectionText(),
  'Then run idpa protection again.',
]

const lines = (text: string[]): string => `${text.join('\n')}\n`

describe('idpa protection: the rules hold', () => {
  it('exits 0 and says why, for the repository’s administrator', async () => {
    const ran = await check(fakeGitHub({ repositories: [protectedMain()] }))
    expect(ran).toEqual({ code: 0, out: lines(HOLDING), err: CHECKING })
  })

  it('exits 0 for an account that can only push, and says the bypass list is not its to read', async () => {
    const ran = await check(
      fakeGitHub({ repositories: [protectedMain({ permissions: { ada: { admin: false, maintain: false, push: true } } })] }),
    )
    expect(ran.code).toBe(0)
    expect(ran.err).toBe(CHECKING)
    const shown = ran.out.split('\n')
    expect(shown[4]).toBe('  ada (gh, write) cannot bypass ruleset 1 (current_user_can_bypass: never)')
    expect(shown[5]).toBe('  bypass list: not shown to ada, who cannot edit ruleset 1, so a deploy key there would go unseen')
  })
})

describe('idpa protection: the rules do not hold', () => {
  it('exits 1 with the ruleset to add, when there is none', async () => {
    const ran = await check(fakeGitHub({ repositories: [repository()] }))
    expect(ran).toEqual({ code: 1, out: lines(UNPROTECTED), err: CHECKING })
  })

  it('exits 1 on classic branch protection alone', async () => {
    const ran = await check(fakeGitHub({ repositories: [repository({ branches: { main: { protected: true } } })] }))
    expect(ran.code).toBe(1)
    expect(ran.out).toContain(
      '  missing: a ruleset: main is protected by classic branch protection only, which idpa does not read\n' +
        'Add a ruleset on main (Settings → Rules → Rulesets):\n',
    )
  })

  it('exits 1 on an archived repository, and offers no ruleset, which would not help', async () => {
    const ran = await check(fakeGitHub({ repositories: [protectedMain({ archived: true })] }))
    expect(ran.code).toBe(1)
    expect(ran.out).toBe(
      lines([
        "github.com/acme/iac's main does not stop the person who would open a pull request from merging it:",
        '  missing: a repository that is not archived: github.com/acme/iac is',
        'Then run idpa protection again.',
      ]),
    )
  })

  it('exits 1 with GitHub’s 404 said in this build’s words, and nothing on stdout', async () => {
    const ran = await check(fakeGitHub())
    expect(ran.code).toBe(1)
    expect(ran.out).toBe('')
    expect(ran.err).toBe(
      `${CHECKING}github.com answered 404 through gh on repository: acme/iac does not exist, or your account cannot ` +
        'see it; GitHub does not say which. Nothing was written.\n',
    )
  })
})

describe('idpa protection: gh refused, exit 2', () => {
  const TRACKS = 'main tracks github.com/acme/iac, and gh is '
  const CANNOT = 'so idpa cannot read the rules that keep a pull request from merging unreviewed.'

  it.each<[string, FakeModel, string]>([
    [
      'gh logged out',
      { session: undefined },
      `${TRACKS}not logged in to github.com, ${CANNOT} Run \`gh auth login --hostname github.com\`, then run this again. Nothing was written.`,
    ],
    [
      'gh not installed',
      { installed: false },
      `${TRACKS}not installed, ${CANNOT} Install it (https://cli.github.com) and run this again. Nothing was written.`,
    ],
    [
      'gh too old',
      { version: '2.39.2' },
      'gh 2.39.2 is older than 2.40.0, the oldest this build reads; update gh, then run this again. Nothing was written.',
    ],
    [
      'gh logged in as a Bot',
      { accounts: [{ login: 'robot', type: 'Bot' }], session: { login: 'robot' } },
      "gh is logged in to github.com as robot, which GitHub says is a Bot, not a person: the pull request's author " +
        'would be a bot, and whoever asked could approve it. Log gh in as yourself (gh auth login --hostname github.com). ' +
        'Nothing was written.',
    ],
  ])('%s: the sentence, with no offer of --local', async (_, model, sentence) => {
    const ran = await check(fakeGitHub({ ...model, repositories: [protectedMain()] }))
    expect(ran).toEqual({ code: 2, out: '', err: `${sentence}\n` })
  })
})

describe('idpa protection: the clone refused, exit 2, before gh starts', () => {
  const refused = async (ran: Ran, fake: FakeGitHub, err: string | RegExp): Promise<void> => {
    expect(ran.code).toBe(2)
    expect(ran.out).toBe('')
    if (typeof err === 'string') expect(ran.err).toBe(`${err}\n`)
    else expect(ran.err).toMatch(err)
    expect(fake.sent).toEqual([])
  }

  it('a branch that tracks no remote', async () => {
    const fake = fakeGitHub({ repositories: [protectedMain()] })
    await refused(
      await check(fake, null),
      fake,
      'main tracks no remote: idpa protection checks a branch on github.com, and there is none to check here. Nothing was read.',
    )
  })

  it('a remote on another host', async () => {
    const fake = fakeGitHub({ repositories: [protectedMain()] })
    await refused(
      await check(fake, 'git@gitlab.example.com:acme/iac.git'),
      fake,
      'the remote is on gitlab.example.com: idpa protection checks a branch on github.com, and this build reads no ' +
        'other host. Nothing was read.',
    )
  })

  it('a key of the clone’s own configuration that would decide the push', async () => {
    const fake = fakeGitHub({ repositories: [protectedMain()] })
    const ran = await check(fake, GITHUB, async (repo) => {
      await git(repo, 'config', 'credential.helper', 'store')
    })
    await refused(ran, fake, configRefusal({ scope: 'local', key: 'credential.helper' }, 0))
  })

  it('a detached HEAD', async () => {
    const fake = fakeGitHub({ repositories: [protectedMain()] })
    const ran = await check(fake, GITHUB, async (repo) => {
      await git(repo, 'checkout', '-q', '--detach')
    })
    await refused(ran, fake, 'HEAD is detached; check out the branch whose upstream idpa protection checks')
  })

  it('a directory that is not a clone, and a folder of one', async () => {
    const fake = fakeGitHub({ repositories: [protectedMain()] })
    const root = await scratch('idp-protection-')
    const plain = path.join(root, 'plain')
    await mkdir(plain)
    await refused(
      await run(['protection', '--repo', plain], fake, { cwd: root, home: root }),
      fake,
      `${plain} is not a git working tree; idpa protection needs a clone's root`,
    )

    const { repo, home } = await tracking()
    const folder = path.join(repo, 'catalog')
    await mkdir(folder)
    await refused(
      await run(['protection', '--repo', folder], fake, { cwd: home, home }),
      fake,
      `${folder} is the folder catalog/ of a git repository, not at its root; idpa protection needs a clone's root`,
    )
  })
})

describe('idpa protection: where the clone comes from', () => {
  it('reads the declarations repository it stands in, and says so', async () => {
    const { repo, home } = await tracking(GITHUB, { markers: true })
    const ran = await run(['protection'], fakeGitHub({ repositories: [protectedMain()] }), { cwd: repo, home })
    expect(ran.code).toBe(0)
    expect(ran.out).toBe(lines(HOLDING))
    expect(ran.err).toBe(
      "reading the declarations repository iac (the current directory); --repo <directory> checks another\n" + CHECKING,
    )
  })

  it('needs one, never the demo SI or a catalogue', async () => {
    const root = await scratch('idp-protection-')
    const fake = fakeGitHub({ repositories: [protectedMain()] })
    const ran = await run(['protection'], fake, { cwd: root, home: root })
    expect(ran.code).toBe(2)
    expect(ran.out).toBe('')
    expect(ran.err).toMatch(
      /^idpa protection needs a declarations repository: --repo <directory>, the current directory when it is one, or IDP_REPO or repo in .+config\.yml set once\n\nusage:\n {2}idp-agent protection \[--repo <directory>\]\n/,
    )
    expect(fake.sent).toEqual([])
  })
})

describe('idpa protection: its arguments', () => {
  it.each([['--demo'], ['--backstage'], ['--json'], ['--local'], ['somewhere']])('refuses %s, with the usage', async (word) => {
    const root = await scratch('idp-protection-')
    const fake = fakeGitHub({ repositories: [protectedMain()] })
    const ran = await run(['protection', word], fake, { cwd: root, home: root })
    expect(ran.code).toBe(2)
    expect(ran.out).toBe('')
    expect(ran.err).toContain('usage:\n  idp-agent protection [--repo <directory>]\n')
    if (word === 'somewhere') expect(ran.err).toMatch(/^protection takes no argument but --repo/)
    expect(fake.sent).toEqual([])
  })

  it('reads a slip of its name as one, as idpa grpah is', async () => {
    const root = await scratch('idp-protection-')
    const ran = await run(['protectoin'], fakeGitHub(), { cwd: root, home: root })
    expect(ran.code).toBe(2)
    expect(ran.err).toContain('unknown command "protectoin"; did you mean protection?')
  })

  it('is named in the general help among the commands refused with no repository found', async () => {
    const root = await scratch('idp-protection-')
    const ran = await run(['--help'], fakeGitHub(), { cwd: root, home: root })
    expect(ran.code).toBe(0)
    expect(ran.out.replace(/\s+/g, ' ')).toContain('as --demo does, and a change or idpa protection is refused.')
  })

  it('prints its usage for --help', async () => {
    const root = await scratch('idp-protection-')
    const ran = await run(['protection', '--help'], fakeGitHub(), { cwd: root, home: root })
    expect(ran).toMatchObject({ code: 0, err: '' })
    expect(ran.out).toMatch(/^usage:\n {2}idp-agent protection \[--repo <directory>\]\n/)
  })
})

describe('the blocks, rendered', () => {
  const ROAD: GitHubRoad = {
    kind: 'github',
    repository: { host: 'github.com', owner: 'acme', name: 'iac' },
    remote: 'origin',
    base: 'main',
    branch: 'main',
    pushUrl: GITHUB,
  }
  const ADA: GhIdentity = { login: 'ada', role: undefined }

  const verdict = (options: {
    rules?: readonly unknown[]
    actors?: readonly unknown[] | null
    bypass?: string
    fullName?: string
    push?: boolean
    /** More rulesets, as `GET rulesets/<id>` answers them, beside ruleset 1. */
    more?: readonly { id: number; current_user_can_bypass: string; bypass_actors?: readonly unknown[] }[]
  }): ProtectionVerdict =>
    judgeProtection({
      expected: ROAD.repository,
      repository: repositoryAnswer.parse({
        full_name: options.fullName ?? 'acme/iac',
        archived: false,
        permissions: { admin: true, maintain: false, push: options.push ?? true },
      }),
      rules: rulesAnswer.parse(
        options.rules ??
          protectingRuleset().rules.map((rule) => ({ ...rule, ruleset_id: 1 })),
      ),
      rulesets: new Map([
        [
          1,
          rulesetAnswer.parse({
            id: 1,
            current_user_can_bypass: options.bypass ?? 'never',
            ...(options.actors === null ? {} : { bypass_actors: options.actors ?? [] }),
          }),
        ],
        ...(options.more ?? []).map((answer) => [answer.id, rulesetAnswer.parse(answer)] as const),
      ]),
    })

  const PULL = (parameters: Record<string, unknown>) => ({ type: 'pull_request', ruleset_id: 1, parameters })

  it('says when only stale approvals are dismissed, and what that leaves open', () => {
    const text = renderProtection(
      verdict({
        rules: [
          PULL({ required_approving_review_count: 2, dismiss_stale_reviews_on_push: true }),
          { type: 'non_fast_forward', ruleset_id: 1 },
          { type: 'deletion', ruleset_id: 1 },
        ],
      }),
      ROAD,
      ADA,
    ).split('\n')
    expect(text[1]).toBe('  a pull request before merging, 2 approvals (ruleset 1)')
    expect(text[2]).toBe(
      '  stale approvals dismissed on a new push (ruleset 1); approval of the most recent push is not set, so the ' +
        'account your git pushes with could approve a pull request gh opened',
    )
  })

  it('counts the bypass list by type, and names the status checks, signatures, queue and Code Owners', () => {
    const text = renderProtection(
      verdict({
        rules: [
          PULL({ required_approving_review_count: 1, require_last_push_approval: true, require_code_owner_review: true }),
          { type: 'non_fast_forward', ruleset_id: 1 },
          { type: 'deletion', ruleset_id: 1 },
          { type: 'required_status_checks', ruleset_id: 3, parameters: { required_status_checks: [{ context: 'deploy/tufin' }, { context: 'ci' }] } },
          { type: 'required_signatures', ruleset_id: 3 },
          { type: 'merge_queue', ruleset_id: 3 },
        ],
        actors: [{ actor_type: 'Integration' }, { actor_type: 'Team' }],
      }),
      ROAD,
      ADA,
    )
    expect(text).toContain('\n  bypass list: 1 app and 1 team; none is you, as gh reads you\n')
    expect(text).toContain('\n  review from Code Owners: required\n')
    expect(text).toContain('\n  status checks: ci, deploy/tufin\n')
    expect(text).toContain('\n  signed commits: required\n')
    expect(text).toContain('\n  merge queue: required\n')
  })

  it('names only the rulesets that bind gh’s account, beside one it bypasses that repeats a rule', () => {
    const text = renderProtection(
      verdict({
        rules: [...protectingRuleset().rules.map((rule) => ({ ...rule, ruleset_id: 1 })), { type: 'deletion', ruleset_id: 2 }],
        more: [{ id: 2, current_user_can_bypass: 'always', bypass_actors: [{ actor_type: 'RepositoryRole' }] }],
      }),
      ROAD,
      ADA,
    ).split('\n')
    expect(text.slice(1, 6)).toEqual([
      '  a pull request before merging, 1 approval (ruleset 1)',
      '  approval of the most recent push (ruleset 1)',
      '  force pushes blocked, deletions restricted (ruleset 1)',
      '  ada (gh, admin) cannot bypass ruleset 1 (current_user_can_bypass: never)',
      '  bypass list: empty',
    ])
  })

  it('says whose bypass list it was not shown, and why, without blaming a role', () => {
    const hidden = renderProtection(verdict({ actors: null }), ROAD, ADA)
    expect(hidden).toContain(
      '\n  bypass list: not shown to ada, who cannot edit ruleset 1, so a deploy key there would go unseen\n',
    )
    const mixed = renderProtection(
      verdict({
        rules: [
          PULL({ required_approving_review_count: 1, require_last_push_approval: true }),
          { type: 'non_fast_forward', ruleset_id: 1 },
          { type: 'deletion', ruleset_id: 2 },
        ],
        actors: [{ actor_type: 'Team' }],
        more: [{ id: 2, current_user_can_bypass: 'never' }],
      }),
      ROAD,
      ADA,
    )
    expect(mixed).toContain(
      '\n  bypass list of ruleset 1: 1 team; none is you, as gh reads you' +
        '\n  bypass list of ruleset 2: not shown to ada, who cannot edit it, so a deploy key there would go unseen\n',
    )
  })

  it('refuses a deploy key it was shown, naming its ruleset, when another ruleset’s list is hidden', () => {
    const text = renderProtection(
      verdict({
        rules: [
          PULL({ required_approving_review_count: 1, require_last_push_approval: true }),
          { type: 'non_fast_forward', ruleset_id: 1 },
          { type: 'deletion', ruleset_id: 2 },
        ],
        actors: null,
        more: [{ id: 2, current_user_can_bypass: 'never', bypass_actors: [{ actor_type: 'DeployKey' }] }],
      }),
      ROAD,
      ADA,
    )
    expect(text.split('\n').slice(0, 2)).toEqual([
      "github.com/acme/iac's main does not stop the person who would open a pull request from merging it:",
      '  missing: no deploy key in the bypass list: ruleset 2 lets a deploy key bypass it, and a deploy key pushes ' +
        'with git, where gh cannot see it',
    ])
  })

  it('says every other missing rule in its own words', () => {
    const bypassable = renderProtection(verdict({ bypass: 'always' }), ROAD, ADA)
    expect(bypassable).toContain("\n  missing: rules ada cannot bypass: a ruleset that supplies them lets gh's account bypass it\n")
    const keyed = renderProtection(verdict({ actors: [{ actor_type: 'DeployKey' }] }), ROAD, ADA)
    expect(keyed).toContain(
      '\n  missing: no deploy key in the bypass list: ruleset 1 lets a deploy key bypass it, ' +
        'and a deploy key pushes with git, where gh cannot see it\n',
    )
    const none = renderProtection(
      verdict({
        rules: [
          PULL({ required_approving_review_count: 0, require_last_push_approval: true }),
          { type: 'non_fast_forward', ruleset_id: 1 },
          { type: 'deletion', ruleset_id: 1 },
        ],
      }),
      ROAD,
      ADA,
    )
    expect(none).toContain('\n  missing: at least 1 required approval (the pull request rule requires 0)\n')
    const renamed = renderProtection(verdict({ fullName: 'other/iac' }), ROAD, ADA)
    expect(renamed).toContain(
      "\n  missing: the remote's name: GitHub answers other/iac, so the repository was renamed or transferred; " +
        "update the remote's URL\n",
    )
    expect(renamed).not.toContain('Add a ruleset')
    expect(renderProtection(verdict({ push: false }), ROAD, ADA)).toContain('\n  missing: push access: ada cannot push to acme/iac\n')
  })

  it('renders the refusal a submission prints, over the same missing lines', () => {
    const unprotected = judgeProtection({
      expected: ROAD.repository,
      repository: repositoryAnswer.parse({ full_name: 'acme/iac', archived: false, permissions: { admin: false, push: true } }),
      rules: [],
      rulesets: new Map(),
      classic: false,
    })
    expect(renderUnprotected(unprotected, ROAD)).toBe(
      [
        "not submitted — nothing on github.com/acme/iac's main stops the person who would open this pull request from merging it:",
        ...UNPROTECTED.slice(1, -1),
        'Then run this again. Nothing was written.',
      ].join('\n'),
    )
  })

  it('names gh\'s account, never its login, in a submission\'s refusal: a traced run keeps it', () => {
    // `idpa protection` writes no trace and names the login; a submission's
    // refusal is the intent road's traced output (stage 6 brief § 12).
    const bypassable = renderUnprotected(verdict({ bypass: 'always' }), ROAD)
    expect(bypassable).toContain(
      "\n  missing: rules gh's account cannot bypass: a ruleset that supplies them lets gh's account bypass it\n",
    )
    const pushless = renderUnprotected(verdict({ push: false }), ROAD)
    expect(pushless).toContain("\n  missing: push access: gh's account cannot push to acme/iac\n")
    for (const text of [bypassable, pushless]) expect(text).not.toContain(ADA.login)
  })

  it('passes every value it prints through inertLine', () => {
    const text = renderProtection(
      verdict({
        rules: [
          ...protectingRuleset().rules.map((rule) => ({ ...rule, ruleset_id: 1 })),
          { type: 'required_status_checks', ruleset_id: 3, parameters: { required_status_checks: [{ context: 'ci\u001b[2J\u202Enext' }] } },
        ],
      }),
      ROAD,
      ADA,
    )
    expect(text).not.toMatch(/[\u001b\u202E]/)
  })
})
