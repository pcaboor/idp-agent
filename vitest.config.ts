import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The network is blocked for the whole suite, recording excepted.
    setupFiles: ['tests/setup/offline.ts'],
  },
})
