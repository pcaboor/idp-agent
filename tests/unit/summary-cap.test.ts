import { readFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  VOCABULARY_LIST_LIMIT,
  formatSummary,
  shownVocabulary,
} from '../../src/agents/summary.js'
import { runInitPlatform } from '../../src/cli/commands/init.js'
import { runIntent } from '../../src/cli/commands/plan.js'
import { FixtureProvider } from '../../src/context/fixtures/index.js'
import { EntityGraph } from '../../src/context/graph/entity-graph.js'
import {
  summariseGraph,
  type SiSummary,
  type Vocabulary,
  type VocabularyCounts,
} from '../../src/context/graph/summary.js'
import type { Entity } from '../../src/core/schemas/entity.js'
import type { GenerateRequest, LlmClient } from '../../src/llm/client.js'

/**
 * The one unbounded thing a model was shown is the summary's vocabulary: a
 * catalogue of 300 Groups put 300 owners in every Supervisor and Analyst
 * prompt (review, domain-backstage-8; docs/backstage-http-brief.md § 6). Each
 * list those two are shown holds at most 30 values, the most frequent, then
 * how many more. A list of 30 or fewer prints as it always did, which is what
 * keeps every recording replaying; the Architect's summary and the gates keep
 * every value.
 */

const DEMO = path.resolve(import.meta.dirname, '../../fixtures/si-demo')
const GOLDEN_SUMMARY = path.resolve(import.meta.dirname, '../golden/demo-read/summary.txt')

const SUMMARY: SiSummary = {
  entities: '100+',
  components: '100+',
  resources: '0',
  danglingReferences: 0,
}

const vocabularyOf = (owners: readonly string[]): Vocabulary => ({
  kinds: ['Component'],
  types: ['service'],
  environments: [],
  owners: [...owners],
})

/** Every value seen once, but those `frequent` names, seen as often as it says. */
const countsOf = (
  owners: readonly string[],
  frequent: Readonly<Record<string, number>> = {},
): VocabularyCounts => ({
  kinds: new Map([['Component', owners.length]]),
  types: new Map([['service', owners.length]]),
  environments: new Map(),
  owners: new Map(owners.map((owner) => [owner, frequent[owner] ?? 1])),
})

const TEAMS = Array.from({ length: 300 }, (_, i) => `group:default/team-${String(i).padStart(3, '0')}`)

const ownersLine = (text: string): string =>
  text.split('\n').find((line) => line.startsWith('  owners: ')) ?? ''

const service = (name: string, owner: string): Entity => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: { name, annotations: {} },
  spec: { type: 'service', lifecycle: 'production', owner },
})

