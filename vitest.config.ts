import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@shared': here('./src/shared'),
      '@renderer': here('./src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    // The integration test spawns the native helper and plays a 4 s tone.
    testTimeout: 30000,
    hookTimeout: 30000,
    teardownTimeout: 10000
  }
})
