import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  // The global ValidationPipe and MongoExceptionFilter are registered in
  // AppModule (APP_PIPE / APP_FILTER) so tests share the same stack.
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 9000);
}
await bootstrap();
