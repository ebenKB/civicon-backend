import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // PasswordService exercises bcrypt at cost factor 12, measured at ~1.2s per
    // operation. Under parallel load those specs exceed vitest's 5s default and
    // fail intermittently — a scheduling problem that reads as a logic bug.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
