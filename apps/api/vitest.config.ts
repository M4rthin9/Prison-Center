import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Each file opens its own in-memory database; forks keep the module-level
    // singletons from bleeding between files.
    pool: 'forks',
    testTimeout: 20_000,
    hookTimeout: 30_000
  }
})
