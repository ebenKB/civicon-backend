import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator.js';
import { JwtPayload } from '../types/jwt-payload.js';
import { RequestWithUser } from '../types/request-with-user.js';

/**
 * Registered globally so the default is deny. A route added in a later phase
 * that forgets its guard fails closed with a 401 rather than shipping open.
 *
 * Roles are read from the token claims, so this costs no database round-trip.
 * GET /auth/me exists for clients that need authoritative current roles.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(
      IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = this.extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException();
    }

    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token);
      request.user = {
        id: payload.sub,
        email: payload.email,
        roles: payload.roles ?? [],
      };
    } catch {
      // Expired, malformed and wrongly-signed tokens are all just "no".
      throw new UnauthorizedException();
    }

    return true;
  }

  private extractBearerToken(request: RequestWithUser): string | undefined {
    const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
    return scheme === 'Bearer' ? token : undefined;
  }
}