describe('each vocabulary list the Supervisor and the Analyst are shown', () => {
  it('prints a list of 30 or fewer exactly as before', async () => {
    // The demo SI's summary, whose bytes every tape's digest was recorded over.
    const graph = EntityGraph.from((await new FixtureProvider(DEMO).load()).entities)
    const { summary, vocabulary, counts } = summariseGraph(graph)
    expect(formatSummary(summary, vocabulary, counts)).toBe(
      readFileSync(GOLDEN_SUMMARY, 'utf8').trimEnd(),
    )
  })

  it('prints the 30 most frequent of a longer list, alphabetically, then "and K more"', () => {
    const text = formatSummary(
      SUMMARY,
      vocabularyOf(TEAMS),
      countsOf(TEAMS, { 'group:default/team-299': 9 }),
    )
    const line = ownersLine(text)
    expect(line.endsWith(', and 270 more')).toBe(true)
    // The most frequent is shown, however it sorts; the rest are the first by value.
    expect(line).toContain('group:default/team-299')
    expect(line).toContain('group:default/team-000')
    expect(line).toContain('group:default/team-028')
    expect(line).not.toContain('group:default/team-029')
    const values = line.slice('  owners: '.length, -', and 270 more'.length).split(', ')
    expect(values).toHaveLength(VOCABULARY_LIST_LIMIT)
    expect(values).toEqual([...values].sort())
    // Still ten lines: the cap adds no line to the prompt.
    expect(text.split('\n')).toHaveLength(10)
  })

  it('breaks a tie by value, and sorts what it keeps in code-unit order', () => {
    const values = ['b', 'B', 'a', ...Array.from({ length: 30 }, (_, i) => `z${String(i).padStart(2, '0')}`)]
    const shown = shownVocabulary(
      { kinds: [], types: values, environments: [], owners: [] },
      {
        kinds: new Map(),
        types: new Map(values.map((value) => [value, value === 'z29' ? 2 : 1])),
        environments: new Map(),
        owners: new Map(),
      },
    )
    expect(shown.types.more).toBe(3)
    expect(shown.types.values).toEqual([
      'B', 'a', 'b',
      ...Array.from({ length: 26 }, (_, i) => `z${String(i).padStart(2, '0')}`),
      'z29',
    ])
  })

  it('keeps, at the 30th place of a tie, the value code-unit order puts first, whatever the locale', () => {
    // 29 values every order puts first, then 'Z' and 'a', all seen once: code
    // units keep 'Z' (90 < 97), a locale's collation would keep 'a'.
    const values = [...Array.from({ length: 29 }, (_, i) => String(i).padStart(2, '0')), 'a', 'Z']
    const shown = shownVocabulary(
      { kinds: [], types: values, environments: [], owners: [] },
      {
        kinds: new Map(),
        types: new Map(values.map((value) => [value, 1])),
        environments: new Map(),
        owners: new Map(),
      },
    )
    expect(shown.types.more).toBe(1)
    expect(shown.types.values).toContain('Z')
    expect(shown.types.values).not.toContain('a')
  })

  it('counts values that flatten alike as one, their frequencies summed', () => {
    const types = [...Array.from({ length: 34 }, (_, i) => `t${String(i).padStart(2, '0')}`), 'x y', 'x\ny', 'x\ty']
    const counts: VocabularyCounts = {
      kinds: new Map(),
      // Each `t` twice; each spelling of `x y` once, three once flattened.
      types: new Map(types.map((type) => [type, type.startsWith('t') ? 2 : 1])),
      environments: new Map(),
      owners: new Map(),
    }
    const shown = shownVocabulary({ kinds: [], types, environments: [], owners: [] }, counts)
    // 35 values as listed: 34 and the one `x y`.
    expect(shown.types.more).toBe(5)
    expect(shown.types.values).toContain('x y')
    expect(shown.types.values.filter((value) => value === 'x y')).toHaveLength(1)
    expect(shown.types.values).not.toContain('t33')
  })

  it('leaves the gates the whole vocabulary', () => {
    const graph = EntityGraph.from(TEAMS.map((owner, i) => service(`svc-${String(i)}`, owner)))
    const { summary, vocabulary, counts } = summariseGraph(graph)
    expect(vocabulary.owners).toHaveLength(300)
    expect(counts.owners.size).toBe(300)
    expect(counts.owners.get('group:default/team-042')).toBe(1)
    expect(counts.kinds.get('Component')).toBe(300)
    // What the two agents are shown is bounded; what was summarised is not.
    expect(ownersLine(formatSummary(summary, vocabulary, counts))).toMatch(/, and 270 more$/)
  })
})

describe('the cap only where the note puts it', () => {
  it('caps nothing without the counts: every value printed, as the Architect and init are shown', () => {
    const line = ownersLine(formatSummary(SUMMARY, vocabularyOf(TEAMS)))
    for (const team of TEAMS) expect(line).toContain(team)
    expect(line).not.toContain('more')
  })

  it("shows the Architect every owner of a declarations repository of more than 30", async () => {
    const repo = path.join(await mkdtemp(path.join(tmpdir(), 'idp-summary-cap-')), 'iac')
    await runInitPlatform({ root: repo, owner: '@acme/platform', version: '0.0.0-test' })
    const owners = Array.from({ length: 40 }, (_, i) => `group:default/team-${String(i).padStart(2, '0')}`)
    for (const [i, owner] of owners.entries()) {
      await writeFile(
        path.join(repo, 'catalog', 'databases', `db-${String(i)}.yml`),
        [
          '---',
          'apiVersion: backstage.io/v1alpha1',
          'kind: Resource',
          'metadata:',
          `  name: db-${String(i)}`,
          '  annotations:',
          '    company.fr/env: prod',
          'spec:',
          '  type: database',
          `  owner: ${owner}`,
          '',
        ].join('\n'),
        'utf8',
      )
    }
    const seen: GenerateRequest[] = []
    const client: LlmClient = {
      generate: async (request) => {
        seen.push({ ...request, transcript: [...request.transcript] })
        return { text: '', toolCalls: [], finishReason: 'stop' }
      },
    }

    await runIntent({
      intent: 'declare the database orders-db-prod',
      repo,
      project: undefined,
      client,
      emit: () => {},
      ask: async () => undefined,
    })

    const first = seen.find((request) => request.agent === 'architect')?.transcript[0]
    const opening = first !== undefined && first.role === 'user' ? first.text : ''
    const line = ownersLine(opening)
    for (const owner of owners) expect(line).toContain(owner)
    expect(line).not.toContain('more')
  })
})
