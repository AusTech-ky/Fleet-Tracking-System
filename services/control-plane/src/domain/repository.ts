import type { Tenant, User, Device, Vehicle, Position, Geofence, AlertEvent, AlertConfig, Trip, NotificationConfig, OrgUnit, Subscription, RefreshToken } from './entities';

/**
 * Persistence seam. The API/consumer depend on these interfaces, never on a
 * concrete DB. Production uses the pg/PostGIS implementation; tests use the
 * in-memory one — so the whole service is provable without a database
 * (ARCHITECTURE §2, §5). Every method is tenant-scoped to enforce isolation.
 */
export interface TenantRepository {
  create(t: Omit<Tenant, 'createdAt'>): Promise<Tenant>;
  findById(id: string): Promise<Tenant | null>;
}

export interface UserRepository {
  create(u: Omit<User, 'createdAt'>): Promise<User>;
  findByEmail(email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  list(tenantId: string): Promise<User[]>;
  count(tenantId: string): Promise<number>;
  update(id: string, patch: Partial<User>): Promise<User | null>;
}

export interface RefreshTokenRepository {
  create(t: RefreshToken): Promise<RefreshToken>;
  findByHash(tokenHash: string): Promise<RefreshToken | null>;
  /** mark a token as exchanged (one-time use) */
  markUsed(id: string, usedAt: string): Promise<void>;
  /** revoke every non-revoked token in a family (logout / reuse detected) */
  revokeFamily(familyId: string, revokedAt: string): Promise<void>;
}

export interface SubscriptionRepository {
  get(tenantId: string): Promise<Subscription | null>;
  set(tenantId: string, sub: Subscription): Promise<Subscription>;
}

export interface DeviceRepository {
  create(d: Omit<Device, 'createdAt'>): Promise<Device>;
  findById(tenantId: string, id: string): Promise<Device | null>;
  findByImei(imei: string): Promise<Device | null>;
  /** List a tenant's devices; if departmentIds is given, only those departments. */
  list(tenantId: string, departmentIds?: string[]): Promise<Device[]>;
  count(tenantId: string): Promise<number>;
  update(tenantId: string, id: string, patch: Partial<Device>): Promise<Device | null>;
  remove(tenantId: string, id: string): Promise<boolean>;
  /** IMEIs of all devices allowed to send (status active/provisioned), all tenants. */
  activeImeis(): Promise<string[]>;
}

export interface OrgUnitRepository {
  create(o: Omit<OrgUnit, 'createdAt'>): Promise<OrgUnit>;
  list(tenantId: string): Promise<OrgUnit[]>;
  findById(tenantId: string, id: string): Promise<OrgUnit | null>;
  /** Rename and/or re-parent. Only the keys present in `patch` are written. */
  update(tenantId: string, id: string, patch: Partial<Pick<OrgUnit, 'name' | 'parentId'>>): Promise<OrgUnit | null>;
  remove(tenantId: string, id: string): Promise<boolean>;
}

export interface VehicleRepository {
  create(v: Omit<Vehicle, 'createdAt'>): Promise<Vehicle>;
  findById(tenantId: string, id: string): Promise<Vehicle | null>;
  list(tenantId: string): Promise<Vehicle[]>;
  update(tenantId: string, id: string, patch: Partial<Vehicle>): Promise<Vehicle | null>;
}

export interface PositionRepository {
  insertMany(positions: Position[]): Promise<void>;
  /** history for a device within a time range, ascending */
  history(tenantId: string, deviceId: string, from: string, to: string, limit: number): Promise<Position[]>;
  /**
   * Most recent position for a device, from durable storage. The Redis
   * hot-state is the fast path; this is the source of truth it falls back to
   * (and is re-warmed from) when that key is missing.
   */
  latest(tenantId: string, deviceId: string): Promise<Position | null>;
}

export interface GeofenceRepository {
  create(g: Geofence): Promise<Geofence>;
  list(tenantId: string): Promise<Geofence[]>;
  findById(tenantId: string, id: string): Promise<Geofence | null>;
  remove(tenantId: string, id: string): Promise<boolean>;
}

export interface AlertRepository {
  insertMany(events: AlertEvent[]): Promise<void>;
  list(tenantId: string, opts: { deviceId?: string; limit: number }): Promise<AlertEvent[]>;
}

export interface TripRepository {
  insert(trip: Trip): Promise<void>;
  list(tenantId: string, deviceId: string, from: string, to: string, limit: number): Promise<Trip[]>;
}

/** Per-tenant alert configuration (thresholds/toggles); defaults if unset. */
export interface AlertConfigRepository {
  get(tenantId: string): Promise<AlertConfig>;
  set(tenantId: string, config: AlertConfig): Promise<AlertConfig>;
}

export interface NotificationConfigRepository {
  get(tenantId: string): Promise<NotificationConfig>;
  set(tenantId: string, config: NotificationConfig): Promise<NotificationConfig>;
}

/** DI tokens (interfaces don't exist at runtime, so DI uses string tokens). */
export const TOKENS = {
  TenantRepository: 'TenantRepository',
  UserRepository: 'UserRepository',
  DeviceRepository: 'DeviceRepository',
  OrgUnitRepository: 'OrgUnitRepository',
  VehicleRepository: 'VehicleRepository',
  PositionRepository: 'PositionRepository',
  GeofenceRepository: 'GeofenceRepository',
  AlertRepository: 'AlertRepository',
  TripRepository: 'TripRepository',
  AlertConfigRepository: 'AlertConfigRepository',
  NotificationConfigRepository: 'NotificationConfigRepository',
  NotificationDispatcher: 'NotificationDispatcher',
  SubscriptionRepository: 'SubscriptionRepository',
  RefreshTokenRepository: 'RefreshTokenRepository',
  PaymentProvider: 'PaymentProvider',
  HotState: 'HotState',
  AllowListPublisher: 'AllowListPublisher',
  TelemetryBus: 'TelemetryBus',
  RealtimePublisher: 'RealtimePublisher',
  DeviceCommander: 'DeviceCommander',
} as const;
