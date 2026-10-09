import fc from 'fast-check'
import { afterAll, describe, expect, it } from 'vitest'
import { CLOSING } from '../../src/cli/render/footer.js'
import {
  ENGINE_BLOCK_END,
  LONGEST_BESIDE,
  besideParagraph,
  coverageMarkdown,
  fenceFor,
  pullRequestBody,
  pullRequestUrl,
  type PullRequestInput,
} from '../../src/core/github/pull-request.js'
import { coverageOf, coverageSentence } from '../../src/core/discovery/report.js'
import { MERGE_NOTE, unguardedNote } from '../../src/core/github/protection.js'
import type { Cleared } from '../../src/core/plan/clear.js'
import { clearedFor, clone, removeClones } from '../support/forge-fixture.js'

/**
 * The text of the one pull request (stage 6 brief § 12): the engine's, from
 * the commit `messageFor` wrote, the request inside a fence no line of it can
 * close — so a request cannot notify anyone, link anything, render or hide a
 * line — then the engine's block, ending on the marker stage 8 appends after.
 * And its URL, built from what the remote parsed, never GitHub's `html_url`.
 */

afterAll(removeClones)

let made: Cleared | undefined
/** One real clearance, over a committed clone: `messageFor`'s real output. */
const real = async (): Promise<Cleared> => {
  made ??= await clearedFor(await clone())
  return made
}

const input = (change: Cleared, request = change.request, road: PullRequestInput['road'] = 'from'): PullRequestInput => ({
  message: change.message,
  request,
  road,
  branch: change.branch,
})

/** The lines between the fence that opens and the one that closes, and every line outside them. */
const split = (body: string, fence: string): { inside: string[]; outside: string[] } => {
  const lines = body.split('\n')
  const open = lines.indexOf(fence)
  const close = lines.indexOf(fence, open + 1)
  if (open === -1 || close === -1) throw new Error('no fence')
  return { inside: lines.slice(open + 1, close), outside: [...lines.slice(0, open), ...lines.slice(close + 1)] }
}

