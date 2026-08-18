/** Core domain entities. Framework-free (no NestJS/DB imports) per DDD. */

export type Role = 'admin' | 'operator' | 'viewer';
export type DeviceStatus = 'provisioned' | 'active' | 'suspended' | 'retired';

export interface Tenant {
  id: string;
  name: string;
  createdAt: string;
}

export interface User {
  id: string;
  tenantId: string;
  email: string;
  passwordHash: string;
  role: Role;
  active: boolean;
  mfaEnabled: boolean;
  mfaSecret: string | null;
  /** department the user is scoped to; null = tenant-wide access */
  departmentId: string | null;
  createdAt: string;
}

/**
 * A refresh token, stored HASHED (never in plaintext) so a database leak can't
 * be replayed. `familyId` links every token descended from one login: rotation
 * issues a new token in the same family, and if a already-used token is
 * presented again — the classic sign of theft — the whole family is revoked.
 */
export interface RefreshToken {
  id: string;
  userId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: string;
  /** set when this token has been exchanged (rotated) */
  usedAt: string | null;
  /** set when revoked by logout or reuse detection */
  revokedAt: string | null;
  createdAt: string;
}

export type SubscriptionStatus = 'active' | 'past_due' | 'canceled';

/** A tenant's billing subscription. Absent → treated as the default plan. */
export interface Subscription {
  tenantId: string;
  planId: string;
  status: SubscriptionStatus;
  createdAt: string;
}

/** A department / sub-org. Forms a tree via parentId (null = root). */
export interface OrgUnit {
  id: string;
  tenantId: string;
  name: string;
  parentId: string | null;
  createdAt: string;
}

/**
 * What kind of asset the tracker is on. Bounded so the map has an icon for
 * every value; 'other' is the catch-all (rendered as a generic tools glyph).
 */
export const ASSET_TYPES = ['car', 'motorcycle', 'bus', 'truck', 'boat', 'trailer', 'equipment', 'other'] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export interface Device {
  id: string;
  tenantId: string;
  imei: string; // 15 digits — the device identity used by ingestion auth
  /** friendly display name (e.g. "Delivery Van 3"); null = show model+IMEI */
  name: string | null;
  model: string; // e.g. "FTC927"
  /** asset category → map icon */
  assetType: AssetType;
  status: DeviceStatus;
  vehicleId: string | null;
  departmentId: string | null;
  createdAt: string;
  /**
   * Soft delete. Non-null = removed from every normal view, but the row and
   * all history keyed on this id are kept. Restorable.
   */
  deletedAt: string | null;
}

export interface Vehicle {
  id: string;
  tenantId: string;
  name: string; // fleet-facing label / plate
  deviceId: string | null;
  createdAt: string;
}

/** A geofence: a circle or polygon zone. Coordinates are GeoJSON [lon,lat]. */
export type Geofence =
  | {
      id: string;
      tenantId: string;
      name: string;
      kind: 'circle';
      centerLat: number;
      centerLon: number;
      radiusM: number;
      createdAt: string;
    }
  | {
      id: string;
      tenantId: string;
      name: string;
      kind: 'polygon';
      ring: [number, number][]; // [lon,lat] pairs
      createdAt: string;
    };

export const ALERT_TYPES = [
  'overspeed', 'ignition_on', 'ignition_off', 'geofence_enter', 'geofence_exit', 'device_offline',
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export interface AlertEvent {
  id: string;
  tenantId: string;
  deviceId: string;
  imei: string;
  type: AlertType;
  ts: string; // ISO8601
  message: string;
  meta: Record<string, string | number>;
}

/** Per-tenant alert configuration (thresholds + toggles). */
export interface AlertConfig {
  overspeedKph: number | null; // null disables overspeed
  ignitionAlerts: boolean;
  geofenceAlerts: boolean;
  offlineAfterSec: number; // device-offline threshold
}

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  overspeedKph: 90,
  ignitionAlerts: true,
  geofenceAlerts: true,
  offlineAfterSec: 600,
};

/** Per-tenant alert notification delivery config. */
export interface NotificationConfig {
  tenantId: string;
  webhookUrls: string[];
  emailRecipients: string[];
  /** HMAC key for signing webhook payloads (generated when webhooks are set). */
  webhookSecret: string;
  /** which alert types to deliver; null = all */
  types: AlertType[] | null;
}

export const emptyNotificationConfig = (tenantId: string): NotificationConfig => ({
  tenantId, webhookUrls: [], emailRecipients: [], webhookSecret: '', types: null,
});

/** A completed trip (period of continuous movement). */
export interface Trip {
  id: string;
  tenantId: string;
  deviceId: string;
  startTs: string;
  endTs: string;
  distanceM: number;
  maxSpeedKph: number;
  points: number;
}

/** A normalized telemetry record (mirrors the ingestion NormalizedTelemetry). */
export interface Position {
  tenantId: string;
  deviceId: string;
  imei: string;
  ts: string; // ISO8601 device time
  latitude: number;
  longitude: number;
  altitude: number;
  heading: number;
  speedKph: number;
  satellites: number;
  ignition: boolean | null;
  attrs: Record<string, number>;
}

export interface ImmobilizerConfig {
  deviceId: string;
  tenantId: string;
  enabled: boolean;
  dout: number;          // 1..4
  activeHigh: boolean;
  maxEngageKph: number;
  immobilized: boolean;
  lastCommand: string | null;
  lastReply: string | null;
  lastBy: string | null;
  lastAt: string | null;
  testedAt: string | null;
  createdAt: string;
}
export type ImmobilizerAction = 'immobilize' | 'mobilize' | 'test' | 'enable' | 'disable';
export interface ImmobilizerEvent {
  id: string;
  tenantId: string;
  deviceId: string;
  action: ImmobilizerAction;
  actorId: string | null;
  actorEmail: string | null;
  command: string | null;
  reply: string | null;
  ok: boolean;
  ts: string;
}
