import { Body, Controller, Delete, Get, Param, Patch, Post, HttpCode } from '@nestjs/common';
import { CurrentUser, Roles, type AuthUser } from '../../common/auth';
import { DevicesService } from './devices.service';
import { CreateDeviceDto, UpdateDeviceStatusDto, AssignDepartmentDto, RenameDeviceDto, SetAssetTypeDto } from './dto';

@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Post()
  @Roles('admin', 'operator')
  provision(@CurrentUser() user: AuthUser, @Body() dto: CreateDeviceDto) {
    return this.devices.provision(user, dto.imei, dto.model, dto.departmentId, dto.name, dto.assetType);
  }

  @Patch(':id/asset-type')
  @Roles('admin', 'operator')
  setAssetType(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: SetAssetTypeDto) {
    return this.devices.setAssetType(user, id, dto.assetType);
  }

  @Patch(':id/name')
  @Roles('admin', 'operator')
  rename(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: RenameDeviceDto) {
    return this.devices.rename(user, id, dto.name ?? null);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.devices.list(user);
  }

  /** Soft-deleted devices — the "recently deleted" view. Declared before :id so it isn't captured as an id. */
  @Get('deleted')
  listDeleted(@CurrentUser() user: AuthUser) {
    return this.devices.listDeleted(user);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.devices.get(user, id);
  }

  /** Undo a soft delete. */
  @Post(':id/restore')
  @Roles('admin')
  restore(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.devices.restore(user, id);
  }

  @Patch(':id/status')
  @Roles('admin', 'operator')
  setStatus(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateDeviceStatusDto) {
    return this.devices.setStatus(user, id, dto.status);
  }

  @Patch(':id/department')
  @Roles('admin', 'operator')
  assignDepartment(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: AssignDepartmentDto) {
    return this.devices.assignDepartment(user, id, dto.departmentId);
  }

  @Delete(':id')
  @Roles('admin')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.devices.remove(user, id);
  }
}
