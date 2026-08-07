import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  createParamDecorator,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import type { Role } from '../domain/entities';

/** Extract the underlying request from either an HTTP or a GraphQL context. */
export function requestOf(ctx: ExecutionContext): any {
  if (ctx.getType<'graphql'>() === 'graphql') {
    return GqlExecutionContext.create(ctx).getContext().req;
  }
  return ctx.switchToHttp().getRequest();
}

export interface AuthUser {
  userId: string;
  tenantId: string;
  role: Role;
  email: string;
  /** department the user is scoped to; null/undefined = tenant-wide */
  departmentId: string | null;
}

/** JWT payload shape. `purpose:'mfa'` marks a short-lived second-factor token
 *  that must NOT be accepted as an API access token. */
export interface JwtPayload {
  sub: string;
  tenantId: string;
  role: Role;
  email: string;
  departmentId?: string | null;
  purpose?: 'mfa';
}

/**
 * Authenticates the Bearer JWT and attaches AuthUser to the request. Applied
 * globally; routes opt out with @Public().
 */
export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService, private readonly reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = requestOf(ctx);
    const header: string | undefined = req.headers?.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer token');
    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(header.slice(7));
      if (payload.purpose === 'mfa') throw new UnauthorizedException('MFA token not valid for API access');
      req.user = {
        userId: payload.sub,
        tenantId: payload.tenantId,
        role: payload.role,
        email: payload.email,
        departmentId: payload.departmentId ?? null,
      } satisfies AuthUser;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
  }
}

/** RBAC: @Roles('admin','operator') restricts a route. */
export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;
    const user: AuthUser | undefined = requestOf(ctx).user;
    if (!user || !required.includes(user.role)) {
      throw new ForbiddenException('Insufficient role');
    }
    return true;
  }
}

/** @CurrentUser() injects the authenticated AuthUser (HTTP or GraphQL). */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => requestOf(ctx).user,
);
