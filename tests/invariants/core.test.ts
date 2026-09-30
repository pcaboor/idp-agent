import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { PROPERTY_TIMEOUT, freshSeed } from './budget.js'
import {
  arbitraryEntity,
  arbitraryHandWrittenFile,
  arbitraryHandWrittenFileEndingInBreak,
  arbitraryHandWrittenGrant,
  handWrittenAround,
  entityName,
  arbitraryValidPlan,
  handWrittenFileOf,
} from './arbitraries.js'
import { parseEntity, serializeEntity } from '../../src/core/yaml/serialize.js'
import { entitySchema, type Entity } from '../../src/core/schemas/entity.js'
import { findUnknowns, planSchema, type Plan } from '../../src/core/schemas/plan.js'
import { signPlan, type SignedPlan } from '../../src/core/plan/sign.js'
import { applyEdits, planEdits } from '../../src/core/plan/edits.js'
import { nothingStated, type Provenance } from '../../src/core/plan/provenance.js'
import { recheckPlan } from '../../src/core/plan/recheck.js'
import { repositoryFileOf, type RepositorySnapshot } from '../../src/core/validate/rules.js'
import { parseDocuments, readDocuments } from '../../src/core/yaml/serialize.js'
import { answeredAtEveryPath, statedLeaves, userSaid } from '../support/provenance.js'
import {
  appendSequenceItem,
  insertDocument,
  listDocumentNames,
  removeDocument,
} from '../../src/core/yaml/surgery.js'
import { assertInsideRepo, resolveEntityPath } from '../../src/core/paths/entity-path.js'

const signatureContext = {
  witnessed: new Set<string>(),
  vocabulary: {
    kinds: ['Component', 'Resource'],
    types: ['database', 'cache', 'api', 'database-access', 'network-access'],
    environments: ['dev', 'staging', 'prod'],
    owners: ['group:default/tiger', 'group:default/common'],
  },
  repoRoot: '/repo',
  declared: new Map<string, string>(),
}

/** Counts terminal values the way the signer walks them. */
function countLeaves(value: unknown): number {
  if (value === null || typeof value !== 'object') return 1
  if (typeof value === 'object' && value !== null && 'unknown' in value) return 1
  if (Array.isArray(value)) return value.reduce((n: number, v) => n + countLeaves(v), 0)
  return Object.values(value).reduce((n: number, v) => n + countLeaves(v), 0)
}

/** One entity, for an example beside a property. */
const SOME: Entity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Resource',
  metadata: { name: 'orders-db', annotations: {} },
  spec: { type: 'database', owner: 'group:default/tiger' },
}

/** The repository `files` make, as the re-check reads one: parsed by the one reader. */
const snapshotOf = (files: ReadonlyMap<string, string>): RepositorySnapshot => ({
  folders: [],
  witnesses: [],
  files: [...files].map(([file, text]) => repositoryFileOf(file, text)),
})

/**
 * Where the hand-written file sits: at the first path the plan's creations
 * are given, so a creation is inserted into it, or — for a plan that creates
 * nothing the engine files — where an update finds its grant.
 */
const fileAt = (signed: SignedPlan): string =>
  [...signed.paths.values()][0] ?? 'dependencies/access/by-hand.yml'

const refsIn = (text: string): string[] =>
  parseDocuments(text).entities.map((entity) => `${entity.kind.toLowerCase()}:default/${entity.metadata.name}`)

