import { Body, Controller, Get, Inject, Injectable, NotFoundException, Param, Post, Patch } from '@nestjs/common';
import { IsString, MinLength } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { CurrentUser, Roles, type AuthUser } from '../../common/auth';
import { TOKENS, type DeviceRepository, type VehicleRepository } from '../../domain/repository';

export class CreateVehicleDto {
  @IsString()
  @MinLength(1)
  name!: string;
}
export class LinkDeviceDto {
  @IsString()
  deviceId!: string;
}

@Injectable()
export class VehiclesService {
  constructor(
    @Inject(TOKENS.VehicleRepository) private readonly vehicles: VehicleRepository,
    @Inject(TOKENS.DeviceRepository) private readonly devices: DeviceRepository,
  ) {}

  create(tenantId: string, name: string) {
    return this.vehicles.create({ id: randomUUID(), tenantId, name, deviceId: null });
  }
  list(tenantId: string) {
    return this.vehicles.list(tenantId);
  }
  async get(tenantId: string, id: string) {
    const v = await this.vehicles.findById(tenantId, id);
    if (!v) throw new NotFoundException('Vehicle not found');
    return v;
  }

  /** Link a device to a vehicle (updates both sides atomically-enough for now). */
  async linkDevice(tenantId: string, vehicleId: string, deviceId: string) {
    const vehicle = await this.get(tenantId, vehicleId);
    const device = await this.devices.findById(tenantId, deviceId);
    if (!device) throw new NotFoundException('Device not found');
    await this.devices.update(tenantId, deviceId, { vehicleId });
    return this.vehicles.update(tenantId, vehicleId, { deviceId });
  }
}

@Controller('vehicles')
export class VehiclesController {
  constructor(private readonly vehicles: VehiclesService) {}

  @Post()
  @Roles('admin', 'operator')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateVehicleDto) {
    return this.vehicles.create(user.tenantId, dto.name);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.vehicles.list(user.tenantId);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.vehicles.get(user.tenantId, id);
  }

  @Patch(':id/device')
  @Roles('admin', 'operator')
  link(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: LinkDeviceDto) {
    return this.vehicles.linkDevice(user.tenantId, id, dto.deviceId);
  }
}
