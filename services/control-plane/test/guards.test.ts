import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard, JwtAuthGuard, ROLES_KEY, IS_PUBLIC } from '../src/common/auth';
import type { Role } from '../src/domain/entities';

function ctx(user: { role: Role } | undefined) {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as any;
}

function reflectorReturning(value: unknown): Reflector {
  const r = new Reflector();
  (r as any).getAllAndOverride = () => value;
  return r;
}

test('RolesGuard allows a matching role', () => {
  const guard = new RolesGuard(reflectorReturning(['admin', 'operator'] satisfies Role[]));
  assert.equal(guard.canActivate(ctx({ role: 'operator' })), true);
});

test('RolesGuard forbids a non-matching role (viewer provisioning)', () => {
  const guard = new RolesGuard(reflectorReturning(['admin', 'operator'] satisfies Role[]));
  assert.throws(() => guard.canActivate(ctx({ role: 'viewer' })), ForbiddenException);
});

test('RolesGuard is open when no roles are required', () => {
  const guard = new RolesGuard(reflectorReturning(undefined));
  assert.equal(guard.canActivate(ctx({ role: 'viewer' })), true);
});

test('JwtAuthGuard bypasses auth for @Public routes', async () => {
  const jwt = { verifyAsync: async () => ({}) } as any;
  const guard = new JwtAuthGuard(jwt, reflectorReturning(true)); // IS_PUBLIC = true
  assert.equal(await guard.canActivate(ctx(undefined)), true);
});

test('JwtAuthGuard rejects a missing bearer token on protected routes', async () => {
  const jwt = { verifyAsync: async () => ({}) } as any;
  const guard = new JwtAuthGuard(jwt, reflectorReturning(false));
  await assert.rejects(() => guard.canActivate(ctx(undefined)));
});

// Reference the exported keys so they are covered/imported.
test('metadata keys are defined', () => {
  assert.equal(ROLES_KEY, 'roles');
  assert.equal(IS_PUBLIC, 'isPublic');
});
