import { randomUUID } from 'node:crypto';
import type { Tenant, User, Device, Vehicle, Position, Geofence, AlertEvent, AlertConfig, Trip, NotificationConfig, OrgUnit, Subscription, RefreshToken } from './entities';
import { DEFAULT_ALERT_CONFIG, emptyNotificationConfig } from './entities';
import type {
  TenantRepository,
  UserRepository,
  DeviceRepository,
  OrgUnitRepository,
  VehicleRepository,
  PositionRepository,
  GeofenceRepository,
  AlertRepository,
  TripRepository,
  AlertConfigRepository,
  NotificationConfigRepository,
  SubscriptionRepository,
  RefreshTokenRepository,
} from './repository';

const now = () => new Date().toISOString();

export class InMemoryTenantRepository implements TenantRepository {
  private byId = new Map<string, Tenant>();
  async create(t: Omit<Tenant, 'createdAt'>) {
    const rec: Tenant = { ...t, createdAt: now() };
    this.byId.set(rec.id, rec);
    return rec;
  }
  async findById(id: string) {
    return this.byId.get(id) ?? null;
  }
}

export class InMemoryUserRepository implements UserRepository {
  private byId = new Map<string, User>();
  async create(u: Omit<User, 'createdAt'>) {
    const rec: User = { ...u, createdAt: now() };
    this.byId.set(rec.id, rec);
    return rec;
  }
  async findByEmail(email: string) {
    for (const u of this.byId.values()) if (u.email === email) return u;
    return null;
  }
  async findById(id: string) {
    return this.byId.get(id) ?? null;
  }
  async list(tenantId: string) {
    return [...this.byId.values()].filter((u) => u.tenantId === tenantId);
  }
  async count(tenantId: string) {
    return (await this.list(tenantId)).length;
  }
  async update(id: string, patch: Partial<User>) {
    const u = this.byId.get(id);
    if (!u) return null;
    const updated = { ...u, ...patch, id: u.id, tenantId: u.tenantId };
    this.byId.set(id, updated);
    return updated;
  }
}

export class InMemoryDeviceRepository implements DeviceRepository {
  private byId = new Map<string, Device>();
  async create(d: Omit<Device, 'createdAt'>) {
    const rec: Device = { ...d, createdAt: now() };
    this.byId.set(rec.id, rec);
    return rec;
  }
  async findById(tenantId: string, id: string) {
    const d = this.byId.get(id);
    return d && d.tenantId === tenantId ? d : null;
  }
  async findByImei(imei: string) {
    for (const d of this.byId.values()) if (d.imei === imei) return d;
    return null;
  }
  async list(tenantId: string, departmentIds?: string[]) {
    const set = departmentIds ? new Set(departmentIds) : null;
    return [...this.byId.values()].filter(
      (d) => d.tenantId === tenantId && (!set || (d.departmentId !== null && set.has(d.departmentId))),
    );
  }
  async count(tenantId: string) {
    return (await this.list(tenantId)).length;
  }
  async update(tenantId: string, id: string, patch: Partial<Device>) {
    const d = await this.findById(tenantId, id);
    if (!d) return null;
    const updated = { ...d, ...patch, id: d.id, tenantId: d.tenantId };
    this.byId.set(id, updated);
    return updated;
  }
  async remove(tenantId: string, id: string) {
    const d = await this.findById(tenantId, id);
    if (!d) return false;
    return this.byId.delete(id);
  }
  async activeImeis() {
    return [...this.byId.values()]
      .filter((d) => d.status === 'active' || d.status === 'provisioned')
      .map((d) => d.imei);
  }
}

export class InMemoryVehicleRepository implements VehicleRepository {
  private byId = new Map<string, Vehicle>();
  async create(v: Omit<Vehicle, 'createdAt'>) {
    const rec: Vehicle = { ...v, createdAt: now() };
    this.byId.set(rec.id, rec);
    return rec;
  }
  async findById(tenantId: string, id: string) {
    const v = this.byId.get(id);
    return v && v.tenantId === tenantId ? v : null;
  }
  async list(tenantId: string) {
    return [...this.byId.values()].filter((v) => v.tenantId === tenantId);
  }
  async update(tenantId: string, id: string, patch: Partial<Vehicle>) {
    const v = await this.findById(tenantId, id);
    if (!v) return null;
    const updated = { ...v, ...patch, id: v.id, tenantId: v.tenantId };
    this.byId.set(id, updated);
    return updated;
  }
}

export class InMemoryPositionRepository implements PositionRepository {
  private rows: Position[] = [];
  async insertMany(positions: Position[]) {
    this.rows.push(...positions);
  }
  async history(tenantId: string, deviceId: string, from: string, to: string, limit: number) {
    return this.rows
      .filter((p) => p.tenantId === tenantId && p.deviceId === deviceId && p.ts >= from && p.ts <= to)
      .sort((a, b) => a.ts.localeCompare(b.ts))
      .slice(0, limit);
  }
}

