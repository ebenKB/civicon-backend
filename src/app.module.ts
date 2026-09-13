import { Module, ValidationPipe } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from './auth/auth.module.js';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard.js';
import { RolesGuard } from './auth/guards/roles.guard.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { MongoExceptionFilter } from './common/filters/mongo-exception.filter.js';
import { buildMongoUri } from './config/database.config.js';
import { HelloModule } from './hello/hello.module.js';
import { IssuesModule } from './issues/issues.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env'],
    }),
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        uri: buildMongoUri(configService),
      }),
    }),
    HelloModule,
    UsersModule,
    AuthModule,
    IssuesModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Registered here rather than in main.ts so tests that build the app from
    // AppModule get the identical pipe/filter stack as production.
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true, // strip properties with no DTO decorator
        forbidNonWhitelisted: true, // 400 instead of silently dropping them
        transform: true,
      }),
    },
    {
      provide: APP_FILTER,
      useClass: MongoExceptionFilter,
    },
    // Order matters: Nest runs global guards in registration order, so
    // JwtAuthGuard populates request.user before RolesGuard reads it.
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
  ],
})
export class AppModule {}
