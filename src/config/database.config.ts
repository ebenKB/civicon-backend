import { ConfigService } from '@nestjs/config';

/**
 * Builds the Mongo connection string.
 *
 * `MONGODB_URI` wins when set, for hosted deployments (Atlas, replica sets)
 * where the URI is issued as a whole. Otherwise the URI is composed from the
 * same MONGO_* variables that docker-compose provisions the container with, so
 * changing a password or port in one place cannot leave a stale URI behind.
 */
export function buildMongoUri(config: ConfigService): string {
  const explicitUri = config.get<string>('MONGODB_URI');
  if (explicitUri) {
    return explicitUri;
  }

  const username = config.get<string>('MONGO_ROOT_USERNAME');
  const password = config.get<string>('MONGO_ROOT_PASSWORD');
  const host = config.get<string>('MONGO_HOST') ?? 'localhost';
  const port = config.get<string>('MONGO_PORT') ?? '27017';
  const database = config.get<string>('MONGO_DATABASE') ?? 'civicon';
  const authSource = config.get<string>('MONGO_AUTH_SOURCE') ?? 'admin';

  // Credentials are percent-encoded: passwords routinely contain characters
  // (@ : / ?) that would otherwise break the URI.
  const credentials =
    username && password
      ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
      : '';

  const query = credentials
    ? `?authSource=${encodeURIComponent(authSource)}`
    : '';

  return `mongodb://${credentials}${host}:${port}/${database}${query}`;
}
