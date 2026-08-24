import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Tests share no state; each file gets a scratch /data dir via test/helpers.
    pool: 'forks',
  },
});
