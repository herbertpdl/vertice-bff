import { defineConfig } from 'vitest/config'

// Vitest 4 dropped `**/dist/**` from its default excludes, so pin discovery to
// the TypeScript sources and never pick up compiled output.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
})
