import { defineConfig } from 'vitest/config'
import { enterRunDirectory } from './tests/setup/tmp.ts'

// Here, while the config loads, and not in the global setup: vitest chooses
// its own temp directory before any global setup runs (tests/setup/tmp.ts).
enterRunDirectory()

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Removes the run's temp directory, with everything the tests left in it.
    globalSetup: ['tests/setup/tmp.ts'],
    // The network is blocked for the whole suite, recording excepted, and the
    // developer's own IDP_REPO and personal configuration are out of reach.
    setupFiles: ['tests/setup/offline.ts', 'tests/setup/personal.ts'],
  },
})
