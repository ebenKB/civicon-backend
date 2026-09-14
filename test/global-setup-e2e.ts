import mongoose from 'mongoose';
import { adminUri, runDatabasePrefix } from './e2e-env.js';

/**
 * Vitest's global setup file. It exports `teardown` rather than being a
 * `globalTeardown` entry — that option is Jest's, and vitest silently ignores
 * unknown keys, so naming it wrongly leaves databases behind with no error.
 *
 * Drops every database this run created. Each worker makes its own, and the
 * names carry the run's process id, so this cannot touch a concurrent run's
 * databases or the development one.
 */
export async function teardown(): Promise<void> {
  const prefix = runDatabasePrefix();
  if (!prefix) {
    return;
  }

  const connection = await mongoose.createConnection(adminUri()).asPromise();
  try {
    const { databases } = (await connection
      .getClient()
      .db('admin')
      .admin()
      .listDatabases()) as { databases: { name: string }[] };

    for (const { name } of databases) {
      if (name.startsWith(prefix)) {
        await connection.getClient().db(name).dropDatabase();
      }
    }
  } finally {
    await connection.destroy();
  }
}
