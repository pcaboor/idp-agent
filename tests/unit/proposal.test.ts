import { PassThrough } from 'node:stream'
import { afterAll, describe, expect, it } from 'vitest'
import { confirmOnTerminal, discardTypedAhead, InterruptedError, proposeOf, type Terminals } from '../../src/cli/index.js'
import {
  openToPropose,
  unproposedLine,
  type Proposal,
  type SubmissionSummary,
  type Unproposed,
} from '../../src/cli/commands/submit.js'
import { readRepository, readRepositoryText } from '../../src/context/iac-fs/snapshot.js'
import { MERGE_NOTE } from '../../src/core/github/protection.js'
import type { LocalRoad } from '../../src/forge/provider.js'
import type { GhProcess } from '../../src/process/gh.js'
import type { FakeGitHub } from '../support/fake-gh.js'
import { clone, removeClones } from '../support/forge-fixture.js'
import { observable } from '../support/git.js'
import { githubClone, moveGitHubBase, remoteRefs, unprotect, type GitHubClone } from '../support/github-fixture.js'

/**
 * The proposal (the owner's decision of 2026-10-01): at a terminal, a change
 * previewed without `--submit` ends on `--submit`'s own question, put by the
 * engine after the last model call — or on one line saying why no pull
 * request is proposed. These are its parts on their own: the line, the reads
 * before the question over a clone on github.com, and who is at the keyboard.
 * The roads through `main` are `plan-intent.test.ts`'s and `entry.test.ts`'s.
 */

const PUSHING = 30_000

/** `ada`, the fixture's administrator, and an account GitHub calls a bot. */
const ACCOUNTS = [
  { login: 'ada', type: 'User' },
  { login: 'ci-bot', type: 'Bot' },
] as const

/** gh's account can no longer push to the repository: § 8 item 1. */
const readOnly = (gh: FakeGitHub): void => {
  gh.state.repositories = gh.state.repositories.map((one) => ({
    ...one,
    permissions: { ...one.permissions, ada: { admin: false, maintain: false, push: false } },
  }))
}

/** The bytes of every file the repository holds, as `runIntent` reads them for the divergence check. */
const contentsOf = async (repo: string): Promise<ReadonlyMap<string, string>> => {
  const snapshot = await readRepository(repo)
  return new Map(
    await Promise.all(snapshot.files.map(async (file) => [file.path, await readRepositoryText(repo, file.path)] as const)),
  )
}

/** What `main` hands the intent road at a terminal, over the fixture's clone; every notice kept. */
const proposal = (clone: GitHubClone, said: string[] = [], gh: GhProcess = clone.gh.process): Proposal => ({
  confirm: async () => false,
  route: 'intent',
  env: clone.env,
  gh,
  notice: (line) => void said.push(line),
})

describe('unproposedLine', () => {
  it.each([
    [{ kind: 'local', why: 'no-upstream', branch: 'main' }, 'no pull request proposed — main tracks no remote; --submit cuts the branch in this clone'],
    [
      { kind: 'local', why: 'other-host', host: 'gitlab.example.com' },
      'no pull request proposed — the remote is on gitlab.example.com, where this build opens no pull request; ' +
        '--submit cuts the branch in this clone',
    ],
  ] as const)('says why a local road proposes nothing: %j', (road, line) => {
    expect(unproposedLine({ why: 'local-road', road })).toBe(line)
  })

  it('throws on --local, which never reaches a proposal: it is refused without --submit', () => {
    const asked: LocalRoad = { kind: 'local', why: 'asked' }
    expect(() => unproposedLine({ why: 'local-road', road: asked })).toThrow()
  })

  it('says a refusal on one line, every control and bidi character spelled out', () => {
    const line = unproposedLine({ why: 'refused', line: 'main\u202e tracks \u001b[31mgithub.com/acme/iac\nand more' })
    expect(line.startsWith('no pull request proposed — ')).toBe(true)
    expect(line).not.toMatch(/[\u001b\u202e\n]/)
    expect(line).toContain('\\u202e')
  })

  it('spells out a local road’s branch and host too', () => {
    const line = unproposedLine({ why: 'local-road', road: { kind: 'local', why: 'no-upstream', branch: 'ma\u202ein' } })
    expect(line).not.toContain('\u202e')
  })
})

