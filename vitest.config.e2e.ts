import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// The e2e suite truncates collections between tests, so it must never point at
// the development database. Derive a dedicated "<db>_test" database from
// MONGODB_URI and hand it to the suite via env.
function testDatabaseUri(): string {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No .env (e.g. CI supplies real env vars) — fall through to process.env.
  }

  const uri =
    process.env.MONGODB_URI ??
    'mongodb://root:example@localhost:27017/civicon?authSource=admin';

  const parsed = new URL(uri);
  const database = parsed.pathname.replace(/^\//, '') || 'civicon';
  parsed.pathname = `/${database}_test`;
  return parsed.toString();
}

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    env: {
      MONGODB_URI: testDatabaseUri(),
    },
  },
});
