import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { Role } from '../contracts/index.js';
import { UsersService } from '../users/users.service.js';
import { AuthService } from './auth.service.js';
import { PasswordService } from './password.service.js';

/** A stand-in for a hydrated Mongoose document, with only the fields read. */
const userDoc = (overrides: Record<string, unknown> = {}) => ({
  _id: { toString: () => '507f1f77bcf86cd799439011' },
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  passwordHash: 'hashed',
  roles: [Role.CITIZEN],
  civicPointsCached: 0,
  reputation: 100,
  isActive: true,
  ...overrides,
});

describe('AuthService', () => {
  let service: AuthService;
  let usersService: {
    createWithPassword: ReturnType<typeof vi.fn>;
    findByEmailWithPassword: ReturnType<typeof vi.fn>;
  };
  let passwordService: {
    hash: ReturnType<typeof vi.fn>;
    compare: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    usersService = {
      createWithPassword: vi.fn(),
      findByEmailWithPassword: vi.fn(),
    };
    passwordService = { hash: vi.fn(), compare: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: usersService },
        { provide: PasswordService, useValue: passwordService },
        { provide: JwtService, useValue: new JwtService({ secret: 'test' }) },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  describe('register', () => {
    it('hashes the password and never stores the plaintext', async () => {
      passwordService.hash.mockResolvedValue('hashed');
      usersService.createWithPassword.mockResolvedValue(userDoc());

      await service.register({
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        password: 'super-secret',
      });

      expect(passwordService.hash).toHaveBeenCalledWith('super-secret');
      const [input] = usersService.createWithPassword.mock.calls[0];
      expect(input.passwordHash).toBe('hashed');
      expect(JSON.stringify(input)).not.toContain('super-secret');
    });

    it('always assigns CITIZEN, never a privileged role', async () => {
      passwordService.hash.mockResolvedValue('hashed');
      usersService.createWithPassword.mockResolvedValue(userDoc());

      await service.register({
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        password: 'super-secret',
      });

      const [input] = usersService.createWithPassword.mock.calls[0];
      expect(input.roles).toEqual([Role.CITIZEN]);
    });

    it('returns a token plus a sanitized user', async () => {
      passwordService.hash.mockResolvedValue('hashed');
      usersService.createWithPassword.mockResolvedValue(userDoc());

      const result = await service.register({
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        password: 'super-secret',
      });

      expect(result.token).toEqual(expect.any(String));
      expect(result.user).toEqual({
        id: '507f1f77bcf86cd799439011',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        roles: [Role.CITIZEN],
        civicPointsCached: 0,
        reputation: 100,
      });
      expect(result.user).not.toHaveProperty('passwordHash');
    });

    it('signs the roles into the token claims', async () => {
      passwordService.hash.mockResolvedValue('hashed');
      // An account an admin has since promoted: whatever roles the stored
      // document carries are what the token must assert.
      usersService.createWithPassword.mockResolvedValue(
        userDoc({ roles: [Role.AGENCY] }),
      );

      const { token } = await service.register({
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        password: 'super-secret',
      });

      const claims = new JwtService({ secret: 'test' }).verify(token);
      expect(claims.sub).toBe('507f1f77bcf86cd799439011');
      expect(claims.email).toBe('ada@example.com');
      expect(claims.roles).toEqual([Role.AGENCY]);
    });
  });

  describe('login', () => {
    it('returns a token for correct credentials', async () => {
      usersService.findByEmailWithPassword.mockResolvedValue(userDoc());
      passwordService.compare.mockResolvedValue(true);

      const result = await service.login({
        email: 'ada@example.com',
        password: 'super-secret',
      });

      expect(result.token).toEqual(expect.any(String));
      expect(result.user.email).toBe('ada@example.com');
    });

    // The three failure modes must be indistinguishable, so the endpoint
    // cannot be used to discover which email addresses are registered.
    it.each([
      [
        'unknown email',
        () => usersService.findByEmailWithPassword.mockResolvedValue(null),
      ],
      [
        'wrong password',
        () => {
          usersService.findByEmailWithPassword.mockResolvedValue(userDoc());
          passwordService.compare.mockResolvedValue(false);
        },
      ],
      [
        // Every user document predating auth is in this state, and bcrypt
        // throws on an undefined hash — which would leak a 500 here while
        // an unknown email returned 401.
        'user document carrying no password hash',
        () => {
          usersService.findByEmailWithPassword.mockResolvedValue(
            userDoc({ passwordHash: undefined }),
          );
          // Real bcrypt throws on an undefined hash rather than returning
          // false, so the mock must too or this test proves nothing.
          passwordService.compare.mockRejectedValue(
            new Error('Illegal arguments: string, undefined'),
          );
        },
      ],
      [
        'inactive account',
        () => {
          usersService.findByEmailWithPassword.mockResolvedValue(
            userDoc({ isActive: false }),
          );
          passwordService.compare.mockResolvedValue(true);
        },
      ],
    ])('rejects %s with the same message', async (_label, arrange) => {
      arrange();

      await expect(
        service.login({ email: 'ada@example.com', password: 'nope' }),
      ).rejects.toThrow(new UnauthorizedException('Invalid credentials'));
    });
  });
});
