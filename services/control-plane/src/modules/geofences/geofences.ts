import {
  Body, Controller, Delete, Get, HttpCode, Inject, Injectable, NotFoundException,
  BadRequestException, Param, Post,
} from '@nestjs/common';
import { IsArray, IsIn, IsNumber, IsOptional, IsString, MinLength } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { CurrentUser, Roles, type AuthUser } from '../../common/auth';
import { TOKENS, type GeofenceRepository } from '../../domain/repository';
import type { Geofence } from '../../domain/entities';

export class CreateGeofenceDto {
  @IsString() @MinLength(1) name!: string;
  @IsIn(['circle', 'polygon']) kind!: 'circle' | 'polygon';
  @IsOptional() @IsNumber() centerLat?: number;
  @IsOptional() @IsNumber() centerLon?: number;
  @IsOptional() @IsNumber() radiusM?: number;
  /** polygon ring as [lon,lat] pairs */
  @IsOptional() @IsArray() ring?: [number, number][];
}

@Injectable()
export class GeofencesService {
  constructor(@Inject(TOKENS.GeofenceRepository) private readonly repo: GeofenceRepository) {}

  create(tenantId: string, dto: CreateGeofenceDto): Promise<Geofence> {
    const base = { id: randomUUID(), tenantId, name: dto.name, createdAt: new Date().toISOString() };
    if (dto.kind === 'circle') {
      if (dto.centerLat == null || dto.centerLon == null || !dto.radiusM) {
        throw new BadRequestException('circle requires centerLat, centerLon, radiusM');
      }
      return this.repo.create({ ...base, kind: 'circle', centerLat: dto.centerLat, centerLon: dto.centerLon, radiusM: dto.radiusM });
    }
    if (!dto.ring || dto.ring.length < 3) {
      throw new BadRequestException('polygon requires a ring of at least 3 [lon,lat] points');
    }
    return this.repo.create({ ...base, kind: 'polygon', ring: dto.ring });
  }
  list(tenantId: string) {
    return this.repo.list(tenantId);
  }
  async remove(tenantId: string, id: string) {
    if (!(await this.repo.remove(tenantId, id))) throw new NotFoundException('Geofence not found');
  }
}

@Controller('geofences')
export class GeofencesController {
  constructor(private readonly geofences: GeofencesService) {}

  @Post()
  @Roles('admin', 'operator')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateGeofenceDto) {
    return this.geofences.create(user.tenantId, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.geofences.list(user.tenantId);
  }

  @Delete(':id')
  @Roles('admin', 'operator')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.geofences.remove(user.tenantId, id);
  }
}
