import path from 'node:path'
import { defineConfig } from 'vitest/config'
import { enterRunDirectory } from '../../tests/setup/tmp.ts'

// The oracle of docs/audit-report.md, run in place and never by `pnpm test`:
// every test here asserts a defect, so a closed one fails.
//
//   pnpm vitest run --config docs/audit-attacks/vitest.config.ts
//
// The suite's own setup, so the attacks run as offline, as blind to the
// contributor's shell and as tidy of the temp directory as the tests do.
enterRunDirectory()

export default defineConfig({
  root: path.resolve(import.meta.dirname, '../..'),
  test: {
    include: ['docs/audit-attacks/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tests/setup/tmp.ts'],
    setupFiles: ['tests/setup/shell.ts', 'tests/setup/offline.ts', 'tests/setup/personal.ts'],
  },
})