describe('invariants', { timeout: PROPERTY_TIMEOUT }, () => {
  it('serialise then reload yields the same entity', () => {
    fc.assert(
      fc.property(arbitraryEntity, (entity) => {
        expect(parseEntity(serializeEntity(entity))).toEqual(entity)
      }),
    )
  })

  it('insert then remove yields the file byte for byte', () => {
    // The file is hand-written on purpose. Building it with insertDocument would
    // make this vacuous: the input would already be normalised by the code under
    // test, and a parse-and-restringify implementation would pass.
    fc.assert(
      fc.property(arbitraryHandWrittenFileEndingInBreak, arbitraryEntity, (file, entity) => {
        fc.pre(!listDocumentNames(file).includes(entity.metadata.name))
        const grown = insertDocument(file, serializeEntity(entity))
        expect(removeDocument(grown, entity.metadata.name)).toBe(file)
      }),
    )
  })

  // Pinned, not fixed: a hand-written file whose last line has no line break
  // comes back with one. `insertDocument` must end that line before the
  // document it appends, and `removeDocument` cannot know the break was never
  // there — so §9.2's "byte for byte" holds only for a file that ends in one,
  // and the two round trips run over `arbitraryHandWrittenFileEndingInBreak`.
  // Found by batch B1's generators: `# note` comes back as `# note` and a line
  // break. This asserts those exact bytes rather than that the round trip
  // fails: a test that expects a failure stays green for any failure, a crash
  // in the generator included. It turns red the day the defect is fixed —
  // then it asserts `file`, and the round trips draw every file.
  it('insert then remove gives a file with no final line break one, and nothing else', () => {
    const seed = freshSeed()
    let nonEmpty = 0
    fc.assert(
      fc.property(
        handWrittenFileOf({ finalNewline: fc.constant(false) }),
        arbitraryEntity,
        ({ text: file }, entity) => {
          fc.pre(!listDocumentNames(file).includes(entity.metadata.name))
          const grown = insertDocument(file, serializeEntity(entity))
          const eol = file.includes('\r\n') ? '\r\n' : '\n'
          if (file !== '') nonEmpty += 1
          expect(removeDocument(grown, entity.metadata.name)).toBe(file === '' ? '' : file + eol)
        },
      ),
      { seed },
    )
    // An empty file has no last line to break: 91 to 99 of 100 drawn at seeds
    // 1 to 25 held one.
    expect(nonEmpty, `seed ${seed}`).toBeGreaterThan(50)
    const grown = insertDocument('# note', serializeEntity(SOME))
    expect(removeDocument(grown, SOME.metadata.name)).toBe('# note\n')
  })

  it('insert then append then remove yields the file byte for byte', () => {
    // Appending reaches only inside the document it was aimed at: whatever line
    // it added leaves with that document, and the hand-written neighbours come
    // back exactly as they were. Same reason the file is not built with
    // insertDocument — a normalised input would make this vacuous.
    fc.assert(
      fc.property(
        arbitraryHandWrittenFileEndingInBreak,
        arbitraryEntity,
        entityName,
        (file, entity, consumer) => {
          fc.pre(!listDocumentNames(file).includes(entity.metadata.name))
          const grown = insertDocument(file, serializeEntity(entity))
          const amended = appendSequenceItem(
            grown,
            entity.metadata.name,
            'dependencyOf',
            `component:default/${consumer}`,
          )
          // Without this the property would hold for a function that returned
          // its argument, which is exactly the failure mode it must exclude.
          expect(amended).not.toBe(grown)
          expect(removeDocument(amended, entity.metadata.name)).toBe(file)
        },
      ),
    )
  })

  it('removing a document that is not there changes nothing', () => {
    fc.assert(
      fc.property(arbitraryHandWrittenFile, entityName, (file, name) => {
        fc.pre(!listDocumentNames(file).includes(name))
        expect(removeDocument(file, name)).toBe(file)
      }),
    )
  })

  it('every inserted document is listed, in order', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(arbitraryEntity, { maxLength: 5, selector: (e) => e.metadata.name }),
        (entities) => {
          const file = entities.reduce(
            (acc, entity) => insertDocument(acc, serializeEntity(entity)),
            '',
          )
          expect(listDocumentNames(file)).toEqual(entities.map((e) => e.metadata.name))
        },
      ),
    )
  })

  /**
   * What a signed plan holds, counted over the plans the signer ACCEPTED: a
   * property that returns early on a refusal is proven over what is left.
   * Over the plans generated before batch B1 that was 79, 91 and 65 plans in
   * 2 000 at seeds 1 to 3, none of them a right, a Component or an update, and
   * none given a path — a name nobody vouched for is a question (tests-3).
   * Sampling the generator before the schema measured the wrong thing.
   */
  const shapesOf = (plan: Plan) => ({
    component: plan.operations.some(
      (operation) => operation.op === 'create-entity' && operation.entity.kind === 'Component',
    ),
    grant: plan.operations.some(
      (operation) =>
        operation.op === 'create-entity' &&
        operation.entity.kind === 'Resource' &&
        typeof operation.entity.spec.access === 'string' &&
        (operation.entity.spec.dependencyOf ?? []).length > 0,
    ),
    update: plan.operations.some((operation) => operation.op === 'update-entity'),
    question: findUnknowns(plan).length > 0,
  })

  const counted = () => {
    const seen = { accepted: 0, component: 0, grant: 0, update: 0, question: 0 }
    return {
      seen,
      count(plan: Plan): void {
        seen.accepted += 1
        for (const [shape, held] of Object.entries(shapesOf(plan))) {
          if (held) seen[shape as keyof ReturnType<typeof shapesOf>] += 1
        }
      },
    }
  }

  /**
   * Who vouches for what the draft wrote: nobody, the person's words, or the
   * person answering every field at its path. Drawn, because the signer
   * classifies each differently and a property over one would cover a
   * quarter of it; and the second property needs names somebody vouched for,
   * since a name nobody did becomes a question and a question has no path.
   */
  const vouching = fc.constantFrom('nothing', 'words', 'answers')
  const provenanceOf = (plan: Plan, by: 'nothing' | 'words' | 'answers'): Provenance =>
    by === 'nothing'
      ? nothingStated()
      : by === 'words'
        ? userSaid(
            statedLeaves(plan)
              .map(([, value]) => value)
              .join(' '),
          )
        : answeredAtEveryPath(plan)

  it('every leaf of a signed plan is classified', () => {
    // Total over leaves, not over references: a Plan carries invented values,
    // so the read-side membership test has nothing to test against. A field
    // that escaped by being nested is a field nobody vouched for.
    const { seen, count } = counted()
    const classes = new Set<string>()
    const seed = freshSeed()
    fc.assert(
      fc.property(arbitraryValidPlan, vouching, (draft, by) => {
        const parsed = planSchema.safeParse(draft)
        // Valid by construction, so a refusal is the generator's defect, not
        // a run to skip: skipping it is how these properties went empty.
        expect(parsed.success).toBe(true)
        if (!parsed.success) return
        const result = signPlan(parsed.data, signatureContext, provenanceOf(parsed.data, by))
        fc.pre(!('outcome' in result))
        if ('outcome' in result) return
        count(parsed.data)
        for (const finding of result.classified) classes.add(finding.class)
        expect(result.classified.length).toBe(countLeaves(result.plan.operations))
      }),
      { numRuns: 200, seed },
    )
    // A property that never met a grant, a Component, an update or a question
    // has proven nothing about one. Measured over 25 runs at fast-check's own
    // seeds: 46 to 69 plans in 200 held a Component, 46 to 71 an update, 50
    // to 73 a question and 99 to 123 a levelled grant. The floors sit far
    // enough below that no seed trips them, which a floor near the mean would.
    expect(seen.accepted, `seed ${seed}`).toBe(200)
    for (const shape of ['component', 'update', 'question'] as const) {
      expect(seen[shape], `${shape}, seed ${seed}`).toBeGreaterThan(20)
    }
    expect(seen.grant, `seed ${seed}`).toBeGreaterThan(50)
    expect([...classes].sort(), `seed ${seed}`).toEqual([
      'derived',
      'echoed',
      'enumerated',
      'novel',
    ])
  })

  it('every path a signature produces stays inside the repository', () => {
    const { seen, count } = counted()
    let paths = 0
    const seed = freshSeed()
    fc.assert(
      fc.property(arbitraryValidPlan, fc.constantFrom('words', 'answers'), (draft, by) => {
        const parsed = planSchema.safeParse(draft)
        expect(parsed.success).toBe(true)
        if (!parsed.success) return
        const result = signPlan(parsed.data, signatureContext, provenanceOf(parsed.data, by))
        fc.pre(!('outcome' in result))
        if ('outcome' in result) return
        count(parsed.data)
        for (const produced of result.paths.values()) {
          paths += 1
          expect(assertInsideRepo('/repo', produced).startsWith('/repo/')).toBe(true)
        }
      }),
      { numRuns: 200, seed },
    )
    expect(seen.accepted, `seed ${seed}`).toBe(200)
    // Every creation of a Resource whose name and type were vouched for is
    // given a path: 259 to 293 of them over the same 25 runs, and none before
    // (tests-3).
    expect(paths, `seed ${seed}`).toBeGreaterThan(150)
  })

  it('every computed path stays inside the repository', () => {
    fc.assert(
      fc.property(arbitraryEntity, (entity) => {
        const resolved = assertInsideRepo('/repo', resolveEntityPath(entity))
        expect(resolved.startsWith('/repo/')).toBe(true)
      }),
    )
  })

  /**
   * A plan and the one hand-written file it runs against. A creation meets the
   * file at the path the engine computes for it — elsewhere, it only ever
   * wrote new files, and "applying twice" was proven over bytes nobody wrote
   * by hand (gap-stage5-readiness-11). An update meets it as the file
   * declaring the grant it amends, in whatever shape that grant was written.
   */
  const scenario = fc.oneof(
    fc.record({ plan: arbitraryValidPlan, file: arbitraryHandWrittenFile }),
    fc
      .record({ file: handWrittenAround(arbitraryHandWrittenGrant), consumer: entityName })
      .map(({ file, consumer }) => ({
        plan: {
          intent: `let component:default/${consumer} use resource:default/${file.target.name}`,
          operations: [
            {
              op: 'update-entity' as const,
              entityRef: `resource:default/${file.target.name}`,
              patch: {
                patch: 'add-dependency-of' as const,
                consumer: `component:default/${consumer}`,
                ...(file.target.level === undefined ? {} : { access: file.target.level }),
              },
            },
          ],
        },
        file: file.text,
      })),
  )

  it('applying a plan twice leaves the bytes applying it once left (§9.2)', () => {
    let exercised = 0
    let effected = 0
    let created = 0
    let amended = 0
    const seed = freshSeed()
    fc.assert(
      fc.property(scenario, ({ plan: raw, file }) => {
        const parsed = planSchema.safeParse(raw)
        expect(parsed.success).toBe(true)
        if (!parsed.success) return
        // The person confirms every value the draft wrote, at its field: a
        // question left in a plan is dropped, and a plan of questions writes
        // nothing twice as easily as once.
        const signed = signPlan(parsed.data, signatureContext, provenanceOf(parsed.data, 'answers'))
        fc.pre(!('outcome' in signed))
        if ('outcome' in signed) return

        const at = fileAt(signed)
        const base = new Map([[at, file]])
        const first = planEdits(signed, base)
        const once = applyEdits(base, first.edits)
        const second = planEdits(signed, once)

        if (first.edits.some((edit) => edit.before !== edit.after)) exercised += 1
        // The file's own edit, when it held a document: an insertion when the
        // plan files something there, an amendment when only an update could.
        const own = first.edits.find((edit) => edit.path === at && edit.before !== edit.after)
        if (own !== undefined && refsIn(file).length > 0) {
          if (signed.paths.size > 0) created += 1
          else amended += 1
        }
        for (const edit of second.edits) expect(edit.after).toBe(edit.before)
        expect([...applyEdits(once, second.edits)]).toEqual([...once])

        // And the second pass is a no-op because the work is DONE, not
        // because nothing happened: the re-check reads every operation as
        // already declared in the bytes the first pass left
        // (gap-stage5-readiness-11). Over a plan every operation of which
        // produced bytes, and whose references the file does not already
        // declare — a duplicate is the re-check's refusal, not this property.
        const fileRefs = new Set(refsIn(file))
        if (
          first.dropped.length === 0 &&
          ![...signed.refs.values()].some((ref) => fileRefs.has(ref))
        ) {
          effected += 1
          const recheck = recheckPlan(signed, snapshotOf(once), second.edits)
          for (const index of signed.plan.operations.keys()) {
            expect(recheck.outcomes.get(index)).toBe('already-declared')
          }
        }
      }),
      { numRuns: 400, seed },
    )
    // A property that never saw a change has proven nothing about one, nor
    // one that never met a file somebody wrote. Measured over 15 runs: 293 to
    // 326 of 400 exercised, 256 to 294 re-checked, 91 to 125 creations
    // inserted beside a hand-written document and 146 to 182 hand-written
    // grants amended. `created` was 0 while the file sat at a path no plan
    // writes to: every creation went into a new file.
    expect(exercised, `seed ${seed}`).toBeGreaterThan(200)
    expect(effected, `seed ${seed}`).toBeGreaterThan(100)
    expect(created, `seed ${seed}`).toBeGreaterThan(50)
    expect(amended, `seed ${seed}`).toBeGreaterThan(50)
  })
})

