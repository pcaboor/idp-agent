import { describe, expect, it } from 'vitest'
import { renderOverview } from '../../src/cli/render/overview.js'
import type { Overview, Tally } from '../../src/context/graph/overview.js'

const EMPTY: Overview = {
  entities: 0,
  kinds: [],
  types: [],
  environments: { declared: [], undeclared: 0 },
  owners: [],
  rights: { total: 0, read: 0, readwrite: 0, undeclared: 0, unlevelled: 0 },
  reached: [],
  dangling: [],
  setAside: { total: 0, kinds: [], unkinded: 0 },
  rejected: 0,
}

/** `n` tallies, already in the order `overviewOf` hands them over. */
const tallies = (prefix: string, n: number): Tally[] =>
  Array.from({ length: n }, (_, index) => ({ name: `${prefix}-${index}`, count: n - index }))

const BUSY: Overview = {
  ...EMPTY,
  entities: 40,
  kinds: [
    { name: 'Resource', count: 32 },
    { name: 'Component', count: 8 },
  ],
  types: tallies('type', 8),
  environments: { declared: tallies('env', 3), undeclared: 8 },
  owners: tallies('group:default/team', 6),
  rights: { total: 12, read: 5, readwrite: 4, undeclared: 1, unlevelled: 2 },
  reached: Array.from({ length: 7 }, (_, index) => ({
    ref: `resource:default/db-${index}`,
    services: 7 - index,
    rights: 9 - index,
  })),
  dangling: Array.from({ length: 6 }, (_, index) => ({
    from: `component:default/svc-${index}`,
    to: `resource:default/ghost-${index}`,
  })),
}

const section = (text: string, title: string): string[] => {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.startsWith(title))
  expect(start, `no "${title}" section`).toBeGreaterThanOrEqual(0)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => !line.startsWith('  '))
  return end === -1 ? rest : rest.slice(0, end)
}

describe('renderOverview', () => {
  it('names the demo SI in its first line, as the fictional company it is', () => {
    const [headline] = renderOverview(BUSY, {}).split('\n')
    expect(headline).toMatch(/demo SI/)
    expect(headline).toMatch(/fictional/)
    expect(headline).toMatch(/40 entities/)
  })

  it('names the repository by the name it is handed, which main takes from its folder', () => {
    const [headline] = renderOverview(BUSY, { repo: 'IaC' }).split('\n')
    expect(headline).toBe('Overview of the repository IaC: 40 entities')
    expect(headline).not.toMatch(/demo SI/)
  })

  it('bounds every list at five, and says how many more there are', () => {
    const text = renderOverview(BUSY, {})
    const types = section(text, 'types')
    expect(types).toHaveLength(6)
    expect(types.slice(0, 5).map((line) => line.trim().split(/\s+/)[0])).toEqual(
      ['type-0', 'type-1', 'type-2', 'type-3', 'type-4'],
    )
    expect(types[5]?.trim()).toBe('+3 more')

    expect(section(text, 'owners').at(-1)?.trim()).toBe('+1 more')
    expect(section(text, 'most reached').at(-1)?.trim()).toBe('+2 more')
    expect(section(text, 'dangling references').at(-1)?.trim()).toBe('+1 more')
    // Two kinds is not a list to cut.
    expect(section(text, 'kinds')).toHaveLength(2)
  })

  it('prints the counts it was given, not an approximation of them', () => {
    const text = renderOverview(BUSY, {})
    expect(section(text, 'kinds')[0]).toMatch(/^\s+Resource\s+32$/)
    expect(section(text, 'most reached')[0]).toMatch(
      /resource:default\/db-0\s+7 services, 9 rights$/,
    )
    expect(section(text, 'dangling references')[0]).toContain(
      'component:default/svc-0 → resource:default/ghost-0',
    )
  })

  it('states an undeclared environment and an undeclared level, never hiding them', () => {
    const text = renderOverview(BUSY, {})
    expect(section(text, 'environments').at(-1)).toMatch(/^\s+\(undeclared\)\s+8$/)
    const rights = section(text, 'rights')
    expect(rights.join('\n')).toMatch(/read\s+5/)
    expect(rights.join('\n')).toMatch(/readwrite\s+4/)
    expect(rights.join('\n')).toMatch(/level undeclared\s+1/)
    expect(rights.join('\n')).toMatch(/no level to state\s+2/)
  })

  it('says what reaches an object when no declared service does, and what none means', () => {
    const grantsOnly = renderOverview(
      { ...BUSY, reached: [{ ref: 'resource:default/orders-db', services: 0, rights: 1 }] },
      {},
    )
    expect(section(grantsOnly, 'most reached')).toEqual([
      '  resource:default/orders-db  0 services, 1 right',
    ])
    // "none" alone reads as a fact about the catalogue; say what was counted.
    expect(renderOverview({ ...BUSY, reached: [] }, {})).toMatch(
      /^most reached {2}no service or right reaches an object$/m,
    )
  })

  it('says what it could not read: set aside by kind, and rejected', () => {
    const text = renderOverview(
      {
        ...BUSY,
        setAside: {
          total: 5,
          kinds: [
            { name: 'User', count: 3 },
            { name: 'Group', count: 1 },
          ],
          unkinded: 1,
        },
        rejected: 2,
      },
      {},
    )
    expect(text).toMatch(/not loaded\s+5 documents this tool does not model/)
    expect(section(text, 'not loaded')).toEqual([
      expect.stringMatching(/^\s+User\s+3$/),
      expect.stringMatching(/^\s+Group\s+1$/),
      expect.stringMatching(/^\s+not an entity\s+1$/),
    ])
    expect(text).toMatch(/rejected\s+2 documents/)
  })

  it('says nothing about set-aside or rejected documents when there were none', () => {
    const text = renderOverview(BUSY, {})
    expect(text).not.toMatch(/not loaded/)
    expect(text).not.toMatch(/rejected/)
  })

  it('describes an empty catalogue in words rather than as empty sections', () => {
    const text = renderOverview({ ...EMPTY, setAside: { total: 1, kinds: [], unkinded: 1 } }, {
      repo: 'iac',
    })
    expect(text.split('\n')[0]).toMatch(/0 entities/)
    expect(text).toMatch(/declares no entity/)
    expect(text).not.toMatch(/^kinds/m)
    expect(text).toMatch(/not loaded/)
  })

  it('is plain text: no colour, no escape, no trailing space', () => {
    const hostile: Overview = {
      ...BUSY,
      types: [{ name: 'svc\u001B[2J\u001B[31m', count: 1 }],
      setAside: { total: 1, kinds: [{ name: 'Gro\u001B]8;;x\u0007up', count: 1 }], unkinded: 0 },
    }
    const text = renderOverview(hostile, { repo: 'i\u001B[2Jac' })
    // eslint-disable-next-line no-control-regex -- asserting their absence
    expect(text).not.toMatch(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/)
    expect(text.split('\n').every((line) => line === line.trimEnd())).toBe(true)
  })

  it('renders the same overview to the same bytes', () => {
    expect(renderOverview(BUSY, { repo: 'iac' })).toBe(renderOverview(structuredClone(BUSY), {
      repo: 'iac',
    }))
  })
})
