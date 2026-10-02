import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  PATCH_LINES,
  isSubmissionBranch,
  judgeInFlight,
  mergeReads,
  type InFlightFile,
  type InFlightPull,
  type InFlightTarget,
} from '../../src/core/github/in-flight.js'

/**
 * What is in flight, judged (stage 6 plan, Task 6.3.6): pure, no process. The
 * candidates are the open idp-agent pull requests into the base; the target is
 * what this change writes, each path with the blob its bytes hash to, and the
 * files of the same entities. The verdict table's rows in order: the same bytes,
 * a competing change, one beside it, nothing.
 */

const BLOB_A = 'a'.repeat(40)
const BLOB_B = 'b'.repeat(40)
const ACCESS = 'dependencies/access/billing-api-orders-db-prod.yml'
const DATABASE = 'catalog/databases/orders-db-prod.yml'
const COMPONENT = 'components/billing-api.yml'

const file = (path: string, blob: string = BLOB_A, more: Partial<InFlightFile> = {}): InFlightFile => ({
  path,
  blob,
  removed: false,
  ...more,
})

const pull = (number: number, files: readonly InFlightFile[], more: Partial<InFlightPull> = {}): InFlightPull => ({
  number,
  by: 'grace',
  branch: `idp-agent/change-${String(number).padStart(8, '0')}`,
  head: String(number).padStart(40, 'c'),
  files,
  complete: true,
  ...more,
})

const BRANCH = 'idp-agent/orders-db-prod-0123abcd'
const TARGET: InFlightTarget = {
  writes: [
    { path: ACCESS, blob: BLOB_A },
    { path: DATABASE, blob: BLOB_A },
  ],
  related: [COMPONENT],
  branch: BRANCH,
  me: 'ada',
}

describe('judgeInFlight, one row of the table each', () => {
  it('row 1: the same bytes on the same paths, the file list whole, is the same', () => {
    const same = pull(3, [file(ACCESS), file(DATABASE)])
    expect(judgeInFlight([same], TARGET)).toEqual({ kind: 'same', pull: same })
  })

  it('row 2: a written path changed otherwise is competing, with that path', () => {
    const other = pull(4, [file(ACCESS, BLOB_B), file('README.md')])
    expect(judgeInFlight([other], TARGET)).toEqual({ kind: 'competing', pulls: [{ pull: other, paths: [ACCESS] }] })
  })

  it('row 3: a related path and no written one is beside, with that path', () => {
    const beside = pull(5, [file(COMPONENT), file('README.md')])
    expect(judgeInFlight([beside], TARGET)).toEqual({ kind: 'beside', pulls: [{ pull: beside, paths: [COMPONENT] }] })
  })

  it('row 4: none of the above is clear', () => {
    expect(judgeInFlight([pull(6, [file('README.md')])], TARGET)).toEqual({ kind: 'clear' })
    expect(judgeInFlight([], TARGET)).toEqual({ kind: 'clear' })
  })
})

