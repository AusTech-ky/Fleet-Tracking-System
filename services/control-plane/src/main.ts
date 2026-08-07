import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { loadConfig } from './config';
import { applyHttpHardening } from './hardening';

async function bootstrap() {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule.forRoot(config), { bufferLogs: false });
  applyHttpHardening(app, { corsOrigins: config.corsOrigins }); // helmet + CORS + Swagger + request-id
  app.useWebSocketAdapter(new WsAdapter(app)); // native ws for the /rt live feed
  app.enableShutdownHooks();
  await app.listen(config.port);
  new Logger('Bootstrap').log(
    `control-plane listening on :${config.port} (${config.useInMemory ? 'in-memory' : 'postgres+redis'})`,
  );
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('failed to start control-plane', err);
  process.exit(1);
});
