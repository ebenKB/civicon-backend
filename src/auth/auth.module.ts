import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { PasswordService } from './password.service.js';

/**
 * The library types `expiresIn` as a template-literal union (`'7d'`, `'2h'`, …)
 * that a value read from the environment cannot satisfy at compile time. An
 * invalid string is caught at boot by the signer instead.
 */
type ExpiresIn = NonNullable<JwtModuleOptions['signOptions']>['expiresIn'];

@Module({
  imports: [
    UsersModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('JWT_SECRET');
        // Fail at boot rather than fall back to a development default: a
        // fallback secret is exactly the secret that reaches production.
        if (!secret) {
          throw new Error(
            'JWT_SECRET is not set. Refusing to start — see .env.example.',
          );
        }
        return {
          secret,
          signOptions: {
            expiresIn: (config.get<string>('JWT_EXPIRES_IN') ??
              '7d') as ExpiresIn,
          },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, PasswordService],
  // The guards (Task 4) need JwtModule; the seed (Task 6) needs PasswordService.
  exports: [AuthService, PasswordService, JwtModule],
})
export class AuthModule {}