describe('judgeInFlight, the edges', () => {
  it('names the lowest-numbered of two identical proposals', () => {
    const later = pull(9, [file(DATABASE), file(ACCESS)])
    const earlier = pull(2, [file(ACCESS), file(DATABASE)])
    expect(judgeInFlight([later, earlier], TARGET)).toEqual({ kind: 'same', pull: earlier })
  })

  it('prefers same over competing', () => {
    const competing = pull(1, [file(ACCESS, BLOB_B)])
    const same = pull(7, [file(ACCESS), file(DATABASE)])
    expect(judgeInFlight([competing, same], TARGET)).toMatchObject({ kind: 'same', pull: { number: 7 } })
  })

  it('prefers competing over beside, and lists each by number', () => {
    const beside = pull(1, [file(COMPONENT)])
    const second = pull(8, [file(DATABASE, BLOB_B)])
    const first = pull(4, [file(ACCESS, BLOB_B), file(DATABASE, BLOB_B)])
    expect(judgeInFlight([beside, second, first], TARGET)).toEqual({
      kind: 'competing',
      pulls: [
        { pull: first, paths: [DATABASE, ACCESS] },
        { pull: second, paths: [DATABASE] },
      ],
    })
  })

  it("counts a rename's old path as changed", () => {
    const renamed = pull(3, [file('dependencies/access/elsewhere.yml', BLOB_A, { previous: ACCESS })])
    expect(judgeInFlight([renamed], TARGET)).toEqual({ kind: 'competing', pulls: [{ pull: renamed, paths: [ACCESS] }] })
  })

  it('never calls a cut file list the same, and judges a cut list on the files it holds', () => {
    const cut = pull(3, [file(ACCESS), file(DATABASE)], { complete: false })
    expect(judgeInFlight([cut], TARGET)).toEqual({ kind: 'competing', pulls: [{ pull: cut, paths: [DATABASE, ACCESS] }] })
    const cutBeside = pull(4, [file(COMPONENT)], { complete: false })
    expect(judgeInFlight([cutBeside], TARGET)).toEqual({ kind: 'beside', pulls: [{ pull: cutBeside, paths: [COMPONENT] }] })
  })

  it('never calls a write with no blob the same, and says beside on catalog-info.yml while catalog-info.yaml is written', () => {
    const init: InFlightTarget = { writes: [{ path: 'catalog-info.yaml' }], related: ['catalog-info.yml'], me: 'ada' }
    const yaml = pull(2, [file('catalog-info.yaml')])
    expect(judgeInFlight([yaml], init)).toEqual({ kind: 'competing', pulls: [{ pull: yaml, paths: ['catalog-info.yaml'] }] })
    const yml = pull(3, [file('catalog-info.yml')])
    expect(judgeInFlight([yml], init)).toEqual({ kind: 'beside', pulls: [{ pull: yml, paths: ['catalog-info.yml'] }] })
  })

  it('leaves this change’s own branch, opened by gh’s own login, to recognition', () => {
    const mine = pull(1, [file(ACCESS), file(DATABASE)], { by: 'ada', branch: BRANCH })
    expect(judgeInFlight([mine], TARGET)).toEqual({ kind: 'clear' })
  })

  it('leaves the whole judgement to recognition when this change is already open by gh’s own login, whatever else is in flight', () => {
    const mine = pull(1, [file(ACCESS), file(DATABASE)], { by: 'ada', branch: BRANCH })
    const competing = pull(2, [file(DATABASE, BLOB_B)])
    const same = pull(3, [file(ACCESS), file(DATABASE)])
    const beside = pull(4, [file(COMPONENT)])
    expect(judgeInFlight([competing, mine], TARGET)).toEqual({ kind: 'clear' })
    expect(judgeInFlight([same, beside, mine], TARGET)).toEqual({ kind: 'clear' })
    // Without the branch, nothing is this change's own: before the bytes, every candidate is judged.
    const { branch: _branch, ...before } = TARGET
    expect(judgeInFlight([competing, mine], before)).toEqual({ kind: 'same', pull: mine })
  })

  it('calls the same branch opened by another login the same: the other person’s run of the very same change', () => {
    const theirs = pull(1, [file(ACCESS), file(DATABASE)], { by: 'grace', branch: BRANCH })
    expect(judgeInFlight([theirs], TARGET)).toEqual({ kind: 'same', pull: theirs })
  })

  it('treats a removed written path as competing', () => {
    const removed = pull(3, [{ path: ACCESS, removed: true }, file(DATABASE)])
    expect(judgeInFlight([removed], TARGET)).toEqual({ kind: 'competing', pulls: [{ pull: removed, paths: [DATABASE, ACCESS] }] })
  })

  it('never calls a pull request that changes more than the writes the same', () => {
    const wider = pull(3, [file(ACCESS), file(DATABASE), file('README.md')])
    expect(judgeInFlight([wider], TARGET)).toEqual({ kind: 'competing', pulls: [{ pull: wider, paths: [DATABASE, ACCESS] }] })
    const narrower = pull(4, [file(ACCESS)])
    expect(judgeInFlight([narrower], TARGET)).toEqual({ kind: 'competing', pulls: [{ pull: narrower, paths: [ACCESS] }] })
  })

  it('never calls anything the same when nothing is written', () => {
    const empty = pull(3, [])
    expect(judgeInFlight([empty], { writes: [], related: [], me: 'ada' })).toEqual({ kind: 'clear' })
  })

  it('compares paths byte for byte', () => {
    const cased = pull(3, [file(ACCESS.toUpperCase())])
    const spaced = pull(4, [file(`${ACCESS}\u200b`)])
    const decomposed = pull(5, [file(COMPONENT.normalize('NFD').replace('i', 'i\u0307'))])
    expect(judgeInFlight([cased, spaced, decomposed], TARGET)).toEqual({ kind: 'clear' })
  })

  it("reports only this change's own paths, whatever else the candidate changes", () => {
    const pulls = [
      pull(2, [file(ACCESS, BLOB_B), file('secret/canary-a.yml'), file('canary-b.yml', BLOB_A, { previous: 'canary-c.yml' })]),
      pull(3, [file(COMPONENT), file('canary-d.yml')]),
    ]
    for (const verdict of [judgeInFlight(pulls, TARGET), judgeInFlight(pulls.slice(1), TARGET)]) {
      const listed = verdict.kind === 'competing' || verdict.kind === 'beside' ? verdict.pulls.flatMap((one) => one.paths) : []
      expect(listed.length).toBeGreaterThan(0)
      for (const path of listed) expect([...TARGET.writes.map((write) => write.path), ...TARGET.related]).toContain(path)
    }
  })
})

