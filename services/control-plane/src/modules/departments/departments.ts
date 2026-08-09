import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Injectable, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { CurrentUser, Roles, type AuthUser } from '../../common/auth';
import { TOKENS, type OrgUnitRepository } from '../../domain/repository';
import type { OrgUnit } from '../../domain/entities';

export class CreateDepartmentDto {
  @IsString() @MinLength(1) name!: string;
  @IsOptional() @IsString() parentId?: string | null;
}

export class UpdateDepartmentDto {
  @IsOptional() @IsString() @MinLength(1) name?: string;
  /** `null` moves the group back to the root. Omit to leave the parent alone. */
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

  async update(tenantId: string, id: string, dto: UpdateDepartmentDto): Promise<OrgUnit> {
    const current = await this.repo.findById(tenantId, id);
    if (!current) throw new NotFoundException('Department not found');

    if (dto.parentId !== undefined && dto.parentId !== null) {
      if (dto.parentId === id) throw new BadRequestException('A group cannot be its own parent');
      const parent = await this.repo.findById(tenantId, dto.parentId);
      if (!parent) throw new NotFoundException('Parent department not found');
      // Walk up from the proposed parent. Reaching `id` means the move would
      // detach the cycle from the root and strand every group inside it.
      const all = await this.repo.list(tenantId);
      const parentOf = new Map(all.map((o) => [o.id, o.parentId]));
      for (let hop: string | null | undefined = dto.parentId; hop; hop = parentOf.get(hop)) {
        if (hop === id) throw new BadRequestException('Cannot move a group into its own subtree');
      }
    }

    const updated = await this.repo.update(tenantId, id, dto);
    if (!updated) throw new NotFoundException('Department not found');
    return updated;
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

  @Patch(':id')
  @Roles('admin')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateDepartmentDto) {
    return this.departments.update(user.tenantId, id, dto);
  }

  @Delete(':id')
  @Roles('admin')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.departments.remove(user.tenantId, id);
  }
}
