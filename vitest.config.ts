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
    // The contributor's IDP_ variables and keys are set aside, the network is
    // blocked for the whole suite, a scenario being recorded excepted, and the
    // developer's own IDP_REPO and personal configuration are out of reach.
    setupFiles: ['tests/setup/shell.ts', 'tests/setup/offline.ts', 'tests/setup/personal.ts'],
    // Set before the setup files run, and removed by the first of them: what
    // `tests/unit/offline.test.ts` checks is gone, on a shell that exported
    // nothing too. Names of their own, so that a scenario being recorded —
    // which keeps the shell whole — keeps the contributor's real ones.
    env: { IDP_SET_BY_VITEST_CONFIG: 'set-aside', SET_BY_VITEST_CONFIG_API_KEY: 'set-aside' },
  },
})
