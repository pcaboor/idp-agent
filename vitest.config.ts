import { configDefaults, defineConfig } from 'vitest/config'
import { enterRunDirectory } from './tests/setup/tmp.ts'

// Here, while the config loads, and not in the global setup: vitest chooses
// its own temp directory before any global setup runs (tests/setup/tmp.ts).
enterRunDirectory()

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Many tests start git, gh's fake or node itself, in real repositories on disk. Alone each
    // takes well under two seconds, but on a loaded laptop (a load average of 15, swap full)
    // fourteen of them once went past vitest's default of 5 s in one run and passed in the next.
    // A test that hangs still fails, after 20 s instead of 5.
    testTimeout: 20_000,
    // Removes the run's temp directory, with everything the tests left in it.
    globalSetup: ['tests/setup/tmp.ts'],
    // The live test runs under its own configuration only (vitest.live.config.ts):
    // it reaches GitHub on purpose, and nothing here may collect it.
    exclude: [...configDefaults.exclude, 'tests/live/**'],
    // The contributor's IDP_ variables and keys are set aside, the network is
    // blocked for the whole suite, a scenario being recorded excepted, the
    // developer's own IDP_REPO and personal configuration are out of reach, and
    // no child process can find its way to GitHub.
    setupFiles: ['tests/setup/shell.ts', 'tests/setup/offline.ts', 'tests/setup/personal.ts', 'tests/setup/forge.ts'],
    // Set before the setup files run, and removed by them: what
    // `tests/unit/offline.test.ts` checks is gone, on a shell that exported
    // nothing too. The first two are names of their own, so that a scenario
    // being recorded — which keeps the shell whole — keeps the contributor's
    // real ones; the last two are real names, because `forge.ts` removes them
    // from a recording shell as well.
    env: {
      IDP_SET_BY_VITEST_CONFIG: 'set-aside',
      SET_BY_VITEST_CONFIG_API_KEY: 'set-aside',
      GIT_SSH_COMMAND: 'set-aside-by-vitest-config',
      GH_TOKEN: 'set-aside-by-vitest-config',
    },
  },
})
