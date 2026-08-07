import {
  BadRequestException, Controller, Get, Inject, Injectable, Query, Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser, type AuthUser } from '../../common/auth';
import {
  TOKENS, type TripRepository, type AlertRepository,
} from '../../domain/repository';
import type { AlertEvent } from '../../domain/entities';
import { DevicesService } from '../devices/devices.service';
import {
  tripsReport, speedingReport, geofenceActivityReport, deviceSummaryReport, fleetSummaryReport, type Report,
} from '../../engine/reports';
import { exportReport, CONTENT_TYPE, type ExportFormat } from '../../reports/exporters';

const PER_DEVICE = ['trips', 'speeding', 'geofence', 'summary'] as const;
const ALL_TYPES = [...PER_DEVICE, 'fleet'] as const;
type ReportType = (typeof ALL_TYPES)[number];
const LIMIT = 5000;

@Injectable()
export class ReportsService {
  constructor(
    private readonly deviceSvc: DevicesService,
    @Inject(TOKENS.TripRepository) private readonly trips: TripRepository,
    @Inject(TOKENS.AlertRepository) private readonly alerts: AlertRepository,
  ) {}

  async generate(
    user: AuthUser, type: ReportType, deviceId: string | undefined, from: string, to: string,
  ): Promise<Report> {
    const now = new Date().toISOString();
    const tenantId = user.tenantId;

    if (type === 'fleet') {
      const devices = (await this.deviceSvc.list(user)).slice(0, 500); // department-scoped
      const perDevice = await Promise.all(
        devices.map(async (d) => ({
          label: `${d.model} ${d.imei}`,
          trips: await this.trips.list(tenantId, d.id, from, to, LIMIT),
          alerts: await this.alertsInRange(tenantId, d.id, from, to),
        })),
      );
      return fleetSummaryReport(perDevice, from, to, now);
    }

    if (!deviceId) throw new BadRequestException(`report type "${type}" requires deviceId`);
    await this.deviceSvc.get(user, deviceId); // tenant + department scope check
    const trips = await this.trips.list(tenantId, deviceId, from, to, LIMIT);
    const alerts = await this.alertsInRange(tenantId, deviceId, from, to);
    switch (type) {
      case 'trips': return tripsReport(trips, from, to, now);
      case 'speeding': return speedingReport(alerts, from, to, now);
      case 'geofence': return geofenceActivityReport(alerts, from, to, now);
      case 'summary': return deviceSummaryReport(trips, alerts, from, to, now);
    }
  }

  /** Alerts repo returns newest-first (no range filter); trim to the range here. */
  private async alertsInRange(tenantId: string, deviceId: string, from: string, to: string): Promise<AlertEvent[]> {
    const all = await this.alerts.list(tenantId, { deviceId, limit: LIMIT });
    return all.filter((a) => a.ts >= from && a.ts <= to);
  }
}

function parseCommon(type?: string, from?: string, to?: string) {
  if (!type || !ALL_TYPES.includes(type as ReportType)) {
    throw new BadRequestException(`type must be one of ${ALL_TYPES.join(', ')}`);
  }
  return {
    type: type as ReportType,
    from: from ?? new Date(Date.now() - 7 * 24 * 3600_000).toISOString(),
    to: to ?? new Date().toISOString(),
  };
}

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** JSON report for on-screen rendering. */
  @Get()
  generate(
    @CurrentUser() user: AuthUser,
    @Query('type') type?: string,
    @Query('deviceId') deviceId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const c = parseCommon(type, from, to);
    return this.reports.generate(user, c.type, deviceId, c.from, c.to);
  }

  /** Download the same report as CSV / Excel / PDF. */
  @Get('export')
  async export(
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
    @Query('format') format?: string,
    @Query('type') type?: string,
    @Query('deviceId') deviceId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const fmt = (format ?? 'csv') as ExportFormat;
    if (!['csv', 'xlsx', 'pdf'].includes(fmt)) throw new BadRequestException('format must be csv, xlsx or pdf');
    const c = parseCommon(type, from, to);
    const report = await this.reports.generate(user, c.type, deviceId, c.from, c.to);
    const out = await exportReport(report, fmt as Exclude<ExportFormat, 'json'>);
    const filename = `${c.type}-${c.from.slice(0, 10)}_${c.to.slice(0, 10)}.${fmt}`;
    res.set({
      'content-type': CONTENT_TYPE[fmt as Exclude<ExportFormat, 'json'>],
      'content-disposition': `attachment; filename="${filename}"`,
    });
    res.send(out);
  }
}
