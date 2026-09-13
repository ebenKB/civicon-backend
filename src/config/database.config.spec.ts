import { ConfigService } from '@nestjs/config';
import { buildMongoUri } from './database.config.js';

const configOf = (values: Record<string, string | undefined>) =>
  ({ get: (key: string) => values[key] }) as ConfigService;

describe('buildMongoUri', () => {
  it('composes a URI from the MONGO_* parts', () => {
    const uri = buildMongoUri(
      configOf({
        MONGO_ROOT_USERNAME: 'root',
        MONGO_ROOT_PASSWORD: 'example',
        MONGO_HOST: 'localhost',
        MONGO_PORT: '27017',
        MONGO_DATABASE: 'civicon',
        MONGO_AUTH_SOURCE: 'admin',
      }),
    );

    expect(uri).toBe(
      'mongodb://root:example@localhost:27017/civicon?authSource=admin',
    );
  });

  it('prefers an explicit MONGODB_URI over the parts', () => {
    const uri = buildMongoUri(
      configOf({
        MONGODB_URI: 'mongodb://a:27017,b:27017/civicon?replicaSet=rs0',
        MONGO_DATABASE: 'ignored',
      }),
    );

    expect(uri).toBe('mongodb://a:27017,b:27017/civicon?replicaSet=rs0');
  });

  it('percent-encodes credentials containing URI metacharacters', () => {
    const uri = buildMongoUri(
      configOf({
        MONGO_ROOT_USERNAME: 'root',
        MONGO_ROOT_PASSWORD: 'p@ss:w/rd?',
        MONGO_DATABASE: 'civicon',
      }),
    );

    expect(uri).toContain('root:p%40ss%3Aw%2Frd%3F@');
  });

  it('omits credentials when none are configured', () => {
    const uri = buildMongoUri(configOf({ MONGO_DATABASE: 'civicon' }));

    expect(uri).toBe('mongodb://localhost:27017/civicon');
  });

  it('falls back to sane defaults', () => {
    expect(buildMongoUri(configOf({}))).toBe(
      'mongodb://localhost:27017/civicon',
    );
  });
});