/**
 * The generators, asserted on rather than assumed.
 *
 * A generator that never produces a field makes every property over it vacuous:
 * "serialise then reload yields the same entity" holds just as well for a
 * serialiser that drops `spec.access` on the floor, and "every leaf of a signed
 * plan is classified" for a signer that never saw one. §4.1 added the field, so
 * the generators have to carry it, and this is what says they do.
 *
 * Sampled at a fixed seed because the coverage IS the assertion — a property
 * would be asserting the same silence. What this does NOT assert is a
 * distribution: how often fast-check reaches a level is its business, and one
 * in a sample is all it takes to stop a property being vacuous.
 */
describe('the generators cover the level a grant states', { timeout: PROPERTY_TIMEOUT }, () => {
  it('puts one on a right and never on an object', () => {
    const sample = fc.sample(arbitraryEntity, { numRuns: 200, seed: 1 })

    // The nature rule lives in `resourceSchema.superRefine`, so an entity
    // generated with a level on a database is one the tool cannot hold — and
    // every property above it would be asserting something about a shape that
    // never reaches disk.
    for (const entity of sample) expect(entitySchema.safeParse(entity).success).toBe(true)

    expect(
      sample.some((entity) => entity.kind === 'Resource' && entity.spec.access !== undefined),
    ).toBe(true)
    // Both halves of the optionality, or the generator covers one shape and
    // calls it the field: an access written before this field exists states no
    // level, and that is the common case in a real repository.
    expect(
      sample.some((entity) => entity.kind === 'Resource' && entity.spec.access === undefined),
    ).toBe(true)
  })

  it('lets a proposal state one, or say it cannot determine it', () => {
    // Over plans the schema accepts, which is what every property over a plan
    // meets: sampling a generator most of whose output the schema refuses
    // measured shapes no property ever saw (tests-3).
    const levels = fc.sample(arbitraryValidPlan, { numRuns: 200, seed: 1 }).flatMap((draft) =>
      planSchema.parse(draft).operations.map((operation) =>
        operation.op === 'update-entity'
          ? operation.patch.access
          : operation.entity.kind === 'Resource'
            ? operation.entity.spec.access
            : undefined,
      ),
    )

    expect(levels.some((level) => level === 'read' || level === 'readwrite')).toBe(true)
    // §5.4: a field the model CHOOSES is a value or `{unknown}`, and this is
    // the one where filling in a plausible value hands out write. A generator
    // that only ever states a level never signs the question.
    expect(
      levels.some(
        (level) => typeof level === 'object' && level !== null && 'unknown' in level,
      ),
    ).toBe(true)
  })
})

