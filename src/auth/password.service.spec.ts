import { Test, TestingModule } from '@nestjs/testing';
import { PasswordService } from './password.service.js';

describe('PasswordService', () => {
  let service: PasswordService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PasswordService],
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
