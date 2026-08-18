import {
  BadGatewayException, BadRequestException, Body, ConflictException, Controller, ForbiddenException,
  GatewayTimeoutException, Get, Inject, Injectable, NotFoundException, Param, Post, Put,
  ServiceUnavailableException,
} from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { CurrentUser, Roles, type AuthUser } from '../../common/auth';
import { TOKENS, type ImmobilizerRepository, type PositionRepository } from '../../domain/repository';
import type { ImmobilizerConfig, ImmobilizerAction } from '../../domain/entities';
import { DeviceCommandError, type DeviceCommander, type HotState } from '../../integrations/ports';
import { DevicesService } from './devices.service';
import { buildSetDigout, assertSafeToImmobilize, ImmobilizeUnsafeError } from './immobilizer-command';

/**
 * Remote immobilization: cut / restore a vehicle's starter circuit through a
 * relay on a Teltonika digital output, over the Codec 12 command channel.
 *
 * This is the one action in the product that can stop a car, so it is fenced:
 *  - OFF per device until an admin enables it with the wiring (which DOUT,
 *    polarity). Immobilizing with nothing on the DOUT is a no-op, and getting
 *    the polarity wrong would cut the wrong state — so it is opt-in and typed.
 *  - Admin-only. Every action is written to an append-only event log.
 *  - Speed-gated twice: the device's own setdigout speed threshold, AND a
 *    server-side refusal if the last known speed is above the limit. Release
 *    is never gated — a driver must always be able to regain the engine.
 *  - A physical standstill test is expected before the feature is trusted;
 *    the config exposes `testedAt` so the UI can insist on it.
 */

export class ImmobilizerConfigDto {
  @IsBoolean() enabled!: boolean;
  @IsOptional() @IsInt() @Min(1) @Max(4) dout?: number;
  @IsOptional() @IsBoolean() activeHigh?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(50) maxEngageKph?: number;
}

const DEFAULTS = { enabled: false, dout: 1, activeHigh: true, maxEngageKph: 5 };

@Injectable()
export class ImmobilizerService {
  constructor(
    private readonly devices: DevicesService,
    @Inject(TOKENS.ImmobilizerRepository) private readonly repo: ImmobilizerRepository,
    @Inject(TOKENS.PositionRepository) private readonly positions: PositionRepository,
    @Inject(TOKENS.HotState) private readonly hot: HotState,
    @Inject(TOKENS.DeviceCommander) private readonly commander: DeviceCommander | null,
  ) {}

  /** Config as stored, or a disabled default (never auto-creates a row). */
  async getConfig(user: AuthUser, deviceId: string): Promise<ImmobilizerConfig> {
    const device = await this.devices.get(user, deviceId); // tenant + scope, 404 otherwise
    const existing = await this.repo.get(user.tenantId, deviceId);
    return existing ?? {
      deviceId, tenantId: user.tenantId, ...DEFAULTS, immobilized: false,
      lastCommand: null, lastReply: null, lastBy: null, lastAt: null, testedAt: null,
      createdAt: new Date().toISOString(),
    };
  }

  async history(user: AuthUser, deviceId: string, limit = 50) {
    await this.devices.get(user, deviceId);
    return this.repo.events(user.tenantId, deviceId, Math.min(limit, 200));
  }

  /** Enable/disable and set the wiring. Changing wiring clears the tested flag. */
  async configure(user: AuthUser, deviceId: string, dto: ImmobilizerConfigDto): Promise<ImmobilizerConfig> {
    await this.devices.get(user, deviceId);
    const current = await this.repo.get(user.tenantId, deviceId);
    const wiringChanged =
      (dto.dout !== undefined && dto.dout !== (current?.dout ?? DEFAULTS.dout)) ||
      (dto.activeHigh !== undefined && dto.activeHigh !== (current?.activeHigh ?? DEFAULTS.activeHigh));
    const next: ImmobilizerConfig = {
      deviceId, tenantId: user.tenantId,
      enabled: dto.enabled,
      dout: dto.dout ?? current?.dout ?? DEFAULTS.dout,
      activeHigh: dto.activeHigh ?? current?.activeHigh ?? DEFAULTS.activeHigh,
      maxEngageKph: dto.maxEngageKph ?? current?.maxEngageKph ?? DEFAULTS.maxEngageKph,
      immobilized: current?.immobilized ?? false,
      lastCommand: current?.lastCommand ?? null, lastReply: current?.lastReply ?? null,
      lastBy: current?.lastBy ?? null, lastAt: current?.lastAt ?? null,
      // Any wiring change invalidates a prior physical test.
      testedAt: wiringChanged ? null : current?.testedAt ?? null,
      createdAt: current?.createdAt ?? new Date().toISOString(),
    };
    const saved = await this.repo.upsert(next);
    await this.log(user, deviceId, dto.enabled ? 'enable' : 'disable', null, null, true);
    return saved;
  }

