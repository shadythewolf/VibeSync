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
    testTimeout: 30000,
    hookTimeout: 30000,
    teardownTimeout: 10000,
    // `npm test` runs only "unit". The integration test spawns the native helper and plays
    // a 4 s 1 kHz + 8 kHz tone through the speakers, so it runs only on request
    // (npm run test:integration).
    projects: [
      { extends: true, test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] } },
      { extends: true, test: { name: 'integration', include: ['tests/integration/**/*.test.ts'] } }
    ]
  }
})
