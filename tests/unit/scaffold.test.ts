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
})
