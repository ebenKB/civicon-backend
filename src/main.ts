import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  // The global ValidationPipe and MongoExceptionFilter are registered in
  // AppModule (APP_PIPE / APP_FILTER) so tests share the same stack.
  const app = await NestFactory.create(AppModule);
  // Browsers refuse cross-origin API calls without this. Every origin is
  // allowed (Access-Control-Allow-Origin: *), which is safe only because auth
  // is a bearer token in the Authorization header: a wildcard origin can never
  // carry cookies or other credentials.
  // TODO: restrict to an allowlist before any real deployment — e.g. a
  // comma-separated CORS_ORIGINS env var, defaulting to the frontend's dev
  // origin (http://localhost:3001).
  app.enableCors();
  await app.listen(process.env.PORT ?? 9000);
}
await bootstrap();
