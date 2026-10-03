import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { KEPT_KEYS, TOKEN_SHAPE, answersFiles, fakeWithin, identifying, scrubbed, shapeOf, unheld, type DoorEntry } from '../support/github-answers.js'

/**
 * What the owner's live run writes of GitHub's answers, and how the fake gh
 * is held to it (stage 6 plan, Task 6.4.1): a shape keeps the keys and the
 * types of an answer and the values of a few enumerations only — never a
 * login, a name, an email, an id or a token — and the fake is within GitHub
 * when it says nothing GitHub did not.
 */

describe('the shape of an answer', () => {
  it('keeps a value only under a KEPT_KEYS key, and a login, a name, an email or an id never', () => {
    const user = {
      login: 'ada',
      id: 1000,
      node_id: 'U_kgDOA',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      type: 'User',
      site_admin: false,
      permissions: { admin: true, maintain: false, push: true },
      private: false,
      visibility: 'public',
      parameters: { required_approving_review_count: 1, require_last_push_approval: true },
    }
    expect(shapeOf(user)).toEqual({
      login: '<string>',
      id: '<number>',
      node_id: '<string>',
      name: '<string>',
      email: '<string>',
      type: 'User',
      site_admin: '<boolean>',
      permissions: { admin: true, maintain: false, push: true },
      private: false,
      visibility: 'public',
      parameters: { required_approving_review_count: 1, require_last_push_approval: true },
    })
    // Under a kept key, a value that is not an enumeration is its type.
    expect(shapeOf({ type: 'ada@example.com', state: 'a'.repeat(41), target: 'two words', status: null })).toEqual({
      type: '<string>',
      state: '<string>',
      target: '<string>',
      status: '<null>',
    })
    expect(KEPT_KEYS).not.toContain('login')
    expect(KEPT_KEYS).not.toContain('name')
    expect(KEPT_KEYS).not.toContain('email')
    expect(KEPT_KEYS).not.toContain('id')
    expect(KEPT_KEYS).toContain('current_user_can_bypass')
    expect(KEPT_KEYS).toContain('status')
  })

  it('writes one shape per distinct array element, sorted, so three rules keep their three types', () => {
    const rules = [
      { type: 'pull_request', ruleset_id: 7, parameters: { required_approving_review_count: 1 } },
      { type: 'non_fast_forward', ruleset_id: 7 },
      { type: 'deletion', ruleset_id: 7 },
      { type: 'deletion', ruleset_id: 8 },
    ]
    expect(shapeOf(rules)).toEqual([
      { type: 'deletion', ruleset_id: '<number>' },
      { type: 'non_fast_forward', ruleset_id: '<number>' },
      { type: 'pull_request', ruleset_id: '<number>', parameters: { required_approving_review_count: 1 } },
    ])
    expect(shapeOf([])).toEqual([])
    expect(shapeOf([1, 2, 'x', null])).toEqual(['<null>', '<number>', '<string>'])
  })

  it('finds a key the fake sends and GitHub did not, another type and another kept value, each by its path', () => {
    const recorded = shapeOf({ full_name: 'acme/iac', owner: { type: 'User' }, permissions: { admin: true }, topics: [] })
    const fake = shapeOf({
      full_name: 1,
      owner: { type: 'Organization' },
      permissions: { admin: true, triage: true },
      description: 'the declarations',
      topics: ['x'],
    })
    expect(fakeWithin(fake, recorded)).toEqual(['$.full_name', '$.owner.type', '$.permissions.triage', '$.description', '$.topics[0]'])
    expect(fakeWithin(shapeOf([{ a: 1 }]), shapeOf({ a: 1 }))).toEqual(['$'])
    expect(fakeWithin(shapeOf({ a: 1 }), shapeOf([{ a: 1 }]))).toEqual(['$'])
  })

  it('finds nothing when the fake sends a subset of what GitHub sent', () => {
    const recorded = shapeOf([
      { type: 'pull_request', ruleset_id: 3, parameters: { required_approving_review_count: 1, allowed_merge_methods: ['merge'] } },
      { type: 'deletion', ruleset_id: 3 },
    ])
    const fake = shapeOf([{ type: 'deletion', ruleset_id: 1 }])
    expect(fakeWithin(fake, recorded)).toEqual([])
    expect(fakeWithin(shapeOf([]), recorded)).toEqual([])
    expect(fakeWithin(shapeOf({ login: 'x' }), shapeOf({ login: 'y', id: 2 }))).toEqual([])
  })
})

