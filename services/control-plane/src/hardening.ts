import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { requestContext } from './common/http';

/**
 * HTTP-layer hardening applied at bootstrap AND in e2e tests (so it's covered):
 *  - helmet security headers
 *  - CORS (restricted to configured origins, or reflect-any in dev)
 *  - OpenAPI/Swagger at /docs (UI) and /openapi.json (spec)
 */
export function applyHttpHardening(app: INestApplication, opts: { corsOrigins: string[] }) {
  app.use(requestContext());
  app.use(helmet());
  app.enableCors({
    origin: opts.corsOrigins.length ? opts.corsOrigins : true,
    credentials: true,
  });

  const doc = new DocumentBuilder()
    .setTitle('FleetView API')
    .setDescription('Provisioning, telemetry, geofencing, alerts, reports and notifications.')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, doc), {
    jsonDocumentUrl: 'openapi.json',
  });
}
