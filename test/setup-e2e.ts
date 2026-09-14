import { beforeAll, expect } from 'vitest';

/**
 * Gives every e2e file its own database.
 *
 * Four of the six files delete every user and two delete every issue. Sharing
 * one database made that survivable only by luck: a file's Nest app, its
 * connection pool and its in-flight work do not stop the instant the file ends,
 * so a neighbour's `deleteMany` could land between one test's create and its
 * next request — producing a 404 where a 200 was expected, intermittently and
 * with nothing in the logs to explain it.
 *
 * The name also carries the run's process id (set in vitest.config.e2e.ts), so
 * two concurrent `npm run test:e2e` invocations cannot collide either.
 *
 * This runs in a beforeAll rather than at module scope because the test file's
 * own beforeAll — where the Nest app is created, and where the configuration is
 * actually read — runs after hooks registered here.
 */
beforeAll(() => {
  const base = process.env.E2E_DATABASE_BASE;
  if (!base) {
    return;
  }

  const path = expect.getState().testPath ?? 'unknown';
  const file = (path.split('/').pop() ?? 'unknown')
    .replace(/\.e2e-spec\.ts$/, '')
    .replace(/[^a-zA-Z0-9]/g, '_');

  process.env.MONGO_DATABASE = `${base}_${file}`;
});
