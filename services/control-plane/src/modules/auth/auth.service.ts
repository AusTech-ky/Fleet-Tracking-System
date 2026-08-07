import { Inject, Injectable, ConflictException, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { hashPassword, verifyPassword } from '../../common/password';
import { TOKENS, type TenantRepository, type UserRepository } from '../../domain/repository';
import type { JwtPayload } from '../../common/auth';
import type { User } from '../../domain/entities';
import { generateSecret, otpauthUri, verifyTotp } from '../../engine/totp';
import type { RegisterTenantDto, LoginDto } from './dto';

/** Login result: either an access token, or an MFA challenge. */
type LoginResult = { accessToken: string } | { mfaRequired: true; mfaToken: string };

@Injectable()
export class AuthService {
  constructor(
    @Inject(TOKENS.TenantRepository) private readonly tenants: TenantRepository,
    @Inject(TOKENS.UserRepository) private readonly users: UserRepository,
    private readonly jwt: JwtService,
  ) {}

  async registerTenant(dto: RegisterTenantDto) {
    if (await this.users.findByEmail(dto.adminEmail)) {
      throw new ConflictException('Email already registered');
    }
    const tenant = await this.tenants.create({ id: randomUUID(), name: dto.tenantName });
    const user = await this.users.create({
      id: randomUUID(), tenantId: tenant.id, email: dto.adminEmail,
      passwordHash: hashPassword(dto.password), role: 'admin',
      active: true, mfaEnabled: false, mfaSecret: null, departmentId: null,
    });
    return { tenant, accessToken: await this.accessToken(user) };
  }

  async login(dto: LoginDto): Promise<LoginResult> {
    const user = await this.users.findByEmail(dto.email);
    if (!user || !user.active || !verifyPassword(dto.password, user.passwordHash)) {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (user.mfaEnabled) {
      // Password OK, but require a second factor. Issue a short-lived MFA token.
      const mfaToken = await this.jwt.signAsync(
        { sub: user.id, tenantId: user.tenantId, role: user.role, email: user.email, purpose: 'mfa' } satisfies JwtPayload,
        { expiresIn: '5m' },
      );
      return { mfaRequired: true, mfaToken };
    }
    return { accessToken: await this.accessToken(user) };
  }

  /** Complete login by presenting the MFA token + a TOTP code. */
  async verifyMfa(mfaToken: string, code: string): Promise<{ accessToken: string }> {
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(mfaToken);
    } catch {
      throw new UnauthorizedException('Invalid or expired MFA token');
    }
    if (payload.purpose !== 'mfa') throw new UnauthorizedException('Not an MFA token');
    const user = await this.users.findById(payload.sub);
    if (!user || !user.mfaEnabled || !user.mfaSecret) throw new UnauthorizedException('MFA not enabled');
    if (!verifyTotp(user.mfaSecret, code, Date.now())) throw new UnauthorizedException('Invalid MFA code');
    return { accessToken: await this.accessToken(user) };
  }

  /** Begin MFA enrollment: generate + store a (not-yet-enabled) secret. */
  async setupMfa(userId: string): Promise<{ secret: string; otpauthUri: string }> {
    const user = await this.mustFind(userId);
    const secret = generateSecret();
    await this.users.update(userId, { mfaSecret: secret, mfaEnabled: false });
    return { secret, otpauthUri: otpauthUri(secret, user.email) };
  }

  /** Confirm enrollment: verify a code against the pending secret and enable MFA. */
  async enableMfa(userId: string, code: string): Promise<{ enabled: true }> {
    const user = await this.mustFind(userId);
    if (!user.mfaSecret) throw new BadRequestException('Run MFA setup first');
    if (!verifyTotp(user.mfaSecret, code, Date.now())) throw new BadRequestException('Invalid MFA code');
    await this.users.update(userId, { mfaEnabled: true });
    return { enabled: true };
  }

  async disableMfa(userId: string, code: string): Promise<{ enabled: false }> {
    const user = await this.mustFind(userId);
    if (user.mfaEnabled && (!user.mfaSecret || !verifyTotp(user.mfaSecret, code, Date.now()))) {
      throw new BadRequestException('Invalid MFA code');
    }
    await this.users.update(userId, { mfaEnabled: false, mfaSecret: null });
    return { enabled: false };
  }

  private async mustFind(userId: string): Promise<User> {
    const user = await this.users.findById(userId);
    if (!user) throw new UnauthorizedException('User not found');
    return user;
  }

  private accessToken(user: User) {
    return this.jwt.signAsync(
      { sub: user.id, tenantId: user.tenantId, role: user.role, email: user.email, departmentId: user.departmentId } satisfies JwtPayload,
    );
  }
}
