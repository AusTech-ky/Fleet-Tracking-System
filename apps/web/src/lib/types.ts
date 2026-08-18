export type DeviceStatus = 'provisioned' | 'active' | 'suspended' | 'retired';

export interface Device {
  id: string;
  tenantId: string;
  imei: string;
  name: string | null;
  model: string;
  status: DeviceStatus;
  vehicleId: string | null;
  departmentId: string | null;
  createdAt: string;
  /** soft delete marker; non-null = hidden but history kept, restorable */
  deletedAt: string | null;
}

export interface Department {
  id: string;
  tenantId: string;
  name: string;
  parentId: string | null;
  createdAt: string;
}

export interface Position {
  tenantId: string;
  deviceId: string;
  imei: string;
  ts: string;
  latitude: number;
  longitude: number;
  altitude: number;
  heading: number;
  speedKph: number;
  satellites: number;
  ignition: boolean | null;
  attrs: Record<string, number>;
}

export type DrawMode = 'none' | 'circle' | 'polygon';
export type DrawnShape =
  | { kind: 'circle'; centerLat: number; centerLon: number; radiusM: number }
  | { kind: 'polygon'; ring: [number, number][] };

export type Geofence = { id: string; tenantId: string; name: string; createdAt: string } & (
  | { kind: 'circle'; centerLat: number; centerLon: number; radiusM: number }
  | { kind: 'polygon'; ring: [number, number][] }
);

export type AlertType =
  | 'overspeed' | 'ignition_on' | 'ignition_off'
  | 'geofence_enter' | 'geofence_exit' | 'device_offline';

export interface AlertEvent {
  id: string;
  tenantId: string;
  deviceId: string;
  imei: string;
  type: AlertType;
  ts: string;
  message: string;
  meta: Record<string, string | number>;
}

export interface ReportColumn {
  key: string;
  label: string;
}
export interface Report {
  title: string;
  generatedAt: string;
  range: { from: string; to: string };
  columns: ReportColumn[];
  rows: Record<string, string | number>[];
  summary: Record<string, string | number>;
}
export type ReportType = 'trips' | 'speeding' | 'geofence' | 'summary' | 'fleet';
export type ExportFormat = 'csv' | 'xlsx' | 'pdf';

export type Role = 'admin' | 'operator' | 'viewer';
export interface TeamUser {
  id: string;
  tenantId: string;
  email: string;
  role: Role;
  active: boolean;
  mfaEnabled: boolean;
  departmentId: string | null;
  createdAt: string;
}
export interface NotificationConfig {
  tenantId: string;
  webhookUrls: string[];
  emailRecipients: string[];
  webhookSecret: string;
  types: AlertType[] | null;
}
export type LoginResult = { accessToken: string; refreshToken: string } | { mfaRequired: true; mfaToken: string };

export interface Plan {
  id: string;
  name: string;
  priceUsdMonthly: number;
  limits: { devices: number; users: number };
}
export interface BillingSummary {
  plan: Plan;
  usage: { devices: number; users: number };
  plans: Plan[];
}

/** Remote device configuration — Teltonika "records profile" (reporting cadence). */
export type NetworkMode = 'home' | 'roaming' | 'unknown';
export type MotionMode = 'stop' | 'moving';
export interface ReportingProfile {
  minPeriodSec: number;
  minDistanceM: number;
  minAngleDeg: number;
  minSpeedDeltaKph: number;
  minSavedRecords: number;
  sendPeriodSec: number;
}
export interface ReportingProfileResult {
  network: NetworkMode;
  motion: MotionMode;
  /** what the device reports it holds; fields absent if the device didn't return them */
  values: Partial<ReportingProfile>;
  raw: string;
}

/** WS envelope from the control-plane /rt feed. */
export type RtMessage =
  | { type: 'connected'; tenantId: string }
  | { type: 'position'; position: Position }
  | { type: 'alert'; alert: AlertEvent }
  | { type: 'error'; message: string };
