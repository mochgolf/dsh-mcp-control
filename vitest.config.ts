import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    // Kept here rather than on the command line, where cmd.exe would pass the quotes through.
    coverage: { include: ['src/**/*.ts'] },
  },
})