describe('what the answers file may hold', () => {
  it('replaces a login in any case, inside a URL and inside a remote line', () => {
    const line = 'remote: https://github.com/AdaL/idpa-live/pull/1 opened by adal; reviewed by GRACE-h.'
    expect(
      scrubbed(line, [
        { text: 'adal', as: '<owner>' },
        { text: 'grace-h', as: '<reviewer>' },
      ]),
    ).toBe('remote: https://github.com/<owner>/idpa-live/pull/1 opened by <owner>; reviewed by <reviewer>.')
    // Literal: a name is never read as a pattern.
    expect(scrubbed('axb a.b', [{ text: 'a.b', as: '<owner>' }])).toBe('axb <owner>')
    expect(scrubbed('nothing here', [{ text: '', as: '<owner>' }])).toBe('nothing here')
  })

  it('names the kind of each identifying text left, never the text', () => {
    const file = JSON.stringify({ repository: '<owner>/idpa-live', remote: ['remote: AdaL was here'] })
    const found = identifying(file, [
      { text: 'adal', kind: 'the owner’s login' },
      { text: 'grace-h', kind: 'the reviewer’s login' },
      { text: 'Ada Lovelace', kind: 'the owner’s name' },
      { text: '', kind: 'an empty email' },
    ])
    expect(found).toEqual(['the owner’s login'])
    expect(found.join(' ')).not.toMatch(/adal/i)
    expect(identifying('{"repository":"<owner>/idpa-live"}', [{ text: 'adal', kind: 'the owner’s login' }])).toEqual([])
  })

  it('sees a token of each shape TOKEN_SHAPE covers, and a near miss it does not', () => {
    const body = 'A'.repeat(36)
    for (const prefix of ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_']) {
      expect(TOKEN_SHAPE.test(`token ${prefix}${body} here`), prefix).toBe(true)
      expect(identifying(`"${prefix}${body}"`, []), prefix).toEqual(['a token’s shape'])
    }
    expect(TOKEN_SHAPE.test(`github_pat_${'a1_'.repeat(28)}`)).toBe(true)
    for (const near of [`ghp_${'A'.repeat(35)}`, `ghx_${body}`, `xghp_${body}`, 'github_pat_short', 'ghp_']) {
      expect(TOKEN_SHAPE.test(near), near).toBe(false)
    }
  })

  describe('what a passed run’s doors and its end must say', () => {
    const door = (change: Partial<DoorEntry> = {}): DoorEntry => ({
      door: 'a door',
      via: 'gh-api',
      step: 'doors',
      reachedGitHub: true,
      exit: 1,
      status: 405,
      refused: true,
      reason: 'not-mergeable',
      baseUnchanged: true,
      remote: [],
      ...change,
    })
    // GitHub's answer of 2026-10-02 to the door that merges later: 202, then the rules refused it.
    const queued = door({ door: 'the door merged later', exit: 0, status: 202, reason: 'queued', observed: { reads: 6, seconds: 30, merged: false } })

    it('holds doors each refused, a queued one observed never merged, and nothing merged at the end', () => {
      expect(unheld({ doors: [door(), queued], neverMerged: true })).toEqual([])
    })

    it('names a door that never reached GitHub, was not refused, or left the base moved', () => {
      expect(unheld({ doors: [door({ reachedGitHub: false }), door({ refused: false, reason: 'accepted', exit: 0, status: 201 }), door({ baseUnchanged: false })], neverMerged: true })).toEqual([
        'a door (doors): never reached GitHub',
        'a door (doors): not refused (accepted)',
        'a door (doors): the base moved',
      ])
    })

    it('names a queued door never observed, or observed merged, even recorded refused', () => {
      expect(unheld({ doors: [door({ door: 'the door merged later', exit: 0, status: 202, reason: 'queued' })], neverMerged: true })).toEqual([
        'the door merged later (doors): queued, and never observed',
      ])
      expect(unheld({ doors: [{ ...queued, observed: { reads: 0, seconds: 0, merged: false } }], neverMerged: true })).toEqual([
        'the door merged later (doors): queued, and never observed',
      ])
      expect(unheld({ doors: [{ ...queued, observed: { reads: 6, seconds: 30, merged: true } }], neverMerged: true })).toEqual([
        'the door merged later (doors): queued, and observed merged',
      ])
    })

    it('names an end not known never merged: merged, or not read', () => {
      expect(unheld({ doors: [queued], neverMerged: false })).toEqual(['neverMerged is false, not true'])
      expect(unheld({ doors: [queued], neverMerged: null })).toEqual(['neverMerged is null, not true'])
    })
  })

  it('refuses to list no file: a pattern with no match is a read error', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'idp-answers-'))
    expect(() => answersFiles(dir)).toThrow(/no answers file/)
    expect(() => answersFiles(path.join(dir, 'absent'))).toThrow(/no answers file/)
    await writeFile(path.join(dir, 'other.json'), '{}')
    expect(() => answersFiles(dir)).toThrow(/no answers file/)
    await writeFile(path.join(dir, 'answers-2026-10-02.json'), '{}')
    await writeFile(path.join(dir, 'answers-2026-09-30.json'), '{}')
    await mkdir(path.join(dir, 'answers-2026-10-01.json'))
    expect(answersFiles(dir).map((file) => path.basename(file))).toEqual(['answers-2026-09-30.json', 'answers-2026-10-02.json'])
  })
})