describe('openToPropose', { timeout: PUSHING }, () => {
  afterAll(removeClones)

  it.each([
    ['gh is logged out', (clone: GitHubClone) => clone.gh.logout(), 'gh is not logged in to github.com'],
    ['gh is not a person', (clone: GitHubClone) => clone.gh.as('ci-bot'), 'not a person'],
    ['gh cannot push', (clone: GitHubClone) => readOnly(clone.gh), 'cannot push'],
    ['the base is not level', (clone: GitHubClone) => moveGitHubBase(clone), 'bring them level'],
  ] as const)('answers why nothing is proposed when %s, and writes nothing on either side', async (_, make, reason) => {
    const clone = await githubClone({ model: { accounts: [...ACCOUNTS] } })
    await make(clone)
    const before = { here: await observable(clone.repo), there: await remoteRefs(clone.bare) }
    const said: string[] = []

    const opened = await openToPropose({ root: clone.repo, proposal: proposal(clone, said), contents: await contentsOf(clone.repo) })

    expect('why' in opened && opened.why).toBe('refused')
    // Nothing is submitted, so nothing was said to be: not even past gh's identity.
    expect(said).toEqual([])
    const line = unproposedLine(opened as Unproposed)
    expect(line).toContain(reason)
    expect(line).not.toContain('Nothing was written.')
    expect(line).not.toContain('not submitted — ')
    expect(line.split('\n')).toHaveLength(1)
    // `--local` alone is refused without `--submit` (exit 2): never offered here.
    expect(line).not.toMatch(/add --local/)
    expect(await observable(clone.repo)).toBe(before.here)
    expect(await remoteRefs(clone.bare)).toEqual(before.there)
    expect(clone.gh.state.pulls ?? []).toEqual([])
  })

  it('offers --submit --local where --submit would offer --local, which a run without --submit refuses', async () => {
    const loggedOut = await githubClone()
    loggedOut.gh.logout()
    const bot = await githubClone({ model: { accounts: [...ACCOUNTS] } })
    bot.gh.as('ci-bot')

    const lines: string[] = []
    for (const clone of [loggedOut, bot]) {
      const opened = await openToPropose({ root: clone.repo, proposal: proposal(clone), contents: await contentsOf(clone.repo) })
      lines.push(unproposedLine(opened as Unproposed))
    }
    for (const line of lines) {
      expect(line).toContain('add --submit --local to cut the branch in this clone only')
      expect(line).not.toMatch(/add --local/)
    }
    expect(lines[0]).toBe(
      'no pull request proposed — main tracks github.com/acme/iac, and gh is not logged in to github.com, so idpa cannot ' +
        'read the rules that keep a pull request from merging unreviewed. Run `gh auth login --hostname github.com`, ' +
        'then run this again; or add --submit --local to cut the branch in this clone only.',
    )
  })

  it('joins § 8 item 1’s missing lines to its heading, and names no login', async () => {
    const clone = await githubClone()
    readOnly(clone.gh)

    const opened = await openToPropose({ root: clone.repo, proposal: proposal(clone), contents: await contentsOf(clone.repo) })

    const line = unproposedLine(opened as Unproposed)
    expect(line).toMatch(/^no pull request proposed — github\.com\/acme\/iac cannot take a pull request from this run: missing: /)
    expect(line).not.toContain('ada')
    expect(line).not.toContain('Then run this again')
  })

  it('answers the local road for a clone that tracks no remote, and starts no gh', async () => {
    const repo = await clone()
    let started = 0
    const gh: GhProcess = async () => {
      started += 1
      throw new Error('no gh on a local road')
    }

    const opened = await openToPropose({
      root: repo,
      proposal: { confirm: async () => false, route: 'intent', env: process.env, gh },
      contents: await contentsOf(repo),
    })

    expect(opened).toStrictEqual({ why: 'local-road', road: { kind: 'local', why: 'no-upstream', branch: 'main' } })
    expect(started).toBe(0)
  })

  it('opens the forge, and holds the submitting line and 6.3.4’s note for the question, where it can propose', async () => {
    const clone = await githubClone()
    unprotect(clone.gh)
    const said: string[] = []

    const opened = await openToPropose({ root: clone.repo, proposal: proposal(clone, said), contents: await contentsOf(clone.repo) })

    if ('why' in opened) throw new Error(`nothing proposed: ${unproposedLine(opened)}`)
    // Said by `submit` just before the question, and never on a run that ends without one.
    expect(said).toEqual([])
    expect(opened.held).toEqual([
      "submitting to github.com/acme/iac, into main (origin, main's upstream), as ada (gh)",
      MERGE_NOTE,
    ])
    expect(clone.gh.state.pulls ?? []).toEqual([])
  })

  it('answers a repository whose working tree is not HEAD as why nothing is proposed', async () => {
    const clone = await githubClone()
    const contents = new Map(await contentsOf(clone.repo))
    contents.set('catalog/databases/stray.yml', '# stray\n')

    const opened = await openToPropose({ root: clone.repo, proposal: proposal(clone), contents })

    expect(unproposedLine(opened as Unproposed)).toContain('the repository is not what main@')
  })

  it('throws what is not a refusal', async () => {
    const clone = await githubClone()
    const broken: GhProcess = async () => {
      throw new TypeError('a programming error')
    }

    await expect(
      openToPropose({ root: clone.repo, proposal: proposal(clone, [], broken), contents: await contentsOf(clone.repo) }),
    ).rejects.toThrow('a programming error')
  })
})

