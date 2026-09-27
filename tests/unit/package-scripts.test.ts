import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * What gets packed is what the build left in dist/, and `tsc` never deletes:
 * a module removed from src/ stayed compiled, and a probe dropped into dist/
 * by hand, `__before_probe.js`, was packed (review, build-ci-3). `pnpm smoke`
 * checks the tarball it packs; this checks the two scripts that decide what is
 * in it.
 */

const ROOT = path.resolve(import.meta.dirname, '../..')
const { scripts } = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}

describe('the scripts that make the package', () => {
  it('build empties dist/ before compiling into it', () => {
    const [clean, compile] = (scripts['build'] ?? '').split(' && ')
    expect(clean).toMatch(/rmSync\('dist'/)
    expect(compile).toMatch(/^tsc -p tsconfig\.build\.json$/)
  })

  it('packing runs what CI runs after the install, the build before the smoke', () => {
    // npm and pnpm both run `prepack` before `pack` and `publish`. rc.1 was
    // published by hand, and nothing ran before it but whoever remembered to.
    expect(scripts['prepack']).toBe('pnpm typecheck && pnpm test && pnpm build && pnpm smoke')
  })
})
