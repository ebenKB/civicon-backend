import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Role } from '../../contracts/index.js';
import { RequestWithUser } from '../types/request-with-user.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';

const SECRET = 'test-secret';

const contextFor = (request: Partial<RequestWithUser>): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  }) as unknown as ExecutionContext;

const bearer = (token: string) => ({
  headers: { authorization: `Bearer ${token}` },
});

describe('JwtAuthGuard', () => {
  let jwtService: JwtService;
  let reflector: Reflector;
  let guard: JwtAuthGuard;

  beforeEach(() => {
    jwtService = new JwtService({ secret: SECRET });
    reflector = new Reflector();
    guard = new JwtAuthGuard(jwtService, reflector);
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
  });

  it('populates request.user from valid token claims', async () => {
    const token = jwtService.sign({
      sub: '507f1f77bcf86cd799439011',
      email: 'ada@example.com',
      roles: [Role.CITIZEN, Role.VOLUNTEER],
    });
    const request = bearer(token) as Partial<RequestWithUser>;

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.user).toEqual({
      id: '507f1f77bcf86cd799439011',
      email: 'ada@example.com',
      roles: [Role.CITIZEN, Role.VOLUNTEER],
    });
  });

  it('allows a @Public() route with no token at all', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const request = { headers: {} } as Partial<RequestWithUser>;

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    // Public routes short-circuit before parsing, so no user is attached.
    expect(request.user).toBeUndefined();
  });

  it('rejects a request with no Authorization header', async () => {
    await expect(
      guard.canActivate(contextFor({ headers: {} })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a non-Bearer Authorization scheme', async () => {
    await expect(
      guard.canActivate(
        contextFor({ headers: { authorization: 'Basic abc' } }),
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a malformed token', async () => {
    await expect(
      guard.canActivate(contextFor(bearer('not-a-jwt'))),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a token signed with the wrong secret', async () => {
    const forged = new JwtService({ secret: 'other-secret' }).sign({
      sub: '1',
      email: 'mallory@example.com',
      roles: [Role.ADMIN],
    });

    await expect(guard.canActivate(contextFor(bearer(forged)))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects an expired token', async () => {
    const expired = jwtService.sign(
      { sub: '1', email: 'ada@example.com', roles: [Role.CITIZEN] },
      { expiresIn: '-1s' },
    );

    await expect(
      guard.canActivate(contextFor(bearer(expired))),
    ).rejects.toThrow(UnauthorizedException);
  });
});
