import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Deliberately NOT reusing vite.config.js: that config sets root to
  // `client/` for the dev server, which would hide the test directory.
  root: '.',
  test: {
    include: ['test/**/*.test.js'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
    testTimeout: 20000,
  },
});
