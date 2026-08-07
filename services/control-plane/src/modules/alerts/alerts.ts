import { Body, Controller, Get, Inject, Injectable, Param, Put, Query } from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, Min, ValidateIf } from 'class-validator';
import { CurrentUser, Roles, type AuthUser } from '../../common/auth';
import { TOKENS, type AlertRepository, type AlertConfigRepository, type TripRepository } from '../../domain/repository';
import type { AlertConfig } from '../../domain/entities';

export class UpdateAlertConfigDto {
  @ValidateIf((o) => o.overspeedKph !== null)
  @IsOptional() @IsInt() @Min(1)
  overspeedKph!: number | null;

  @IsOptional() @IsBoolean() ignitionAlerts?: boolean;
  @IsOptional() @IsBoolean() geofenceAlerts?: boolean;
  @IsOptional() @IsInt() @Min(30) offlineAfterSec?: number;
}

@Injectable()
export class AlertsService {
  constructor(
    @Inject(TOKENS.AlertRepository) private readonly alerts: AlertRepository,
    @Inject(TOKENS.AlertConfigRepository) private readonly config: AlertConfigRepository,
    @Inject(TOKENS.TripRepository) private readonly trips: TripRepository,
  ) {}

  list(tenantId: string, deviceId: string | undefined, limit: number) {
    return this.alerts.list(tenantId, { deviceId, limit: Math.min(limit, 500) });
  }
  getConfig(tenantId: string) {
    return this.config.get(tenantId);
  }
  async setConfig(tenantId: string, patch: Partial<AlertConfig>) {
    const current = await this.config.get(tenantId);
    // Merge only DEFINED keys — an optional DTO field left out arrives as
    // `undefined`, which must NOT overwrite the current value (and would send
    // NULL into NOT NULL columns on the pg path).
    const merged: AlertConfig = { ...current };
    for (const k of ['overspeedKph', 'ignitionAlerts', 'geofenceAlerts', 'offlineAfterSec'] as const) {
      if (patch[k] !== undefined) (merged[k] as AlertConfig[typeof k]) = patch[k]!;
    }
    return this.config.set(tenantId, merged);
  }
  listTrips(tenantId: string, deviceId: string, from: string, to: string) {
    return this.trips.list(tenantId, deviceId, from, to, 500);
  }
}

@Controller()
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get('alerts')
  list(
    @CurrentUser() user: AuthUser,
    @Query('deviceId') deviceId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.alerts.list(user.tenantId, deviceId, Number(limit ?? 100));
  }

  @Get('alert-config')
  getConfig(@CurrentUser() user: AuthUser) {
    return this.alerts.getConfig(user.tenantId);
  }

  @Put('alert-config')
  @Roles('admin', 'operator')
  setConfig(@CurrentUser() user: AuthUser, @Body() dto: UpdateAlertConfigDto) {
    return this.alerts.setConfig(user.tenantId, dto);
  }

  @Get('devices/:deviceId/trips')
  trips(
    @CurrentUser() user: AuthUser,
    @Param('deviceId') deviceId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const fromTs = from ?? new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const toTs = to ?? new Date().toISOString();
    return this.alerts.listTrips(user.tenantId, deviceId, fromTs, toTs);
  }
}
