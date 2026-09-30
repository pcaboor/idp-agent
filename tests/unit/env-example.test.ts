import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BACKSTAGE_URL_VARIABLE, REPO_VARIABLE } from '../../src/cli/source.js'
import { BACKSTAGE_TOKEN_VARIABLE } from '../../src/context/backstage/transport.js'
import { KEY_VARIABLES, PROVIDER_NAMES } from '../../src/llm/providers.js'

/**
 * `.env.example` is the list a newcomer configures from, so it is held to the
 * code rather than to anyone's memory: every variable `src/` or `scripts/`
 * reads is in it, and every variable in it is read — by one of those, or by
 * the provider SDK the adapters are built on. A variable added to the code without a line there,
 * or a line left behind for one nobody reads any more, fails here.
 */

const ROOT = path.resolve(import.meta.dirname, '../..')
const SRC = path.join(ROOT, 'src')
const SCRIPTS = path.join(ROOT, 'scripts')

/**
 * Read by the code and deliberately not in `.env.example`: the system's own
 * conventions, which nobody sets for this tool. The file's header names them.
 * Each must still be read, so this list cannot outlive the code that needed it.
 */
const THE_SYSTEMS = new Map([
  ['HOME', 'where ~ expands, and where the personal config.yml is'],
  ['USERPROFILE', 'HOME on Windows'],
  ['APPDATA', 'where the personal config.yml is on Windows'],
  ['XDG_CONFIG_HOME', 'where the personal config.yml is first looked for'],
  ['XDG_CACHE_HOME', 'where a catalogue read is kept, first looked for'],
  ['NO_COLOR', 'whether a diff is painted'],
  ['FORCE_COLOR', 'whether a diff is painted'],
  ['PATH', "where pnpm smoke and pnpm demo:github put their guard gh and ssh, and the demo's fake gh, first"],
])

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sources(full)
    return /\.(?:ts|[cm]?js)$/.test(entry.name) ? [full] : []
  })

/** `src/`, and the scripts `pnpm demo`, `pnpm smoke` and the trace tools run. */
const code = [...sources(SRC), ...sources(SCRIPTS)].map((file) => readFileSync(file, 'utf8'))

/** `env['NAME']`, `env["NAME"]` and `env.NAME`, `process.env` included, across both. */
const readByName = new Set(
  code.flatMap((text) => [
    ...[...text.matchAll(/\benv\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g)].map((match) => match[1]!),
    ...[...text.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)].map((match) => match[1]!),
  ]),
)

/**
 * `env[something]` with a computed index. Each is known here and resolved to
 * the names it can hold; a new one fails the test until it is, rather than
 * slipping past a search for string literals.
 */
const computed = new Set(
  code.flatMap((text) =>
    [...text.matchAll(/\benv\[\s*([A-Za-z_][\w.]*)\s*\]/g)].map((match) => match[1]!),
  ),
)
const COMPUTED: Record<string, readonly string[]> = {
  key: PROVIDER_NAMES.map((provider) => KEY_VARIABLES[provider]),
  REPO_VARIABLE: [REPO_VARIABLE],
  // The catalogue's URL, in `cli/source.ts`; its token's presence there, and
  // its value in `cli/index.ts`, the one place it is read.
  BACKSTAGE_URL_VARIABLE: [BACKSTAGE_URL_VARIABLE],
  BACKSTAGE_TOKEN_VARIABLE: [BACKSTAGE_TOKEN_VARIABLE],
}

/** What each adapter's SDK reads from the environment on its own. */
const require = createRequire(import.meta.url)
const readBySdk = new Set(
  PROVIDER_NAMES.flatMap((provider) => {
    const dist = path.join(path.dirname(require.resolve(`@ai-sdk/${provider}/package.json`)), 'dist')
    const names = readdirSync(dist, { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.[cm]?js$/.test(file))
      .flatMap((file) =>
        [...readFileSync(path.join(dist, file), 'utf8').matchAll(/environmentVariableName: *"([A-Z_]+)"/g)].map(
          (match) => match[1]!,
        ),
      )
    // Not vacuous: every adapter reads its key this way, so a search that
    // finds nothing has lost the files, not the variables.
    if (!names.includes(KEY_VARIABLES[provider])) {
      throw new Error(`found no environment read in @ai-sdk/${provider}'s dist; its layout moved`)
    }
    return names
  }),
)

const example = readFileSync(path.join(ROOT, '.env.example'), 'utf8')
/** Each `NAME=` line, commented out or not. */
const assignments = [...example.matchAll(/^(?:# )?([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((match) => ({
  name: match[1]!,
  value: match[2]!,
}))
const listed = new Set(assignments.map(({ name }) => name))

describe('.env.example', () => {
  it('knows every computed env[...] read in src/ and scripts/', () => {
    expect([...computed].sort()).toEqual(Object.keys(COMPUTED).sort())
  })

  it('finds no read it cannot name: no destructuring of an environment', () => {
    // `const { IDP_X } = process.env` names a variable the searches above miss.
    for (const text of code) {
      expect(text).not.toMatch(/\{[^}]*\}\s*=\s*(?:process\.)?env\b/)
    }
  })

  it('lists every variable the code or its model SDK reads, and nothing else', () => {
    const read = new Set([...readByName, ...Object.values(COMPUTED).flat(), ...readBySdk])
    const expected = [...read].filter((name) => !THE_SYSTEMS.has(name)).sort()
    expect([...listed].sort()).toEqual(expected)
  })

  it("leaves out only the system's own variables, each of which the code does read", () => {
    for (const name of THE_SYSTEMS.keys()) {
      expect(readByName.has(name), `${name} is no longer read`).toBe(true)
      expect(listed.has(name), `${name} is the system's`).toBe(false)
    }
  })

  it('lists each variable once', () => {
    expect(assignments.length).toBe(listed.size)
  })

  it('names every key variable, and holds no value for any of them', () => {
    for (const variable of Object.values(KEY_VARIABLES)) {
      expect(assignments.find(({ name }) => name === variable)?.value).toBe('')
    }
  })

  it('holds nothing that looks like a secret', () => {
    for (const { name, value } of assignments) {
      expect(value, name).not.toMatch(/[A-Za-z0-9_-]{24,}/)
    }
  })

  it('is the one .env file git keeps: .env itself is ignored', () => {
    const ignored = readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split('\n')
    expect(ignored).toContain('.env')
    expect(ignored).toContain('.env.*')
    expect(ignored).toContain('!.env.example')
  })
})
