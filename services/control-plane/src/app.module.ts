import { Logger, Module, ValidationPipe, type DynamicModule, type Provider } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { AppThrottlerGuard } from './common/throttler';
import { FleetResolver } from './graphql/resolver';
import { Pool } from 'pg';
import Redis from 'ioredis';

import { loadConfig, type Config } from './config';
import { TOKENS } from './domain/repository';
import { JwtAuthGuard, RolesGuard } from './common/auth';
import {
  InMemoryTenantRepository, InMemoryUserRepository, InMemoryDeviceRepository,
  InMemoryVehicleRepository, InMemoryPositionRepository, InMemoryGeofenceRepository,
  InMemoryAlertRepository, InMemoryTripRepository, InMemoryAlertConfigRepository,
  InMemoryNotificationConfigRepository, InMemoryOrgUnitRepository, InMemorySubscriptionRepository,
  InMemoryRefreshTokenRepository,
} from './domain/in-memory.repository';
import {
  PgTenantRepository, PgUserRepository, PgDeviceRepository, PgVehicleRepository, PgPositionRepository,
  PgGeofenceRepository, PgAlertRepository, PgTripRepository, PgAlertConfigRepository,
  PgNotificationConfigRepository, PgOrgUnitRepository, PgSubscriptionRepository, PgRefreshTokenRepository,
} from './domain/pg.repository';
import { FakePaymentProvider, StripePaymentProvider } from './billing/payment';
import { BillingController, BillingService } from './modules/billing/billing';
import { buildNotificationDispatcher } from './notifications/factory';
import { NotificationsController, NotificationsService } from './modules/notifications/notifications';
import { UsersController, UsersService } from './modules/users/users';
import { DepartmentsController, DepartmentsService } from './modules/departments/departments';
import { AllExceptionsFilter } from './common/http';
import { InMemoryAllowList, InMemoryBus, InMemoryHotState } from './integrations/in-memory';
import { RedisAllowList, RedisHotState, RedisStreamBus } from './integrations/redis';

import { AuthController } from './modules/auth/auth.controller';
import { AuthService } from './modules/auth/auth.service';
import { DevicesController } from './modules/devices/devices.controller';
import { DevicesService } from './modules/devices/devices.service';
import { DeviceConfigController, DeviceConfigService } from './modules/devices/device-config';
import { HttpDeviceCommander, InMemoryDeviceCommander } from './integrations/device-commander';
import { VehiclesController, VehiclesService } from './modules/vehicles/vehicles';
import { TelemetryConsumer } from './modules/telemetry/telemetry.consumer';
import { PositionsController } from './modules/telemetry/positions.controller';
import { AllowListBootstrap } from './allowlist.bootstrap';
import { HealthController } from './health.controller';
import { RealtimeGateway } from './realtime/realtime.gateway';
import { GeofencesController, GeofencesService } from './modules/geofences/geofences';
import { AlertsController, AlertsService } from './modules/alerts/alerts';
import { ReportsController, ReportsService } from './modules/reports/reports';

