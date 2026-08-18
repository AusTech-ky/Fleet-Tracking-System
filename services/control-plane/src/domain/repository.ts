import type {
  ImmobilizerConfig, ImmobilizerEvent, Tenant, User, Device, Vehicle, Position, Geofence, AlertEvent, AlertConfig, Trip, NotificationConfig, OrgUnit, Subscription, RefreshToken } from './entities';

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

/**
 * Devices are soft-deleted: `deletedAt` set, row kept, history preserved.
 * Every read here EXCLUDES deleted rows unless the method says otherwise —
 * so callers can't accidentally surface a deleted device or attach new
 * telemetry to it. `findById` takes an opt-in flag for the restore path.
 */
export interface DeviceRepository {
  create(d: Omit<Device, 'createdAt' | 'deletedAt'>): Promise<Device>;
  findById(tenantId: string, id: string, opts?: { includeDeleted?: boolean }): Promise<Device | null>;
  /** Live device with this IMEI (deleted rows keep their IMEI but never match here). */
  findByImei(imei: string): Promise<Device | null>;
  /** List a tenant's LIVE devices; if departmentIds is given, only those departments. */
  list(tenantId: string, departmentIds?: string[]): Promise<Device[]>;
  /** A tenant's soft-deleted devices, for the "recently deleted" view / restore. */
  listDeleted(tenantId: string): Promise<Device[]>;
  /** Live device count (quota checks). */
  count(tenantId: string): Promise<number>;
  update(tenantId: string, id: string, patch: Partial<Device>): Promise<Device | null>;
  /** Soft delete: stamps deletedAt. Returns false if not found or already deleted. */
  softDelete(tenantId: string, id: string, at: string): Promise<boolean>;
  /** Undo a soft delete. Returns false if not found / not deleted / IMEI now taken by a live row. */
  restore(tenantId: string, id: string): Promise<boolean>;
  /** IMEIs of all LIVE devices allowed to send (status active/provisioned), all tenants. */
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
export interface ImmobilizerRepository {
  get(tenantId: string, deviceId: string): Promise<ImmobilizerConfig | null>;
  /** Create-or-update the config row. */
  upsert(cfg: ImmobilizerConfig): Promise<ImmobilizerConfig>;
  patch(tenantId: string, deviceId: string, patch: Partial<ImmobilizerConfig>): Promise<ImmobilizerConfig | null>;
  addEvent(e: ImmobilizerEvent): Promise<void>;
  events(tenantId: string, deviceId: string, limit: number): Promise<ImmobilizerEvent[]>;
}

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
  ImmobilizerRepository: 'ImmobilizerRepository',
} as const;
