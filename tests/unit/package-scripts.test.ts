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

describe('pnpm demo:github', () => {
  // idpa protection's three answers against the fake gh (stage 6 plan, Task
  // 6.1.3): no GitHub, no gh, no ssh, no model. The fake is TypeScript run by
  // Node's type stripping, as the Backstage demo's is, so it refuses and the
  // smoke skips it where Node cannot run it.
  const smoke = readFileSync(path.join(ROOT, 'scripts/smoke.mjs'), 'utf8')
  const demo = readFileSync(path.join(ROOT, 'scripts/demo-github.mjs'), 'utf8')

  it('is the script, and the smoke runs it', () => {
    expect(scripts['demo:github']).toBe('node scripts/demo-github.mjs')
    expect(smoke).toContain("'scripts/demo-github.mjs'")
  })

  it('both branches are wired: the demo refuses, the smoke skips and goes on', () => {
    expect(demo).toMatch(/strippingRefusal\(\)/)
    expect(smoke).toContain('skipped pnpm demo:github: ')
  })

  it('hands what it runs no GitHub token, and puts its own gh and ssh first on PATH', () => {
    expect(demo).toMatch(/delete environment\['GH_TOKEN'\]/)
    expect(demo).toMatch(/delete environment\['GITHUB_TOKEN'\]/)
    // Each start of the fake counted, so the --local step can say gh never started (6.2.2).
    expect(demo).toMatch(
      /program\(\s*'gh',\s*`echo started >> "\$\{CALLS\}"\\nexec "\$\{process\.execPath\}" --disable-warning=ExperimentalWarning "\$\{path\.join\(ROOT, 'tools\/fake-gh\.ts'\)\}" "\$@"`,?\s*\)/,
    )
    expect(demo).toMatch(/program\('ssh', /)
    expect(demo).toMatch(/PATH: `\$\{BIN_DIR\}\$\{path\.delimiter\}/)
    expect(demo).toMatch(/GH_CONFIG_DIR: path\.join\(scratch, /)
  })

  it('pushes only to a bare repository of its own, through a fake ssh it names', () => {
    // The two variables of § 5 git keeps, given back after every GIT_* was removed.
    expect(demo).toMatch(/GIT_SSH_COMMAND: SSH,/)
    expect(demo).toMatch(/GIT_SSH_VARIANT: 'simple',/)
    expect(demo).toMatch(/exec git receive-pack '\$\{BARE\}'/)
    expect(demo).toMatch(/const BARE = path\.join\(scratch, /)
  })

  it('pushes nothing where this machine\'s git rewrites github.com, read as the binary\'s git reads it', () => {
    // A system file with `url."https://github.com/".insteadOf git@github.com:`
    // would send the push, and the machine's credential helper, to the real
    // GitHub: the launcher removes every GIT_*, so GIT_CONFIG_NOSYSTEM too.
    expect(demo).toMatch(/'remote', 'get-url', '--push', 'origin'/)
    expect(demo).toMatch(/!\/\^GIT_\/i\.test\(name\)/)
    expect(demo).toContain("!== 'git@github.com:acme/iac.git'")
    expect(demo.indexOf("'get-url', '--push'")).toBeLessThan(demo.indexOf("step('1."))
  })

  it('removes its scratch directory however it ends', () => {
    expect(demo).toMatch(/process\.on\('exit', \(\) => rmSync\(scratch, \{ recursive: true, force: true \}\)\)/)
  })

  it('and the smoke hands the binary a guard gh and ssh, a HOME and a gh folder of its own, and no GitHub variable', () => {
    expect(smoke).toMatch(/for \(const program of \['gh', 'ssh'\]\)/)
    expect(smoke).toMatch(/PATH: `\$\{GUARD\}\$\{path\.delimiter\}/)
    expect(smoke).toMatch(/HOME: path\.join\(INSTALLED, 'home'\)/)
    expect(smoke).toMatch(/GH_CONFIG_DIR: path\.join\(INSTALLED, 'gh-config'\)/)
    expect(smoke).toContain("const REACHES_OUT = /^(?:IDP_|GH_|GITHUB_)|_API_KEY$|^SSH_AUTH_SOCK$|^SSH_ASKPASS$/i")
  })
})
