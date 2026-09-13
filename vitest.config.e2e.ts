import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/**
 * The e2e suite truncates collections, so it must never point at the
 * development database.
 *
 * When the URI is composed from MONGO_* parts (the default local setup) we
 * simply redirect MONGO_DATABASE to "<db>_test". When a full MONGODB_URI is
 * supplied instead, it is not rewritten — connection strings can carry
 * multiple hosts and options that do not survive naive parsing — so an
 * explicit MONGODB_URI_TEST is required.
 */
function testEnv(): Record<string, string> {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env (e.g. CI supplies real env vars) — fall through to process.env.
  }

  if (process.env.MONGODB_URI) {
    if (!process.env.MONGODB_URI_TEST) {
      throw new Error(
        'MONGODB_URI is set, so the e2e suite cannot safely derive a test ' +
          'database from it. Set MONGODB_URI_TEST to a throwaway database ' +
          'whose name ends in "_test".',
      );
    }
    return { MONGODB_URI: process.env.MONGODB_URI_TEST };
  }

  const database = process.env.MONGO_DATABASE ?? 'civicon';
  return {
    MONGO_DATABASE: database.endsWith('_test') ? database : `${database}_test`,
  };
}

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    env: testEnv(),
  },
});
