import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { applyRoleImplications, Role } from '../contracts/index.js';
import { UserDocument } from '../users/schemas/user.schema.js';
import { PublicUser, toPublicUser } from '../users/user-response.js';
import { UsersService } from '../users/users.service.js';
import { LoginDto } from './dto/login.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { PasswordService } from './password.service.js';
import { JwtPayload } from './types/jwt-payload.js';

/**
 * One message for every failure mode. Distinguishing "no such user" from "wrong
 * password" turns the endpoint into an account-enumeration oracle.
 */
const INVALID_CREDENTIALS = 'Invalid credentials';

export interface AuthResponse {
  token: string;
  user: PublicUser;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly passwordService: PasswordService,
    private readonly jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResponse> {
    const passwordHash = await this.passwordService.hash(dto.password);

    // A duplicate email surfaces as a 409 through MongoExceptionFilter.
    const user = await this.usersService.createWithPassword({
      name: dto.name,
      email: dto.email,
      passwordHash,
      roles: applyRoleImplications(dto.roles ?? [Role.CITIZEN]),
    });

    return this.buildResponse(user);
  }

  async login(dto: LoginDto): Promise<AuthResponse> {
    const user = await this.validateCredentials(dto.email, dto.password);
    return this.buildResponse(user);
  }

  async validateCredentials(
    email: string,
    password: string,
  ): Promise<UserDocument> {
    const user = await this.usersService.findByEmailWithPassword(email);

    // The missing-hash case is not hypothetical: every user document created
    // before this module existed lacks one, and bcrypt THROWS on an undefined
    // hash rather than returning false — which would answer 500 here while an
    // unknown email answered 401, handing back exactly the account-enumeration
    // signal the single message above is meant to withhold.
    //
    // Note: returning early also skips the bcrypt compare and so is measurably
    // faster than a wrong password. Closing that timing channel needs a dummy
    // compare; out of scope here, alongside the rate limiting in the spec's
    // known gaps.
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const matches = await this.passwordService.compare(
      password,
      user.passwordHash,
    );
    // Deactivated accounts fail identically: saying "deactivated" would confirm
    // the address is registered.
    if (!matches || !user.isActive) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    return user;
  }

  /**
   * Re-reads from the database, so the roles returned are authoritative even if
   * the bearer's token was issued before an admin changed them.
   */
  async me(userId: string): Promise<PublicUser> {
    return toPublicUser(await this.usersService.findOne(userId));
  }

  private async buildResponse(user: UserDocument): Promise<AuthResponse> {
    const payload: JwtPayload = {
      sub: user._id.toString(),
      email: user.email,
      roles: user.roles,
    };

    return {
      token: await this.jwtService.signAsync(payload),
      user: toPublicUser(user),
    };
  }
}