describe('mergeReads', () => {
  const one = pull(1, [file(ACCESS)])
  const two = pull(2, [file(DATABASE)])
  const old = pull(150, [file(COMPONENT)])

  it('drops a candidate gone from page 1 because it closed, replaces one whose head moved, adds a new one, keeps one beyond page 1', () => {
    const first = [old, two, one]
    const moved = pull(2, [file(ACCESS)], { head: 'd'.repeat(40) })
    const fresh = pull(301, [file(COMPONENT)])
    // Page 1, newest first: the hundred most recent open pull requests, candidates or not.
    const listed = [301, ...Array.from({ length: 98 }, (_, at) => 300 - at), 2]
    const merged = mergeReads(first, [fresh, moved], { listed, whole: false })
    expect(merged.map((candidate) => candidate.number)).toEqual([301, 2, 1])
    expect(merged.find((candidate) => candidate.number === 2)).toBe(moved)
    // #150 is newer than #2, the oldest on page 1, and not on it: it closed.
    expect(mergeReads([old, one], [], { listed: [200, ...Array.from({ length: 99 }, (_, at) => 149 - at)], whole: false })).toEqual([one])
  })

  it('drops every candidate missing from a page that was the whole list', () => {
    expect(mergeReads([old, two, one], [two], { listed: [2], whole: true })).toEqual([two])
  })
})

describe('the rest of the module', () => {
  it('reads a submission branch as SUBMISSION_BRANCH does', () => {
    expect(isSubmissionBranch('idp-agent/orders-db-prod-0123abcd')).toBe(true)
    for (const name of ['idp-agent/x-0123abc', 'feature/by-hand', 'dependabot/npm/x-1.0.1', 'idp-agent/X-0123abcd', 'idp-agent/x-0123abcd/y']) {
      expect(isSubmissionBranch(name), name).toBe(false)
    }
  })

  it('bounds a patch: 40 lines a path, 120 a run, 200 characters a line', () => {
    expect(PATCH_LINES).toEqual({ perPath: 40, perRun: 120, perLine: 200 })
  })

  it('never reads a title', () => {
    expectTypeOf<InFlightPull>().not.toHaveProperty('title')
    expectTypeOf<InFlightPull>().not.toHaveProperty('body')
    expectTypeOf<InFlightFile>().not.toHaveProperty('title')
  })
})