/**
 * The hand-written files, asserted on for the same reason: a trait the
 * generator never draws is a shape every property above holds for vacuously.
 * It drew one shape — `---`, two spaces, LF, no mark — until core-yaml-6, and
 * a surgery that dropped a byte-order mark or rewrote CRLF as LF passed every
 * byte-for-byte property there was.
 *
 * Read in the text, not in the model the file was built from: what a property
 * meets is the bytes. And every file parses — a file that does not is not a
 * catalogue file, and a property over one would be about the parser.
 */
describe('the hand-written files come in every shape', { timeout: PROPERTY_TIMEOUT }, () => {
  const sample = fc.sample(arbitraryHandWrittenFile, { numRuns: 300, seed: 1 })
  const lines = (file: string): string[] => file.replace(/^\uFEFF/, '').split(/\r?\n/)
  // What `arbitraries.ts` writes after a key, and nowhere else.
  const NOTE_ENDS = [
    'identity',
    'do not rename',
    'set by hand',
    'the service',
    'the grant',
    'who reads it',
    'nobody yet',
  ].map((note) => ` # ${note}`)

  it('each of which the parser reads', () => {
    for (const file of sample) {
      expect(readDocuments(file).filter((reading) => 'error' in reading)).toEqual([])
    }
  })

  const traits: [string, (file: string) => boolean][] = [
    ['a byte-order mark', (file) => file.startsWith('\uFEFF')],
    ['CRLF line endings', (file) => file.includes('\r\n')],
    ['LF line endings', (file) => file.includes('\n') && !file.includes('\r\n')],
    [
      'a first document with no marker',
      (file) => /^(?:apiVersion|kind):/.test(lines(file).find((line) => /^[^\s#]/.test(line)) ?? ''),
    ],
    ['a comment opening the file', (file) => lines(file)[0] === '# declared by hand, kept by hand'],
    [
      'a comment introducing a document',
      (file) => lines(file).some((line) => line.startsWith('# hand written note about ')),
    ],
    ['two blank lines between documents', (file) => /\r?\n\r?\n\r?\n(?:#.*\r?\n)?---/.test(file)],
    ['a document end marker', (file) => lines(file).includes('...')],
    // Anchored on the line only its trait writes: a nested line of a two-space
    // document sits at four spaces too, and a guard it satisfies is no guard.
    ['four-space indentation', (file) => lines(file).some((line) => /^ {4}name:/.test(line))],
    ['two-space indentation', (file) => lines(file).some((line) => /^ {2}name:/.test(line))],
    ['keys in another order', (file) => lines(file).some((line) => line.startsWith('kind:'))],
    ['a name in single quotes', (file) => /name: '/.test(file)],
    ['a name in double quotes', (file) => /name: "/.test(file)],
    // The generator's own notes, at the end of a key's line: the literal block
    // holds a line that reads as a comment, and it is text.
    [
      'a comment trailing a key',
      (file) =>
        lines(file).some((line) => /\S # /.test(line) && NOTE_ENDS.some((end) => line.endsWith(end))),
    ],
    [
      'a comment at column zero inside a spec',
      (file) => lines(file).includes('# owner below, reviewed by tiger'),
    ],
    ['an anchor and its alias', (file) => file.includes('&team') && file.includes('*team')],
    ['a flow mapping', (file) => file.includes('annotations: {')],
    ['a literal block', (file) => file.includes('description: |')],
    ['a flow sequence of consumers', (file) => /dependencyOf: \[\S/.test(file)],
    ['an empty flow sequence', (file) => file.includes('dependencyOf: []')],
    [
      'consumers at the indentation of their key',
      (file) =>
        lines(file).some((line, index, all) => {
          const key = /^( +)dependencyOf:(?: #.*)?$/.exec(line)
          return key !== null && (all[index + 1] ?? '').startsWith(`${key[1] ?? ''}- `)
        }),
    ],
    ['a Component', (file) => file.includes('kind: Component')],
    ['a grant stating its level', (file) => /access: (?:read|readwrite)\b/.test(file)],
    ['a last line ending in a line break', (file) => file.endsWith('\n')],
    ['a last line with no line break', (file) => file !== '' && !file.endsWith('\n')],
    ['more than one document', (file) => (file.match(/^---/gm) ?? []).length > 1],
    [
      'no document at all',
      (file) => readDocuments(file).every((reading) => 'value' in reading && reading.value == null),
    ],
  ]

  it.each(traits)('with %s among them', (_, holds) => {
    expect(sample.some(holds)).toBe(true)
  })
})
