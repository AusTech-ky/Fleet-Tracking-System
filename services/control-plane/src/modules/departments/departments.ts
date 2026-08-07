import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, NotFoundException, Param, Post } from '@nestjs/common';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { CurrentUser, Roles, type AuthUser } from '../../common/auth';
import { TOKENS, type OrgUnitRepository } from '../../domain/repository';
import type { OrgUnit } from '../../domain/entities';

export class CreateDepartmentDto {
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsString() parentId?: string | null;
}

@Injectable()
export class DepartmentsService {
  constructor(@Inject(TOKENS.OrgUnitRepository) private readonly repo: OrgUnitRepository) {}

  async create(tenantId: string, dto: CreateDepartmentDto): Promise<OrgUnit> {
    if (dto.parentId && !(await this.repo.findById(tenantId, dto.parentId))) {
      throw new NotFoundException('Parent department not found');
    }
    return this.repo.create({ id: randomUUID(), tenantId, name: dto.name, parentId: dto.parentId ?? null });
  }
  list(tenantId: string) {
    return this.repo.list(tenantId);
  }
  async remove(tenantId: string, id: string) {
    if (!(await this.repo.remove(tenantId, id))) throw new NotFoundException('Department not found');
  }
}

@Controller('departments')
export class DepartmentsController {
  constructor(private readonly departments: DepartmentsService) {}

  @Post()
  @Roles('admin')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateDepartmentDto) {
    return this.departments.create(user.tenantId, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.departments.list(user.tenantId);
  }

  @Delete(':id')
  @Roles('admin')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.departments.remove(user.tenantId, id);
  }
}
