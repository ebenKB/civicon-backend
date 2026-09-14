import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PasswordService } from './password.service.js';

describe('PasswordService', () => {
  let service: PasswordService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PasswordService,
        {
          // Reads the real BCRYPT_COST, which vitest sets to 4. These tests are
          // about hashing behaviour, not about the work factor — the block
          // below covers that explicitly.
          provide: ConfigService,
          useValue: { get: (key: string) => process.env[key] },
        },
      ],
    }).compile();

    service = module.get<PasswordService>(PasswordService);
  });

  it('produces a hash that is not the plaintext', async () => {
    const hash = await service.hash('correct horse battery');

    expect(hash).not.toBe('correct horse battery');
    expect(hash.length).toBeGreaterThan(20);
  });

  it('salts, so the same password hashes differently each time', async () => {
    const [first, second] = await Promise.all([
      service.hash('same-password'),
      service.hash('same-password'),
    ]);

    expect(first).not.toBe(second);
  });

  it('verifies a correct password', async () => {
    const hash = await service.hash('correct horse battery');

    await expect(service.compare('correct horse battery', hash)).resolves.toBe(
      true,
    );
  });

  it('rejects a wrong password', async () => {
    const hash = await service.hash('correct horse battery');

    await expect(service.compare('wrong password', hash)).resolves.toBe(false);
  });
});

describe('PasswordService cost factor', () => {
  const serviceWith = async (bcryptCost?: string) => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PasswordService,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'BCRYPT_COST' ? bcryptCost : undefined,
          },
        },
      ],
    }).compile();
    return module.get<PasswordService>(PasswordService);
  };

  /** bcrypt encodes its cost in the hash: "$2b$12$..." */
  const costOf = (hash: string) => Number(hash.split('$')[2]);

  it('defaults to 12, which is what reaches production', async () => {
    const service = await serviceWith(undefined);

    expect(costOf(await service.hash('x'))).toBe(12);
  });

  it('honours BCRYPT_COST so tests need not pay the production cost', async () => {
    const service = await serviceWith('4');

    expect(costOf(await service.hash('x'))).toBe(4);
  });

  it('ignores a nonsensical value rather than weakening silently', async () => {
    const service = await serviceWith('not-a-number');

    expect(costOf(await service.hash('x'))).toBe(12);
  });

  it('refuses a cost below the safe floor', async () => {
    const service = await serviceWith('1');

    expect(costOf(await service.hash('x'))).toBe(12);
  });

  it('refuses a test-only low cost when NODE_ENV is not test', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const service = await serviceWith('4');

      // The override exists for test suites. Outside them the floor is 10, so
      // a stray BCRYPT_COST in a deployed .env cannot weaken hashing.
      expect(costOf(await service.hash('x'))).toBe(12);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  it('still verifies a hash made at a different cost', async () => {
    const strong = await (await serviceWith(undefined)).hash('same-password');
    const cheap = await serviceWith('4');

    // The cost lives in the hash, so existing credentials keep working.
    await expect(cheap.compare('same-password', strong)).resolves.toBe(true);
  });
});
