import fc from 'fast-check'
import { afterAll, describe, expect, it } from 'vitest'
import { CLOSING } from '../../src/cli/render/footer.js'
import {
  ENGINE_BLOCK_END,
  fenceFor,
  pullRequestBody,
  pullRequestUrl,
  type PullRequestInput,
} from '../../src/core/github/pull-request.js'
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
      init: "written by idpa init in the service's own repository, from what a person typed",
    }
    for (const [road, words] of Object.entries(said) as [PullRequestInput['road'], string][]) {
      expect(pullRequestBody(input(change, change.request, road)).body, road).toContain(words)
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

  it('refuses a message messageFor did not write', async () => {
    const change = await real()
    expect(() => pullRequestBody({ ...input(change), message: 'idp-agent: something\n\nno request here\n' })).toThrow()
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
