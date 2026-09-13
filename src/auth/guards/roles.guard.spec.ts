import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '../../contracts/index.js';
import { AuthenticatedUser } from '../types/jwt-payload.js';
import { RolesGuard } from './roles.guard.js';

const contextFor = (user?: AuthenticatedUser): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  }) as unknown as ExecutionContext;

const userWith = (...roles: Role[]): AuthenticatedUser => ({
  id: '507f1f77bcf86cd799439011',
  email: 'ada@example.com',
  roles,
});

describe('RolesGuard', () => {
  let reflector: Reflector;
  let guard: RolesGuard;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RolesGuard(reflector);
  });

  const requireRoles = (roles: Role[] | undefined) =>
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(roles);

  it('allows a route with no @Roles metadata', () => {
    requireRoles(undefined);

    expect(guard.canActivate(contextFor(userWith(Role.CITIZEN)))).toBe(true);
  });

  it('allows a route whose @Roles list is empty', () => {
    requireRoles([]);

    expect(guard.canActivate(contextFor(userWith(Role.CITIZEN)))).toBe(true);
  });

  it('allows a caller holding the single required role', () => {
    requireRoles([Role.AGENCY]);

    expect(guard.canActivate(contextFor(userWith(Role.AGENCY)))).toBe(true);
  });

  it('allows a multi-role caller matching one of two required roles', () => {
    requireRoles([Role.AGENCY, Role.SPONSOR]);

    expect(
      guard.canActivate(contextFor(userWith(Role.CITIZEN, Role.SPONSOR))),
    ).toBe(true);
  });

  it('denies a caller with no overlapping role', () => {
    requireRoles([Role.ADMIN]);

    expect(guard.canActivate(contextFor(userWith(Role.CITIZEN)))).toBe(false);
  });

  it('denies when there is no authenticated user', () => {
    requireRoles([Role.ADMIN]);

    expect(guard.canActivate(contextFor(undefined))).toBe(false);
  });
});
