import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A document that names a function, a type or a constant in backticks is read
 * as naming code that exists. `withAnswers` and `proposeTool` were both named
 * long after they were renamed or removed, and a reader who searched for them
 * found nothing. So every identifier the living documents put in backticks —
 * camelCase, PascalCase with a second capital, or CONSTANT_CASE — must occur
 * in `src/` or `scripts/`, or be listed below with the reason it is not ours.
 *
 * The living documents are the ones that describe the code as it is. The
 * reviews, plans, audits and ADRs are dated records and name what was there
 * when they were written.
 */

const ROOT = path.resolve(import.meta.dirname, '../..')

const files = (dir: string, keep: (name: string) => boolean): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return files(full, keep)
    return keep(entry.name) ? [full] : []
  })

const DOCUMENTS = [
  'README.md',
  'AGENTS.md',
  'SECURITY.md',
  'examples/README.md',
  'docs/design.md',
  'docs/tracing-design.md',
  ...files(path.join(ROOT, 'src'), (name) => name === 'README.md').map((file) =>
    path.relative(ROOT, file),
  ),
]

const code = [
  ...files(path.join(ROOT, 'src'), (name) => name.endsWith('.ts')),
  ...files(path.join(ROOT, 'scripts'), (name) => /\.[cm]?js$/.test(name)),
]
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n')

/** Named in backticks and deliberately not in the code, each with why. */
const NOT_OURS = new Map([
  ['ANTHROPIC_BASE_URL', "the Anthropic SDK's own variable"],
  ['OPENAI_BASE_URL', "the OpenAI SDK's own variable"],
  ['ExportTraceServiceRequest', "OTLP's message, which the MLflow sink sends"],
  ['WebSocket', "Node's global, which the suite's offline setup blocks"],
])

const IDENTIFIER =
  /`([a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|[A-Z][A-Z0-9]*_[A-Z0-9_]+)(?:\(\))?`/g

const named = DOCUMENTS.flatMap((document) =>
  [...readFileSync(path.join(ROOT, document), 'utf8').matchAll(IDENTIFIER)].map((match) => ({
    document,
    identifier: match[1]!,
  })),
)

const inCode = (identifier: string): boolean =>
  new RegExp(`\\b${identifier}\\b`).test(code)

describe('the identifiers the documents name in backticks', () => {
  it('are there to check', () => {
    expect(named.length).toBeGreaterThan(100)
  })

  it('each occur in src/ or scripts/', () => {
    const missing = named
      .filter(({ identifier }) => !NOT_OURS.has(identifier) && !inCode(identifier))
      .map(({ document, identifier }) => `${document}: ${identifier}`)
    expect([...new Set(missing)]).toEqual([])
  })

  it('leave out only what is not ours, each of which a document still names', () => {
    for (const identifier of NOT_OURS.keys()) {
      expect(inCode(identifier), `${identifier} is in the code now`).toBe(false)
      expect(
        named.some((entry) => entry.identifier === identifier),
        `${identifier} is no longer named`,
      ).toBe(true)
    }
  })
})