describe('pullRequestBody', () => {
  it("titles the pull request with the commit's subject", async () => {
    const change = await real()
    expect(pullRequestBody(input(change)).title).toBe(change.message.split('\n')[0])
  })

  it('keeps the request inside a fence no line of it can close', async () => {
    const change = await real()
    for (const request of [
      'grant `read` to billing-api',
      'a ``` fence, then text',
      'a ```` longer fence',
      'ask @acme/platform to look',
      'see [link](https://example.com)',
      'an image ![x](https://example.com/x.png)',
      'a hidden <!-- comment --> line',
      'closes #123',
    ]) {
      const { body } = pullRequestBody(input(change, request))
      const fence = fenceFor(request)
      const longest = Math.max(0, ...[...request.matchAll(/`+/g)].map((run) => run[0].length))
      expect(fence, request).toBe('`'.repeat(Math.max(3, longest + 1)))
      const { inside, outside } = split(body, fence)
      expect(inside, request).toEqual([request])
      expect(outside.some((line) => line.includes(request)), request).toBe(false)
      for (const word of ['@acme/platform', '](https://example.com', '<!-- comment -->', '#123']) {
        if (request.includes(word)) expect(outside.some((line) => line.includes(word)), request).toBe(false)
      }
    }
  })

  it('keeps any request inside its fence, whatever it holds', async () => {
    const change = await real()
    const without = pullRequestBody(input(change, 'x')).body
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 80 }), (request) => {
        const { body } = pullRequestBody(input(change, request))
        const fence = fenceFor(request)
        expect(fence.length).toBeGreaterThanOrEqual(3)
        // No run of backticks in the request is as long as its fence.
        expect(request.includes(fence)).toBe(false)
        // The body is the same text around the fenced request, whatever the request.
        expect(body).toBe(without.replace(/\n```\nx\n```\n/, () => `\n${fence}\n${request}\n${fence}\n`))
      }),
    )
  })

  it("names the road in D4's words", async () => {
    const change = await real()
    const said: Record<PullRequestInput['road'], string> = {
      from: 'from a plan file: four gates, the schema, the signature, the policies and the re-check, and no Reviewer',
      intent: 'drafted by a model: five gates, the schema, the signature, the policies, the re-check and the Reviewer last',
      phrase: 'from a phrase idpa took for a change',
      // A model drafts init's catalog-info too: the Inspector reads the files and the
      // Architect proposes the Component. Only what the signature vouches for is
      // a person's, and that is what the words say.
      init:
        "drafted by a model from the service's own files and written by idpa init in its own repository: " +
        'five gates, the schema, the signature, the policies, the re-check and the Reviewer last, every ' +
        'value the model chose typed or answered by a person',
    }
    for (const [road, words] of Object.entries(said) as [PullRequestInput['road'], string][]) {
      const { body } = pullRequestBody(input(change, change.request, road))
      expect(body, road).toContain(words)
      // One sentence a person reads as English, whichever road.
      expect(body, road).toMatch(/^This change was (made|drafted) [^\n]+\.$/m)
      expect(body, road).not.toContain('from what a person typed')
    }
    expect(pullRequestBody(input(change, change.request, 'phrase')).body).toContain(
      'five gates, the Reviewer last',
    )
  })

  it('ends on the marker stage 8 appends after', async () => {
    const change = await real()
    const { body } = pullRequestBody(input(change))
    const lines = body.split('\n')
    expect(lines.at(-1)).toBe(ENGINE_BLOCK_END)
    const block = lines.slice(lines.lastIndexOf('---'))
    expect(block.join('\n')).toContain(`\`${change.branch}\``)
    expect(block.join('\n')).toContain('the same change always names the same branch')
    expect(block).toContain(CLOSING)
    // The files and the request's label, as the commit wrote them.
    expect(body).toContain('Submitted by idp-agent for review. Nothing is provisioned until this is merged.')
    for (const edit of change.edits) expect(body).toContain(`  + \`${edit.path}\``)
    expect(body).toContain('Requested, as recorded with the plan (no gate reads it):')
  })

  it('writes each file as code, so a file name cannot mention, link or render', async () => {
    const change = await real()
    const [edit] = change.edits
    if (edit === undefined) throw new Error('no edit')
    const paths: readonly (readonly [string, string])[] = [
      ['catalog/components/@acme #123 [x](https://example.com).yaml', '`catalog/components/@acme #123 [x](https://example.com).yaml`'],
      ['catalog/components/a`b.yaml', '``catalog/components/a`b.yaml``'],
      // A backtick at an end: padded with a space, which the code span drops.
      ['``a.yaml', '``` ``a.yaml ```'],
    ]
    for (const [path, written] of paths) {
      const message = change.message.replace(`  + ${edit.path}\n`, `  + ${path}\n  ~ ${path}\n`)
      const lines = pullRequestBody({ ...input(change), message }).body.split('\n')
      expect(lines, path).toContain(`  + ${written}`)
      expect(lines, path).toContain(`  ~ ${written}`)
      expect(lines, path).not.toContain(`  + ${path}`)
    }
  })

  it('writes no note line when none is asked: the engine’s block of every road as it was', async () => {
    const change = await real()
    for (const road of ['from', 'intent', 'phrase', 'init'] as const) {
      const lines = pullRequestBody(input(change, change.request, road)).body.split('\n')
      const block = lines.slice(lines.lastIndexOf('---'))
      expect(block, road).toEqual([
        '---',
        '',
        expect.stringMatching(/^This change was (made|drafted) [^\n]+\.$/),
        '',
        `The branch \`${change.branch}\` is named by a digest of its files' paths and bytes: the same change always ` +
          'names the same branch, and any other change another.',
        '',
        CLOSING,
        '',
        ENGINE_BLOCK_END,
      ])
      expect(lines.some((line) => line.startsWith('note:')), road).toBe(false)
    }
  })

  it('puts the note in the engine’s block, one paragraph, after how the change was made and before the provisioning sentence', async () => {
    const change = await real()
    for (const road of ['from', 'intent', 'phrase', 'init'] as const) {
      const without = pullRequestBody(input(change, change.request, road)).body
      for (const [note, line] of [
        [{ kind: 'author-may-merge', base: 'main', missing: ['pull-request', 'last-push'] }, MERGE_NOTE],
        [
          { kind: 'base-unguarded', base: 'main', missing: ['non-fast-forward', 'bypassable'] },
          unguardedNote('main', ['non-fast-forward'], 'markdown'),
        ],
      ] as const) {
        const { body } = pullRequestBody({ ...input(change, change.request, road), note })
        const lines = body.split('\n')
        const made = lines.findIndex((one) => one.startsWith('This change was '))
        expect(lines.slice(made + 1, made + 4), `${road} ${note.kind}`).toEqual(['', line, ''])
        expect(lines.indexOf(CLOSING), `${road} ${note.kind}`).toBeGreaterThan(made + 2)
        // Nothing else moves: the same body, the note's paragraph taken out.
        expect(body.replace(`\n${line}\n`, ''), `${road} ${note.kind}`).toBe(without)
      }
    }
  })

  it('writes a base outside the branch grammar as "the base" in the note', async () => {
    const change = await real()
    const { body } = pullRequestBody({
      ...input(change),
      note: { kind: 'base-unguarded', base: 'main\u202e', missing: ['deletion'] },
    })
    expect(body).toContain('note: on this repository no rule on the base that binds the author restricts deletions')
    expect(body).not.toContain('\u202e')
  })

  it('writes the base as code in the note, so a branch name cannot mention, link, reference or render', async () => {
    const change = await real()
    // Each holds to the branch grammar, and each would mean something to GitHub as prose.
    for (const base of ['@acme/security', 'fix#12', 'x<details>', 'a<!--b', 'GH-12', 'www.example.com/x', 'a5c3785', '_main_']) {
      const { body } = pullRequestBody({ ...input(change), note: { kind: 'base-unguarded', base, missing: ['deletion'] } })
      const line = body.split('\n').find((one) => one.startsWith('note:'))
      expect(line, base).toBe(`note: on this repository no rule on \`${base}\` that binds the author restricts deletions`)
      // Outside its code span, the base is nowhere in the body.
      expect(body.replaceAll(`\`${base}\``, '').includes(base), base).toBe(false)
    }
  })

  it('names pull requests in flight beside it by number and base only, one paragraph before the branch’s, with no # and no URL', async () => {
    const change = await real()
    for (const road of ['from', 'intent', 'phrase', 'init'] as const) {
      const without = pullRequestBody(input(change, change.request, road)).body
      for (const [numbers, said] of [
        [[3], 'Opened beside pull request 3, open into `main`, which change other files of the same entities.'],
        [[3, 12], 'Opened beside pull request 3 and pull request 12, open into `main`, which change other files of the same entities.'],
        [
          [3, 12, 40],
          'Opened beside pull request 3, pull request 12 and pull request 40, open into `main`, which change other files of the same entities.',
        ],
      ] as const) {
        const { body } = pullRequestBody({ ...input(change, change.request, road), beside: { numbers, base: 'main' } })
        const lines = body.split('\n')
        const branch = lines.findIndex((one) => one.startsWith('The branch '))
        expect(lines.slice(branch - 2, branch), `${road} ${said}`).toEqual([said, ''])
        expect(lines.indexOf(ENGINE_BLOCK_END)).toBeGreaterThan(branch)
        // Nothing GitHub would turn into a cross-reference on another pull request's timeline.
        expect(body.replace(change.request, ''), said).not.toMatch(/#\d/)
        expect(body, said).not.toMatch(/\/pull\/\d/)
        // Nothing else moves: the same body, the paragraph taken out.
        expect(body.replace(`\n${said}\n`, '')).toBe(without)
      }
    }
    // With a note too: the note first, then the paragraph.
    const both = pullRequestBody({
      ...input(change),
      note: { kind: 'author-may-merge', base: 'main', missing: ['pull-request'] },
      beside: { numbers: [3], base: 'main' },
    }).body.split('\n')
    expect(both.indexOf(MERGE_NOTE)).toBeLessThan(both.findIndex((one) => one.startsWith('Opened beside')))
    // A base outside the branch grammar, or holding a backtick, is "the base".
    expect(besideParagraph([3], 'main\u202e')).toBe('Opened beside pull request 3, open into the base, which change other files of the same entities.')
    expect(besideParagraph([3], 'a`b')).toContain('open into the base,')
  })

  it('bounds the longest paragraph a body can carry: twenty numbers of the largest size, a 255-byte base', () => {
    const numbers = Array.from({ length: 20 }, () => Number.MAX_SAFE_INTEGER)
    expect(LONGEST_BESIDE).toBe(besideParagraph(numbers, 'a'.repeat(255)))
    for (const one of [[1], Array.from({ length: 20 }, (_, at) => at + 1)]) {
      expect(Buffer.byteLength(besideParagraph(one, 'main'))).toBeLessThan(Buffer.byteLength(LONGEST_BESIDE))
    }
  })

  it('refuses a message messageFor did not write', async () => {
    const change = await real()
    expect(() => pullRequestBody({ ...input(change), message: 'idp-agent: something\n\nno request here\n' })).toThrow()
  })

  it('writes the same body as before when there is no report', async () => {
    // Stage 8's report goes after the engine's block, and only when there is
    // one: a body without it ends on the marker, byte for byte as it did.
    const change = await real()
    const before = pullRequestBody(input(change))
    expect(pullRequestBody({ ...input(change), coverage: undefined } as unknown as PullRequestInput)).toEqual(before)
    expect(before.body.split('\n').at(-1)).toBe(ENGINE_BLOCK_END)
  })

  it('puts the report after the engine’s block, and nothing of it before', async () => {
    const change = await real()
    const coverage = coverageOf(
      {
        selection: 'git',
        head: 'c0ffee1'.padEnd(40, '0'),
        opened: [],
        notAnalysed: [{ path: 'README.md', why: 'no-rule' }],
        byDesign: [{ path: 'deploy/prod.env', why: 'environment-file' }],
        untracked: 2,
        staged: 0,
        unlisted: 0,
        unnameable: 0,
        truncated: false,
      },
      new Map(),
      [],
    )
    const { body } = pullRequestBody({ ...input(change, change.request, 'init'), coverage })
    const lines = body.split('\n')
    const end = lines.indexOf(ENGINE_BLOCK_END)
    expect(end).toBeGreaterThan(-1)
    expect(lines.slice(0, end + 1).join('\n')).toBe(pullRequestBody(input(change, change.request, 'init')).body)
    const after = lines.slice(end + 1)
    expect(after).toEqual(['', ...coverageMarkdown(coverage)])
    expect(after.join('\n')).toContain('`c0ffee1`')
    expect(after.join('\n')).toContain('`README.md`')
    expect(after.at(-1)).toBe(coverageSentence(coverage))
    expect(after.join('\n')).not.toContain('/blob/')
  })
})

describe('pullRequestUrl', () => {
  it('builds the URL from what was parsed, never from GitHub', () => {
    expect(pullRequestUrl({ host: 'github.com', owner: 'acme', name: 'iac' }, 42)).toBe('https://github.com/acme/iac/pull/42')
    for (const number of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
      expect(() => pullRequestUrl({ host: 'github.com', owner: 'acme', name: 'iac' }, number), String(number)).toThrow()
    }
  })
})
