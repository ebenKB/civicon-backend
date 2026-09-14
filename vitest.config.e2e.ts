import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * The e2e suites truncate collections, so they must never point at the
 * development database — and, because four of them delete every user, they must
 * not point at each other's either.
 *
 * Each run gets a base name carrying this process's id, and each worker appends
 * its own suffix in test/setup-e2e.ts. Two concurrent `npm run test:e2e`
 * invocations therefore cannot collide, and the files inside one run can go in
 * parallel. test/teardown-e2e.ts drops everything the run created.
 *
 * A full MONGODB_URI is never rewritten — connection strings carry multiple
 * hosts and options that do not survive naive parsing — so an explicit
 * MONGODB_URI_TEST is required, and isolating it is the caller's business.
 */
function testEnv(): Record<string, string> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env (e.g. CI supplies real env vars) — fall through to process.env.
  }

  const common = {
    // bcrypt at the production cost of 12 is ~1.2s per call. The cost is
    // encoded in each hash, so lowering it changes only how long these suites
    // take, never what they prove.
    BCRYPT_COST: '4',
  };

  if (process.env.MONGODB_URI) {
    if (!process.env.MONGODB_URI_TEST) {
      throw new Error(
        'MONGODB_URI is set, so the e2e suite cannot safely derive a test ' +
          'database from it. Set MONGODB_URI_TEST to a throwaway database ' +
          'whose name ends in "_test".',
      );
    }
    return { ...common, MONGODB_URI: process.env.MONGODB_URI_TEST };
  }

  const database = process.env.MONGO_DATABASE ?? 'civicon';
  const base = `${database}_test_p${process.pid.toString(36)}`;

  // `test.env` reaches the workers only. globalTeardown runs in this process,
  // so it needs the prefix set here too, or it finds nothing to drop.
  process.env.E2E_DATABASE_BASE = base;

  return {
    ...common,
    // setup-e2e.ts appends the worker id; teardown-e2e.ts drops the lot.
    E2E_DATABASE_BASE: base,
    MONGO_DATABASE: base,
  };
}

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    setupFiles: ['./test/setup-e2e.ts'],
    globalSetup: ['./test/global-setup-e2e.ts'],
    // Per-worker databases make parallel files *correct*, but not reliable
    // here: six Nest apps booting at once, each with its own Mongo pool, failed
    // about one run in six with "socket hang up". Serial costs ~7s and is
    // stable, which is the better trade. The isolation below is what matters —
    // it is what makes two concurrent `npm run test:e2e` runs safe.
    fileParallelism: false,
    // These suites wait on a real database; keep some headroom.
    hookTimeout: 60_000,
    testTimeout: 60_000,
    env: testEnv(),
  },
});