describe('proposeOf', () => {
  const tty = { isTTY: true }
  const pipe = { isTTY: false }
  const all: Terminals = { stdin: tty, stdout: tty, stderr: tty }

  it.each([
    ['stdin is not a terminal', { stdin: pipe, stdout: tty, stderr: tty }],
    ['stdout is not a terminal (the diff is piped or redirected)', { stdin: tty, stdout: pipe, stderr: tty }],
    ['stderr is not a terminal (the question would go elsewhere)', { stdin: tty, stdout: tty, stderr: pipe }],
  ] as const)('asks nobody when %s', (_, terminals) => {
    expect(proposeOf({}, false, terminals)).toBeUndefined()
  })

  it('asks the person when all three are terminals, and never with --json', () => {
    expect(proposeOf({}, false, all)).toBeTypeOf('function')
    expect(proposeOf({}, true, all)).toBeUndefined()
  })

  it('asks nobody when a test injects a stream, and the injected answer when one is given', () => {
    const propose = async (): Promise<boolean> => true
    expect(proposeOf({ out: () => {} }, false, all)).toBeUndefined()
    expect(proposeOf({ err: () => {} }, false, all)).toBeUndefined()
    expect(proposeOf({ propose, out: () => {} }, false, all)).toBe(propose)
    expect(proposeOf({ propose }, true, all)).toBeUndefined()
  })

  it('is never --submit’s confirmation: an injected confirm proposes nothing', () => {
    expect(proposeOf({ confirm: async () => true, out: () => {} }, false, all)).toBeUndefined()
  })
})

