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
    env: {
      // bcrypt at the production cost of 12 is ~1.2s per call on a laptop,
      // which made the auth specs exceed vitest's default timeout under
      // parallel load. The cost is encoded in each hash, so lowering it here
      // changes only how long the tests take, never what they prove.
      BCRYPT_COST: '4',
    },
  },
});
