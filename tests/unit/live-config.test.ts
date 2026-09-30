import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The live test reaches GitHub with the owner's own gh and git (stage 6 brief
 * § 10), so the default suite must never collect it: `vitest.config.ts`
 * excludes `tests/live/**`, and loads the floor under every child process.
 *
 * Read as text, never imported: importing the configuration calls
 * `enterRunDirectory()` in a worker whose pid is not the run's, which would
 * make a second run directory. 6.4.1, where the first file under `tests/live/`
 * exists, adds a listing of what vitest collects — before then the listing
 * would find nothing there whatever the configuration said.
 */

const CONFIG = path.resolve(import.meta.dirname, '../../vitest.config.ts')

describe('the default test configuration', () => {
  it('excludes tests/live/, keeping vitest’s own exclusions', async () => {
    // An `exclude` of our own replaces vitest's defaults, node_modules among
    // them, so they are spread first.
    const text = await readFile(CONFIG, 'utf8')
    expect(text).toContain("exclude: [...configDefaults.exclude, 'tests/live/**']")
    expect(text).toContain("include: ['tests/**/*.test.ts']")
  })

  it('loads the floor under every child process in every worker', async () => {
    const text = await readFile(CONFIG, 'utf8')
    const files = /setupFiles:\s*\[([^\]]*)\]/.exec(text)?.[1] ?? ''
    expect(files).toContain("'tests/setup/forge.ts'")
  })
})