describe('confirmOnTerminal with discard', () => {
  /** A terminal: readline reads keys, and Ctrl-C, only when its output is one. */
  const terminal = () => {
    const output = new PassThrough() as PassThrough & { isTTY?: boolean }
    output.isTTY = true
    const shown: Buffer[] = []
    output.on('data', (chunk: Buffer) => shown.push(chunk))
    const diff = new PassThrough()
    diff.resume()
    return { input: new PassThrough(), output, diff, shown: () => Buffer.concat(shown).toString('utf8') }
  }

  const SUMMARY: SubmissionSummary = {
    root: '/work/iac',
    repository: 'declarations',
    branch: 'idp-agent/orders-db-prod-3f9c2a1b',
    base: { branch: 'main', commit: 'abc1234def' },
    files: [{ path: 'catalog/databases/orders-db-prod.yml', change: 'create' }],
    preview: '+++ b/catalog/databases/orders-db-prod.yml\n1 file · not yet submitted — it would become idp-agent/orders-db-prod-3f9c2a1b',
    github: { host: 'github.com', repository: 'acme/iac', base: 'main', pushedAlready: false, authorMayMergeAlone: false },
  }

  /** Resolves once the terminal shows the question. */
  const questionWritten = async (shown: () => string): Promise<void> => {
    for (let waited = 0; waited < 5_000; waited += 5) {
      if (shown().includes('[y/N]')) return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error('the question was never written')
  }

  it('discards a y typed before the question, and reads the answer typed after it', async () => {
    const { input, output, diff, shown } = terminal()
    input.write('y\n')
    const asked = confirmOnTerminal(input, output, diff, { discard: true })(SUMMARY)
    await questionWritten(shown)
    input.write('n\n')
    expect(await asked).toBe(false)
  })

  it('discards a line typed but not ended, too', async () => {
    const { input, output, diff, shown } = terminal()
    input.write('y')
    const asked = confirmOnTerminal(input, output, diff, { discard: true })(SUMMARY)
    await questionWritten(shown)
    input.write('\n')
    expect(await asked).toBe(false)
  })

  it('declines when the input closes during the discard with only a typed-ahead y in it (a closed pipe; on a terminal a Ctrl-D typed ahead is discarded)', async () => {
    const { input, output, diff } = terminal()
    input.end('y\n')
    expect(await confirmOnTerminal(input, output, diff, { discard: true })(SUMMARY)).toBe(false)
  })

  it('stops the run on a Ctrl-C typed ahead, exit 130', async () => {
    const { input, output, diff, shown } = terminal()
    input.write('\u0003')
    await expect(confirmOnTerminal(input, output, diff, { discard: true })(SUMMARY)).rejects.toBeInstanceOf(InterruptedError)
    expect(shown()).not.toContain('[y/N]')
  })

  it('still submits on a y typed after the question', async () => {
    const { input, output, diff, shown } = terminal()
    const asked = confirmOnTerminal(input, output, diff, { discard: true })(SUMMARY)
    await questionWritten(shown)
    input.write('y\n')
    expect(await asked).toBe(true)
  })

  it('writes the diff before it discards, and asks --submit’s question byte for byte', async () => {
    const plain = terminal()
    const without = confirmOnTerminal(plain.input, plain.output, plain.diff)(SUMMARY)
    plain.input.write('n\n')
    await without
    const discarding = terminal()
    const shownDiff: Buffer[] = []
    discarding.diff.on('data', (chunk: Buffer) => shownDiff.push(chunk))
    const withDiscard = confirmOnTerminal(discarding.input, discarding.output, discarding.diff, { discard: true })(SUMMARY)
    await questionWritten(discarding.shown)
    expect(Buffer.concat(shownDiff).toString('utf8')).toBe(`${SUMMARY.preview}\n`)
    discarding.input.write('n\n')
    await withDiscard
    expect(discarding.shown()).toBe(plain.shown())
  })
})

describe('discardTypedAhead', () => {
  it('returns once the input is quiet, having read what was typed', async () => {
    const input = new PassThrough()
    input.write('y\n')
    await discardTypedAhead(input)
    expect(input.read()).toBeNull()
  })

  it('returns within its bound while someone keeps typing', async () => {
    const input = new PassThrough()
    const typing = setInterval(() => input.write('y'), 10)
    const started = Date.now()
    try {
      await discardTypedAhead(input)
    } finally {
      clearInterval(typing)
    }
    expect(Date.now() - started).toBeLessThan(1_500)
  })

  it('throws InterruptedError on a Ctrl-C among what was typed', async () => {
    const input = new PassThrough()
    input.write('ab\u0003cd')
    await expect(discardTypedAhead(input)).rejects.toBeInstanceOf(InterruptedError)
  })

  it('puts a terminal in raw mode while it reads, and back as it was', async () => {
    const modes: boolean[] = []
    const input = new PassThrough() as PassThrough & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (on: boolean) => void }
    input.isTTY = true
    input.isRaw = false
    input.setRawMode = (on) => {
      modes.push(on)
      input.isRaw = on
    }
    await discardTypedAhead(input)
    expect(modes).toEqual([true, false])
  })
})
