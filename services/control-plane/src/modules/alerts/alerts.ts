import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Param, Put, Query } from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, Min, ValidateIf } from 'class-validator';
import { CurrentUser, Roles, type AuthUser } from '../../common/auth';
import { TOKENS, type AlertRepository, type AlertConfigRepository, type TripRepository } from '../../domain/repository';
import type { AlertConfig, AlertType } from '../../domain/entities';
import { ALERT_TYPES } from '../../domain/entities';

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
  /** Clear alerts. `types` optional (validated by the controller); no types = all. */
  clear(tenantId: string, opts: { types?: AlertType[]; deviceId?: string }) {
    return this.alerts.clear(tenantId, opts);
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

  /**
   * Clear alerts. Admin only — this deletes history.
   *   DELETE /alerts                 → clear all
   *   DELETE /alerts?type=ignition_on,ignition_off  → only those types
   *   DELETE /alerts?deviceId=...     → only that device
   * Returns { deleted: n }.
   */
  @Delete('alerts')
  @Roles('admin')
  @HttpCode(200)
  async clear(
    @CurrentUser() user: AuthUser,
    @Query('type') type?: string,
    @Query('deviceId') deviceId?: string,
  ) {
    let types: AlertType[] | undefined;
    if (type) {
      types = type.split(',').map((t) => t.trim()).filter(Boolean) as AlertType[];
      const bad = types.filter((t) => !ALERT_TYPES.includes(t));
      if (bad.length) throw new BadRequestException(`unknown alert type(s): ${bad.join(', ')}`);
    }
    const deleted = await this.alerts.clear(user.tenantId, { types, deviceId });
    return { deleted };
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
