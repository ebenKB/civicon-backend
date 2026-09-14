/**
 * Builds the Mongo URI for the e2e tooling from the same MONGO_* variables the
 * application uses. Deliberately duplicated rather than imported from
 * src/config: this runs in vitest's global setup, outside the Nest container,
 * where no ConfigService exists.
 */
export function adminUri(): string {
  const username = process.env.MONGO_ROOT_USERNAME;
  const password = process.env.MONGO_ROOT_PASSWORD;
  const host = process.env.MONGO_HOST ?? 'localhost';
  const port = process.env.MONGO_PORT ?? '27017';
  const authSource = process.env.MONGO_AUTH_SOURCE ?? 'admin';

  const credentials =
    username && password
      ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
      : '';
  const query = credentials
    ? `?authSource=${encodeURIComponent(authSource)}`
    : '';

  return `mongodb://${credentials}${host}:${port}/admin${query}`;
}

/** Every database this run may have created shares this prefix. */
export function runDatabasePrefix(): string | undefined {
  return process.env.E2E_DATABASE_BASE;
}