/** Bind the persistence/integration tokens to in-memory or real implementations. */
function buildInfraProviders(config: Config): Provider[] {
  if (config.useInMemory) {
    return [
      { provide: TOKENS.TenantRepository, useValue: new InMemoryTenantRepository() },
      { provide: TOKENS.UserRepository, useValue: new InMemoryUserRepository() },
      { provide: TOKENS.DeviceRepository, useValue: new InMemoryDeviceRepository() },
      { provide: TOKENS.OrgUnitRepository, useValue: new InMemoryOrgUnitRepository() },
      { provide: TOKENS.VehicleRepository, useValue: new InMemoryVehicleRepository() },
      { provide: TOKENS.PositionRepository, useValue: new InMemoryPositionRepository() },
      { provide: TOKENS.GeofenceRepository, useValue: new InMemoryGeofenceRepository() },
      { provide: TOKENS.AlertRepository, useValue: new InMemoryAlertRepository() },
      { provide: TOKENS.TripRepository, useValue: new InMemoryTripRepository() },
      { provide: TOKENS.AlertConfigRepository, useValue: new InMemoryAlertConfigRepository() },
      { provide: TOKENS.NotificationConfigRepository, useValue: new InMemoryNotificationConfigRepository() },
      { provide: TOKENS.SubscriptionRepository, useValue: new InMemorySubscriptionRepository() },
      { provide: TOKENS.RefreshTokenRepository, useValue: new InMemoryRefreshTokenRepository() },
      { provide: TOKENS.PaymentProvider, useValue: new FakePaymentProvider() },
      { provide: TOKENS.AllowListPublisher, useValue: new InMemoryAllowList() },
      { provide: TOKENS.TelemetryBus, useValue: new InMemoryBus() },
      { provide: TOKENS.HotState, useValue: new InMemoryHotState() },
      { provide: TOKENS.DeviceCommander, useValue: new InMemoryDeviceCommander() },
    ];
  }
  const pool = new Pool({ connectionString: config.databaseUrl! });
  const redis = new Redis(config.redisUrl!);
  const redisBlocking = new Redis(config.redisUrl!); // consumer needs a dedicated blocking conn
  return [
    { provide: TOKENS.TenantRepository, useValue: new PgTenantRepository(pool) },
    { provide: TOKENS.UserRepository, useValue: new PgUserRepository(pool) },
    { provide: TOKENS.DeviceRepository, useValue: new PgDeviceRepository(pool) },
    { provide: TOKENS.OrgUnitRepository, useValue: new PgOrgUnitRepository(pool) },
    { provide: TOKENS.VehicleRepository, useValue: new PgVehicleRepository(pool) },
    { provide: TOKENS.PositionRepository, useValue: new PgPositionRepository(pool) },
    { provide: TOKENS.GeofenceRepository, useValue: new PgGeofenceRepository(pool) },
    { provide: TOKENS.AlertRepository, useValue: new PgAlertRepository(pool) },
    { provide: TOKENS.TripRepository, useValue: new PgTripRepository(pool) },
    { provide: TOKENS.AlertConfigRepository, useValue: new PgAlertConfigRepository(pool) },
    { provide: TOKENS.NotificationConfigRepository, useValue: new PgNotificationConfigRepository(pool) },
    { provide: TOKENS.SubscriptionRepository, useValue: new PgSubscriptionRepository(pool) },
    { provide: TOKENS.RefreshTokenRepository, useValue: new PgRefreshTokenRepository(pool) },
    { provide: TOKENS.PaymentProvider, useValue: process.env.STRIPE_KEY ? new StripePaymentProvider(process.env.STRIPE_KEY) : new FakePaymentProvider() },
    { provide: TOKENS.AllowListPublisher, useValue: new RedisAllowList(redis) },
    { provide: TOKENS.TelemetryBus, useValue: new RedisStreamBus(redisBlocking) },
    { provide: TOKENS.HotState, useValue: new RedisHotState(redis) },
    // Downlink to devices via ingestion's internal /commands endpoint. Null when
    // not configured → the config API answers 503 rather than pretending.
    {
      provide: TOKENS.DeviceCommander,
      useValue: config.ingestCommandUrl && config.ingestCommandSecret
        ? new HttpDeviceCommander(config.ingestCommandUrl, config.ingestCommandSecret)
        : null,
    },
  ];
}

@Module({})
export class AppModule {
  static forRoot(config: Config = loadConfig()): DynamicModule {
    return {
      module: AppModule,
      imports: [
        JwtModule.register({
          secret: config.jwtSecret,
          // expiresIn accepts ms-style strings ("15m") at runtime; the type is narrower.
          signOptions: { expiresIn: config.jwtExpiresIn as unknown as number },
        }),
        ThrottlerModule.forRoot([{ ttl: config.throttleTtlMs, limit: config.throttleLimit }]),
        GraphQLModule.forRoot<ApolloDriverConfig>({
          driver: ApolloDriver,
          autoSchemaFile: true, // code-first, in-memory schema
          context: ({ req }: { req: unknown }) => ({ req }),
          playground: false,
        }),
      ],
      controllers: [
        AuthController, DevicesController, VehiclesController, PositionsController, HealthController,
        GeofencesController, AlertsController, ReportsController, NotificationsController, UsersController,
        DepartmentsController, BillingController, DeviceConfigController,
      ],
      providers: [
        AuthService, DevicesService, VehiclesService, TelemetryConsumer, AllowListBootstrap, DeviceConfigService,
        GeofencesService, AlertsService, ReportsService, NotificationsService, UsersService, DepartmentsService,
        BillingService, FleetResolver,
        RealtimeGateway,
        { provide: TOKENS.RealtimePublisher, useExisting: RealtimeGateway },
        ...buildInfraProviders(config),
        {
          provide: TOKENS.NotificationDispatcher,
          inject: [TOKENS.NotificationConfigRepository],
          useFactory: (repo: import('./domain/repository').NotificationConfigRepository) =>
            buildNotificationDispatcher(repo, {
              warn: (m, f) => new Logger('Notifications').warn(f ? `${m} ${JSON.stringify(f)}` : m),
            }),
        },
        // Rate-limit first (protects auth + everything), then authenticate, then authorize.
        { provide: APP_GUARD, useClass: AppThrottlerGuard },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: APP_PIPE, useValue: new ValidationPipe({ whitelist: true, transform: true }) },
      ],
    };
  }
}
