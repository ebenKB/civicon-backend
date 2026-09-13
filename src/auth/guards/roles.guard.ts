import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '../../contracts/index.js';
import { ROLES_KEY } from '../decorators/roles.decorator.js';
import { RequestWithUser } from '../types/request-with-user.js';

/**
 * Registered globally after JwtAuthGuard, so `request.user` is already
 * populated. A route without @Roles needs authentication but no specific role.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!required || required.length === 0) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest<RequestWithUser>();
    if (!user) {
      return false;
    }

    // Holding ANY of the required roles is enough — a user may hold both
    // CITIZEN and VOLUNTEER, and either should satisfy a guard naming one.
    return required.some((role) => user.roles.includes(role));
  }
}
