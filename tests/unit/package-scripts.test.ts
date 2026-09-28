import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { strippingRefusal } from '../../scripts/type-stripping.mjs'

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

describe('pnpm demo:backstage', () => {
  // The README's relations, read from a fake Backstage the script starts on a
  // loopback port the system chooses, and stops. The fake is TypeScript run by
  // Node's type stripping, which `engines` (>=22) does not promise: on a Node
  // without it the demo refuses and the smoke skips it, saying why, so `pnpm
  // smoke` and `prepack` still pass on every Node `engines` allows.
  const smoke = readFileSync(path.join(ROOT, 'scripts/smoke.mjs'), 'utf8')
  const demo = readFileSync(path.join(ROOT, 'scripts/demo-backstage.mjs'), 'utf8')

  it('is the script, and the smoke runs it', () => {
    expect(scripts['demo:backstage']).toBe('node scripts/demo-backstage.mjs')
    expect(smoke).toContain("'scripts/demo-backstage.mjs'")
  })

  it('runs where Node strips types, whether it says strip or transform', () => {
    expect(strippingRefusal({ typescript: 'strip' }, 'v22.18.0')).toBeUndefined()
    expect(strippingRefusal({ typescript: 'transform' }, 'v24.0.0')).toBeUndefined()
  })

  it('is refused where it does not: 22.10 to 22.17 without the flag, and before 22.10', () => {
    expect(strippingRefusal({ typescript: false }, 'v22.12.0')).toBe(
      'it needs Node 22.18 or later (this is v22.12.0)',
    )
    // The property does not exist before 22.10.
    expect(strippingRefusal({}, 'v22.9.0')).toBe('it needs Node 22.18 or later (this is v22.9.0)')
  })

  it('reads this process by default', () => {
    const { typescript } = process.features as { typescript?: unknown }
    expect(strippingRefusal() === undefined).toBe(Boolean(typescript))
  })

  it('both branches are wired: the demo refuses, the smoke skips and goes on', () => {
    expect(demo).toMatch(/strippingRefusal\(\)/)
    expect(smoke).toMatch(/strippingRefusal\(\)/)
    expect(smoke).toContain('skipped pnpm demo:backstage: ')
  })

  it('never hands the fake a token, and never leaves it running', () => {
    // A token exported for the company catalogue is sent to a loopback one too.
    expect(demo).toMatch(/delete [a-z]+\['IDP_BACKSTAGE_TOKEN'\]/i)
    // What proves it is the smoke, which runs the demo with a token and a URL
    // exported: a token no header can carry, so a step handed it is refused.
    expect(smoke).toMatch(/IDP_BACKSTAGE_TOKEN: DEMO_TOKEN,\s+IDP_BACKSTAGE_URL: 'https:\/\/example\.invalid\/api\/catalog'/)
    expect(demo).toContain("'--port', '0'")
    expect(demo).toMatch(/process\.on\('exit'/)
  })
})