  async immobilize(user: AuthUser, deviceId: string): Promise<ImmobilizerConfig> {
    return this.actuate(user, deviceId, true, 'immobilize');
  }
  async mobilize(user: AuthUser, deviceId: string): Promise<ImmobilizerConfig> {
    return this.actuate(user, deviceId, false, 'mobilize');
  }

  /** A dry test: sends the release command so an admin can watch the relay click. */
  async test(user: AuthUser, deviceId: string): Promise<ImmobilizerConfig> {
    const cfg = await this.requireEnabled(user, deviceId);
    const command = buildSetDigout(false, cfg); // release — safe, never speed-gated
    const reply = await this.relay(user, deviceId, command, 'test');
    return (await this.repo.patch(user.tenantId, deviceId, { testedAt: new Date().toISOString(), lastCommand: command, lastReply: reply, lastBy: user.userId, lastAt: new Date().toISOString() }))!;
  }

  private async actuate(user: AuthUser, deviceId: string, immobilize: boolean, action: ImmobilizerAction): Promise<ImmobilizerConfig> {
    const cfg = await this.requireEnabled(user, deviceId);
    if (immobilize) {
      // Server-side speed guard, in addition to the device's own threshold.
      const last = await this.hot.getLast(user.tenantId, deviceId).catch(() => null);
      const speed = last?.speedKph ?? (await this.positions.latest(user.tenantId, deviceId).catch(() => null))?.speedKph ?? null;
      try {
        assertSafeToImmobilize(speed, cfg.maxEngageKph);
      } catch (err) {
        if (err instanceof ImmobilizeUnsafeError) throw new ConflictException(err.message);
        throw err;
      }
    }
    const command = buildSetDigout(immobilize, cfg);
    const reply = await this.relay(user, deviceId, command, action);
    return (await this.repo.patch(user.tenantId, deviceId, {
      immobilized: immobilize, lastCommand: command, lastReply: reply, lastBy: user.userId, lastAt: new Date().toISOString(),
    }))!;
  }

  private async requireEnabled(user: AuthUser, deviceId: string): Promise<ImmobilizerConfig> {
    await this.devices.get(user, deviceId);
    const cfg = await this.repo.get(user.tenantId, deviceId);
    if (!cfg || !cfg.enabled) throw new BadRequestException('Immobilizer is not enabled for this device');
    return cfg;
  }

  private async relay(user: AuthUser, deviceId: string, command: string, action: ImmobilizerAction): Promise<string> {
    if (!this.commander) throw new ServiceUnavailableException('Remote commands are not enabled on the server');
    try {
      const reply = await this.commander.send((await this.devices.get(user, deviceId)).imei, command);
      await this.log(user, deviceId, action, command, reply, true);
      return reply;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.log(user, deviceId, action, command, msg, false);
      if (err instanceof DeviceCommandError) {
        switch (err.code) {
          case 'not_connected': throw new ConflictException('Device is offline — it must be connected to receive the command');
          case 'timeout':       throw new GatewayTimeoutException('Device did not confirm in time — its state is unknown; check the vehicle');
          case 'disabled':      throw new ServiceUnavailableException(err.message);
          default:              throw new BadGatewayException(err.message);
        }
      }
      throw err;
    }
  }

  private async log(user: AuthUser, deviceId: string, action: ImmobilizerAction, command: string | null, reply: string | null, ok: boolean) {
    await this.repo.addEvent({
      id: randomUUID(), tenantId: user.tenantId, deviceId, action,
      actorId: user.userId, actorEmail: user.email, command, reply, ok, ts: new Date().toISOString(),
    });
  }
}

@Controller('devices/:id/immobilizer')
export class ImmobilizerController {
  constructor(private readonly svc: ImmobilizerService) {}

  @Get()
  @Roles('admin', 'operator')
  get(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.getConfig(u, id);
  }

  @Get('history')
  @Roles('admin', 'operator')
  history(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.history(u, id);
  }

  /** Enable/disable + wiring. Admin only. */
  @Put()
  @Roles('admin')
  configure(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ImmobilizerConfigDto) {
    return this.svc.configure(u, id, dto);
  }

  @Post('test')
  @Roles('admin')
  test(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.test(u, id);
  }

  @Post('immobilize')
  @Roles('admin')
  immobilize(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.immobilize(u, id);
  }

  @Post('mobilize')
  @Roles('admin')
  mobilize(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.mobilize(u, id);
  }
}
