import { Controller, Get, Inject, NotFoundException, Param, Query } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../../common/auth';
import { TOKENS, type PositionRepository } from '../../domain/repository';
import type { HotState } from '../../integrations/ports';
import { DevicesService } from '../devices/devices.service';

/**
 * Read API for telemetry. Latest position is served from hot state (Redis) so
 * the live map never touches the cold store; history comes from the time-series
 * store. Access is tenant- AND department-scoped via DevicesService.get.
 */
@Controller('devices/:deviceId')
export class PositionsController {
  constructor(
    @Inject(TOKENS.HotState) private readonly hot: HotState,
    @Inject(TOKENS.PositionRepository) private readonly positions: PositionRepository,
    private readonly devices: DevicesService,
  ) {}

  @Get('latest')
  async latest(@CurrentUser() user: AuthUser, @Param('deviceId') deviceId: string) {
    await this.devices.get(user, deviceId); // tenant + department scope check
    let pos = await this.hot.getLast(user.tenantId, deviceId);
    if (!pos) {
      // Hot-state is a cache, not the record. It's empty after a Redis restart,
      // in a fresh environment, or after a recovery — and without this fallback
      // every vehicle showed "no position yet" and the map was blank despite a
      // full history in the DB. Read the newest row and re-warm the cache so
      // the next request is fast again.
      pos = await this.positions.latest(user.tenantId, deviceId);
      if (pos) await this.hot.setLast(pos).catch(() => {}); // best-effort warm
    }
    if (!pos) throw new NotFoundException('No position yet for this device');
    return pos;
  }

  @Get('history')
  async history(
    @CurrentUser() user: AuthUser,
    @Param('deviceId') deviceId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    await this.devices.get(user, deviceId);
    const fromTs = from ?? new Date(Date.now() - 24 * 3600_000).toISOString();
    const toTs = to ?? new Date().toISOString();
    const cap = Math.min(Number(limit ?? 1000), 10_000);
    return this.positions.history(user.tenantId, deviceId, fromTs, toTs, cap);
  }
}
