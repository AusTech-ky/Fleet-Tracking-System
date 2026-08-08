import { Inject, Injectable, ConflictException, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hashPassword, verifyPassword } from '../../common/password';
import { TOKENS, type TenantRepository, type UserRepository, type RefreshTokenRepository } from '../../domain/repository';
import type { JwtPayload } from '../../common/auth';
import type { User } from '../../domain/entities';
import { generateSecret, otpauthUri, verifyTotp } from '../../engine/totp';
import type { RegisterTenantDto, LoginDto } from './dto';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}
/** Login result: either a token pair, or an MFA challenge. */
type LoginResult = TokenPair | { mfaRequired: true; mfaToken: string };

/** Refresh tokens are opaque random strings; only their hash is persisted. */
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

@Injectable()
export class AuthService {
  constructor(
    @Inject(TOKENS.TenantRepository) private readonly tenants: TenantRepository,
    @Inject(TOKENS.UserRepository) private readonly users: UserRepository,
    @Inject(TOKENS.RefreshTokenRepository) private readonly refreshTokens: RefreshTokenRepository,
    private readonly jwt: JwtService,
  ) {}

  /** Days a refresh token stays valid (env-tunable). */
  private get refreshDays() {
    return Number(process.env.REFRESH_EXPIRES_DAYS ?? 30);
  }

  /**
   * Mint an access token plus a refresh token. `familyId` continues an existing
   * login chain during rotation, or starts a new one at login.
   */
  private async issueTokens(user: User, familyId = randomUUID()): Promise<TokenPair> {
    const refreshToken = randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + this.refreshDays * 86_400_000).toISOString();
    await this.refreshTokens.create({
      id: randomUUID(),
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      familyId,
      expiresAt,
      usedAt: null,
      revokedAt: null,
      createdAt: new Date().toISOString(),
    });
    return { accessToken: await this.accessToken(user), refreshToken };
  }

  /**
   * Exchange a refresh token for a new pair (rotation — the old one is spent).
   *
   * If a token that was ALREADY exchanged is presented again, it has most
   * likely been stolen and replayed, so the entire family is revoked and the
   * legitimate user is forced to sign in again.
   */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const record = await this.refreshTokens.findByHash(hashToken(refreshToken));
    if (!record) throw new UnauthorizedException('Invalid refresh token');

    const now = new Date().toISOString();
    if (record.usedAt) {
      await this.refreshTokens.revokeFamily(record.familyId, now); // replay → kill the chain
      throw new UnauthorizedException('Refresh token already used — session revoked');
    }
    if (record.revokedAt) throw new UnauthorizedException('Refresh token revoked');
    if (record.expiresAt <= now) throw new UnauthorizedException('Refresh token expired');

    const user = await this.users.findById(record.userId);
    if (!user || !user.active) throw new UnauthorizedException('Account is inactive');

    await this.refreshTokens.markUsed(record.id, now);
    // Same family: rotation continues the login chain started at sign-in.
    return this.issueTokens(user, record.familyId as `${string}-${string}-${string}-${string}-${string}`);
  }

  /** Revoke the whole login chain (sign out). Idempotent by design. */
  async logout(refreshToken: string): Promise<{ success: true }> {
    const record = await this.refreshTokens.findByHash(hashToken(refreshToken));
    if (record) await this.refreshTokens.revokeFamily(record.familyId, new Date().toISOString());
    return { success: true };
  }

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
    return { tenant, ...(await this.issueTokens(user)) };
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
    return this.issueTokens(user);
  }

  /** Complete login by presenting the MFA token + a TOTP code. */
  async verifyMfa(mfaToken: string, code: string): Promise<TokenPair> {
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
    return this.issueTokens(user);
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
