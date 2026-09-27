import { describe, expect, it } from 'vitest'
import { VERSION } from '../../src/core/index.js'


describe('the version the scaffold pins', () => {
  it('matches the one the package publishes', async () => {
    // The generated workflow runs `npx idp-agent@<VERSION> validate .`. Two
    // sources of truth for that number means a scaffolded repository can pin
    // a version nobody ever published, and its CI is red forever.
    const { readFile } = await import('node:fs/promises')
    const path = await import('node:path')
    const manifest = JSON.parse(
      await readFile(
        path.resolve(import.meta.dirname, '../../package.json'),
        'utf8',
      ),
    ) as { version: string }
    expect(VERSION).toBe(manifest.version)
  })

  it('is not one npm has already burned', () => {
    // A version published once can never be published again, withdrawn or
    // not. `0.1.0-rc.1` was published and unpublished the same day
    // (CHANGELOG), so a repository scaffolded while the package still said so
    // pinned a version no registry will ever serve (review, build-ci-5).
    const BURNED = ['0.1.0-rc.1']
    expect(BURNED).not.toContain(VERSION)
  })
})
