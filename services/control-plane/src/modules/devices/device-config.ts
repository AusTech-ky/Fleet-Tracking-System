import {
  BadGatewayException, BadRequestException, Body, Controller, Get, GatewayTimeoutException,
  Inject, Injectable, Logger, Param, Post, Query, ServiceUnavailableException, ConflictException,
} from '@nestjs/common';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  buildSetParam, buildGetParam, parseGetParamResponse, setParamAccepted, PARAM_RANGE,
  ParamValueError, type NetworkMode, type MotionMode, type MovingProfile,
} from '../../protocol/teltonika-params';
import { CurrentUser, Roles, type AuthUser } from '../../common/auth';
import { TOKENS } from '../../domain/repository';
import { DeviceCommandError, type DeviceCommander } from '../../integrations/ports';
import { DevicesService } from './devices.service';

/**
 * Remote device configuration: read and write a tracker's reporting profile
 * over the air, on the TCP socket it is already using to send positions.
 *
 * Only Teltonika "records profile" parameters are exposed here, and only via
 * the typed catalogue in @fleet/protocol-teltonika — no free-text commands
 * reach a vehicle from this API. Every ID is traceable to the Teltonika wiki.
 */

export class ReportingProfileDto {
  @IsOptional() @IsInt() @Min(PARAM_RANGE.minPeriodSec.min) @Max(PARAM_RANGE.minPeriodSec.max)
  minPeriodSec?: number;
  @IsOptional() @IsInt() @Min(PARAM_RANGE.minDistanceM.min) @Max(PARAM_RANGE.minDistanceM.max)
  minDistanceM?: number;
  @IsOptional() @IsInt() @Min(PARAM_RANGE.minAngleDeg.min) @Max(PARAM_RANGE.minAngleDeg.max)
  minAngleDeg?: number;
  @IsOptional() @IsInt() @Min(PARAM_RANGE.minSpeedDeltaKph.min) @Max(PARAM_RANGE.minSpeedDeltaKph.max)
  minSpeedDeltaKph?: number;
  @IsOptional() @IsInt() @Min(PARAM_RANGE.minSavedRecords.min) @Max(PARAM_RANGE.minSavedRecords.max)
  minSavedRecords?: number;
  @IsOptional() @IsInt() @Min(PARAM_RANGE.sendPeriodSec.min) @Max(PARAM_RANGE.sendPeriodSec.max)
  sendPeriodSec?: number;
}

export class ProfileSelectorDto {
  @IsIn(['home', 'roaming', 'unknown']) network!: NetworkMode;
  @IsIn(['stop', 'moving']) motion!: MotionMode;
}

export interface ProfileReadResult {
  network: NetworkMode;
  motion: MotionMode;
  values: Partial<MovingProfile>;
  /** raw device reply, for the audit trail / debugging */
  raw: string;
}
export interface ProfileWriteResult extends ProfileReadResult {
  applied: boolean;
  command: string;
}

@Injectable()
export class DeviceConfigService {
  private readonly log = new Logger(DeviceConfigService.name);
  constructor(
    private readonly devices: DevicesService,
    @Inject(TOKENS.DeviceCommander) private readonly commander: DeviceCommander | null,
  ) {}

  private requireCommander(): DeviceCommander {
    if (!this.commander) throw new ServiceUnavailableException('Remote device configuration is not enabled');
    return this.commander;
  }

  /** Read one profile back from the device (getparam). */
  async read(user: AuthUser, deviceId: string, network: NetworkMode, motion: MotionMode): Promise<ProfileReadResult> {
    const device = await this.devices.get(user, deviceId); // tenant + department scope
    const cmd = buildGetParam(network, motion);
    const raw = await this.relay(device.imei, cmd);
    return { network, motion, values: parseGetParamResponse(network, motion, raw), raw };
  }

  /**
   * Write a partial profile (setparam), then read it back and return what the
   * device *actually* holds — the reply text alone is not proof it stuck.
   */
  async write(user: AuthUser, deviceId: string, network: NetworkMode, motion: MotionMode, values: Partial<MovingProfile>): Promise<ProfileWriteResult> {
    const device = await this.devices.get(user, deviceId);
    let cmd: string;
    try {
      cmd = buildSetParam(network, motion, values);
    } catch (err) {
      if (err instanceof ParamValueError) throw new BadRequestException(err.message);
      throw err;
    }
    const raw = await this.relay(device.imei, cmd);
    const applied = setParamAccepted(raw);
    this.log.log(`setparam ${device.imei} [${network}/${motion}] by ${user.email}: ${cmd} → ${raw.slice(0, 120)}`);
    if (!applied) throw new ConflictException(`Device rejected the change: ${raw}`);
    // Verify: read back the fields we just set.
    const verifyRaw = await this.relay(device.imei, buildGetParam(network, motion));
    const held = parseGetParamResponse(network, motion, verifyRaw);
    return { network, motion, values: held, raw: verifyRaw, applied, command: cmd };
  }

  private async relay(imei: string, command: string): Promise<string> {
    try {
      return await this.requireCommander().send(imei, command);
    } catch (err) {
      if (err instanceof DeviceCommandError) {
        switch (err.code) {
          case 'not_connected': throw new ConflictException(err.message);
          case 'timeout':       throw new GatewayTimeoutException(err.message);
          case 'disabled':      throw new ServiceUnavailableException(err.message);
          default:              throw new BadGatewayException(err.message);
        }
      }
      throw err;
    }
  }
}

@Controller('devices/:id/config')
export class DeviceConfigController {
  constructor(private readonly config: DeviceConfigService) {}

  /** GET /devices/:id/config/reporting?network=home&motion=moving */
  @Get('reporting')
  @Roles('admin', 'operator')
  read(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query() q: ProfileSelectorDto) {
    return this.config.read(user, id, q.network, q.motion);
  }

  /** POST /devices/:id/config/reporting?network=home&motion=moving  { minPeriodSec: 5, ... } */
  @Post('reporting')
  @Roles('admin')
  write(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query() q: ProfileSelectorDto, @Body() body: ReportingProfileDto) {
    return this.config.write(user, id, q.network, q.motion, body);
  }
}
