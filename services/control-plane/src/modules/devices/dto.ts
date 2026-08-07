import { IsIn, IsOptional, IsString, Matches, MinLength } from 'class-validator';
import type { DeviceStatus } from '../../domain/entities';

export class CreateDeviceDto {
  @Matches(/^\d{15}$/, { message: 'imei must be exactly 15 digits' })
  imei!: string;

  @IsString()
  @MinLength(2)
  model!: string;

  @IsOptional()
  @IsString()
  name?: string | null;

  @IsOptional()
  @IsString()
  departmentId?: string | null;
}

export class RenameDeviceDto {
  @IsOptional()
  @IsString()
  name!: string | null;
}

export class AssignDepartmentDto {
  @IsOptional()
  @IsString()
  departmentId!: string | null;
}

export class UpdateDeviceStatusDto {
  @IsIn(['provisioned', 'active', 'suspended', 'retired'])
  status!: DeviceStatus;
}

export class AssignVehicleDto {
  @IsOptional()
  @IsString()
  vehicleId!: string | null;
}
