import { Body, Controller, ConflictException, Get, Inject, Injectable, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { CurrentUser, Roles, type AuthUser } from '../../common/auth';
import { hashPassword } from '../../common/password';
import { TOKENS, type UserRepository } from '../../domain/repository';
import type { Role, User } from '../../domain/entities';
import { BillingService } from '../billing/billing';

const ROLES: Role[] = ['admin', 'operator', 'viewer'];

export class CreateUserDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(8) password!: string;
  @IsIn(ROLES) role!: Role;
  @IsOptional() @IsString() departmentId?: string | null;
}
export class UpdateUserDto {
  @IsOptional() @IsIn(ROLES) role?: Role;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsString() departmentId?: string | null;
}

/** Strip secrets before returning a user over the API. */
function toPublic(u: User) {
  const { passwordHash, mfaSecret, ...safe } = u;
  void passwordHash; void mfaSecret;
  return safe;
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(TOKENS.UserRepository) private readonly users: UserRepository,
    private readonly billing: BillingService,
  ) {}

  async list(tenantId: string) {
    return (await this.users.list(tenantId)).map(toPublic);
  }

  async create(tenantId: string, dto: CreateUserDto) {
    if (await this.users.findByEmail(dto.email)) throw new ConflictException('Email already registered');
    await this.billing.assertCanAddUser(tenantId); // plan quota
    const user = await this.users.create({
      id: randomUUID(), tenantId, email: dto.email, passwordHash: hashPassword(dto.password),
      role: dto.role, active: true, mfaEnabled: false, mfaSecret: null,
      departmentId: dto.departmentId ?? null,
    });
    return toPublic(user);
  }

  async update(tenantId: string, id: string, actingUserId: string, dto: UpdateUserDto) {
    const target = await this.users.findById(id);
    if (!target || target.tenantId !== tenantId) throw new NotFoundException('User not found');
    if (id === actingUserId && dto.active === false) {
      throw new ConflictException('You cannot deactivate your own account');
    }
    const updated = await this.users.update(id, {
      ...(dto.role !== undefined ? { role: dto.role } : {}),
      ...(dto.active !== undefined ? { active: dto.active } : {}),
      ...(dto.departmentId !== undefined ? { departmentId: dto.departmentId } : {}),
    });
    return toPublic(updated!);
  }
}

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @Roles('admin')
  list(@CurrentUser() user: AuthUser) {
    return this.users.list(user.tenantId);
  }

  @Post()
  @Roles('admin')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateUserDto) {
    return this.users.create(user.tenantId, dto);
  }

  @Patch(':id')
  @Roles('admin')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(user.tenantId, id, user.userId, dto);
  }
}