export class InMemoryGeofenceRepository implements GeofenceRepository {
  private byId = new Map<string, Geofence>();
  async create(g: Geofence) {
    this.byId.set(g.id, g);
    return g;
  }
  async list(tenantId: string) {
    return [...this.byId.values()].filter((g) => g.tenantId === tenantId);
  }
  async findById(tenantId: string, id: string) {
    const g = this.byId.get(id);
    return g && g.tenantId === tenantId ? g : null;
  }
  async remove(tenantId: string, id: string) {
    const g = await this.findById(tenantId, id);
    if (!g) return false;
    return this.byId.delete(id);
  }
}

export class InMemoryAlertRepository implements AlertRepository {
  private rows: AlertEvent[] = [];
  async insertMany(events: AlertEvent[]) {
    this.rows.push(...events);
  }
  async list(tenantId: string, opts: { deviceId?: string; limit: number }) {
    return this.rows
      .filter((a) => a.tenantId === tenantId && (!opts.deviceId || a.deviceId === opts.deviceId))
      .sort((a, b) => b.ts.localeCompare(a.ts)) // newest first
      .slice(0, opts.limit);
  }
}

export class InMemoryTripRepository implements TripRepository {
  private rows: Trip[] = [];
  async insert(trip: Trip) {
    this.rows.push(trip);
  }
  async list(tenantId: string, deviceId: string, from: string, to: string, limit: number) {
    return this.rows
      .filter((t) => t.tenantId === tenantId && t.deviceId === deviceId && t.startTs >= from && t.startTs <= to)
      .sort((a, b) => a.startTs.localeCompare(b.startTs))
      .slice(0, limit);
  }
}

export class InMemoryAlertConfigRepository implements AlertConfigRepository {
  private byTenant = new Map<string, AlertConfig>();
  async get(tenantId: string) {
    return this.byTenant.get(tenantId) ?? { ...DEFAULT_ALERT_CONFIG };
  }
  async set(tenantId: string, config: AlertConfig) {
    this.byTenant.set(tenantId, config);
    return config;
  }
}

export class InMemoryOrgUnitRepository implements OrgUnitRepository {
  private byId = new Map<string, OrgUnit>();
  async create(o: Omit<OrgUnit, 'createdAt'>) {
    const rec: OrgUnit = { ...o, createdAt: now() };
    this.byId.set(rec.id, rec);
    return rec;
  }
  async list(tenantId: string) {
    return [...this.byId.values()].filter((o) => o.tenantId === tenantId);
  }
  async findById(tenantId: string, id: string) {
    const o = this.byId.get(id);
    return o && o.tenantId === tenantId ? o : null;
  }
  async update(tenantId: string, id: string, patch: Partial<Pick<OrgUnit, 'name' | 'parentId'>>) {
    const o = await this.findById(tenantId, id);
    if (!o) return null;
    // Spread only the keys actually supplied, so an absent `name` doesn't blank it.
    const next: OrgUnit = { ...o };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.parentId !== undefined) next.parentId = patch.parentId;
    this.byId.set(id, next);
    return next;
  }
  /**
   * Mirrors Postgres' `parent_id ... ON DELETE CASCADE`: removing a group takes
   * its whole subtree with it. Devices are not touched here — in Postgres their
   * `department_id` is `ON DELETE SET NULL`, and a device left pointing at a
   * vanished group renders as ungrouped, which is the same end state.
   */
  async remove(tenantId: string, id: string) {
    const o = await this.findById(tenantId, id);
    if (!o) return false;
    const doomed = [id];
    for (let i = 0; i < doomed.length; i++) {
      for (const child of this.byId.values()) {
        if (child.tenantId === tenantId && child.parentId === doomed[i]) doomed.push(child.id);
      }
    }
    for (const victim of doomed) this.byId.delete(victim);
    return true;
  }
}

export class InMemoryNotificationConfigRepository implements NotificationConfigRepository {
  private byTenant = new Map<string, NotificationConfig>();
  async get(tenantId: string) {
    return this.byTenant.get(tenantId) ?? emptyNotificationConfig(tenantId);
  }
  async set(tenantId: string, config: NotificationConfig) {
    this.byTenant.set(tenantId, config);
    return config;
  }
}

export class InMemorySubscriptionRepository implements SubscriptionRepository {
  private byTenant = new Map<string, Subscription>();
  async get(tenantId: string) {
    return this.byTenant.get(tenantId) ?? null;
  }
  async set(tenantId: string, sub: Subscription) {
    this.byTenant.set(tenantId, sub);
    return sub;
  }
}

export const newId = randomUUID;

export class InMemoryRefreshTokenRepository implements RefreshTokenRepository {
  private byId = new Map<string, RefreshToken>();
  async create(t: RefreshToken) {
    this.byId.set(t.id, t);
    return t;
  }
  async findByHash(tokenHash: string) {
    for (const t of this.byId.values()) if (t.tokenHash === tokenHash) return t;
    return null;
  }
  async markUsed(id: string, usedAt: string) {
    const t = this.byId.get(id);
    if (t) this.byId.set(id, { ...t, usedAt });
  }
  async revokeFamily(familyId: string, revokedAt: string) {
    for (const [id, t] of this.byId) {
      if (t.familyId === familyId && !t.revokedAt) this.byId.set(id, { ...t, revokedAt });
    }
  }
}
