import { API_URL } from './config';
import { getToken, clearToken, getRefreshToken, setTokens } from './auth';
import type {
  Device, Position, Geofence, AlertEvent, Report, ReportType, ExportFormat,
  NotificationConfig, TeamUser, Role, LoginResult, Department, BillingSummary,
  NetworkMode, MotionMode, ReportingProfile, ReportingProfileResult, AssetType,
  ImmobilizerConfig, ImmobilizerEvent,
} from './types';

export interface ReportParams {
  type: ReportType;
  deviceId?: string;
  from: string;
  to: string;
}
function reportQuery(p: ReportParams): string {
  const q = new URLSearchParams({ type: p.type, from: p.from, to: p.to });
  if (p.deviceId) q.set('deviceId', p.deviceId);
  return q.toString();
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Only the refresh token can rescue a session. When it is gone or rejected,
 * clear everything and send the user to sign in — otherwise a dead token sits
 * in localStorage while the UI still believes it is authenticated.
 */
function endSession() {
  clearToken();
  if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
    window.location.href = '/login?expired=1';
  }
}

/**
 * Exchange the refresh token for a new pair.
 *
 * Single-flight: a page load fires several requests at once, and if each one
 * refreshed independently they would rotate the token concurrently — the
 * server treats a re-used refresh token as theft and revokes the whole family,
 * logging the user out. Sharing one in-flight promise keeps rotation serial.
 */
let refreshInFlight: Promise<boolean> | null = null;

function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const refreshToken = getRefreshToken();
    if (!refreshToken) return false;
    try {
      const res = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { accessToken?: string; refreshToken?: string };
      if (!body.accessToken) return false;
      setTokens(body.accessToken, body.refreshToken);
      return true;
    } catch {
      return false; // offline: don't destroy the session over a network blip
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function send(path: string, init: RequestInit): Promise<Response> {
  const token = getToken();
  return fetch(API_URL + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
}

async function request<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  let res = await send(path, init);

  // Access token expired → refresh once, transparently, and retry.
  // Auth endpoints are excluded: a wrong password must surface inline.
  if (res.status === 401 && !retried && !path.startsWith('/auth/')) {
    if (await refreshSession()) {
      res = await send(path, init);
    } else {
      endSession();
      throw new ApiError(401, 'Your session expired — please sign in again.');
    }
  }

  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (res.status === 401 && !path.startsWith('/auth/')) {
    endSession();
    throw new ApiError(401, 'Your session expired — please sign in again.');
  }
  if (!res.ok) throw new ApiError(res.status, body?.message ?? res.statusText);
  return body as T;
}

export const api = {
  login: (email: string, password: string) =>
    request<LoginResult>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  mfaVerify: (mfaToken: string, code: string) =>
    request<{ accessToken: string; refreshToken: string }>('/auth/mfa/verify', {
      method: 'POST',
      body: JSON.stringify({ mfaToken, code }),
    }),

  mfaSetup: () => request<{ secret: string; otpauthUri: string }>('/auth/mfa/setup', { method: 'POST' }),
  mfaEnable: (code: string) => request<{ enabled: boolean }>('/auth/mfa/enable', { method: 'POST', body: JSON.stringify({ code }) }),
  mfaDisable: (code: string) => request<{ enabled: boolean }>('/auth/mfa/disable', { method: 'POST', body: JSON.stringify({ code }) }),

  notificationConfig: () => request<NotificationConfig>('/notification-config'),
  saveNotificationConfig: (body: { webhookUrls: string[]; emailRecipients: string[] }) =>
    request<NotificationConfig>('/notification-config', { method: 'PUT', body: JSON.stringify(body) }),
  testNotification: () => request<{ delivered: boolean }>('/notification-config/test', { method: 'POST' }),

  listUsers: () => request<TeamUser[]>('/users'),
  createUser: (body: { email: string; password: string; role: Role; departmentId?: string | null }) =>
    request<TeamUser>('/users', { method: 'POST', body: JSON.stringify(body) }),
  updateUser: (id: string, body: { role?: Role; active?: boolean; departmentId?: string | null; password?: string }) =>
    request<TeamUser>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  listDepartments: () => request<Department[]>('/departments'),
  createDepartment: (body: { name: string; parentId?: string | null }) =>
    request<Department>('/departments', { method: 'POST', body: JSON.stringify(body) }),
  updateDepartment: (id: string, body: { name?: string; parentId?: string | null }) =>
    request<Department>(`/departments/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteDepartment: (id: string) => request<void>(`/departments/${id}`, { method: 'DELETE' }),

  assignDeviceDepartment: (deviceId: string, departmentId: string | null) =>
    request<Device>(`/devices/${deviceId}/department`, { method: 'PATCH', body: JSON.stringify({ departmentId }) }),

  renameDevice: (deviceId: string, name: string | null) =>
    request<Device>(`/devices/${deviceId}/name`, { method: 'PATCH', body: JSON.stringify({ name }) }),

  createDevice: (body: { imei: string; model: string; name?: string | null; departmentId?: string | null; assetType?: AssetType }) =>
    request<Device>('/devices', { method: 'POST', body: JSON.stringify(body) }),
  setAssetType: (deviceId: string, assetType: AssetType) =>
    request<Device>(`/devices/${deviceId}/asset-type`, { method: 'PATCH', body: JSON.stringify({ assetType }) }),
  // --- immobilizer (starter/fuel cut) ---
  immobilizer: (deviceId: string) => request<ImmobilizerConfig>(`/devices/${deviceId}/immobilizer`),
  immobilizerHistory: (deviceId: string) => request<ImmobilizerEvent[]>(`/devices/${deviceId}/immobilizer/history`),
  configureImmobilizer: (deviceId: string, body: { enabled: boolean; dout?: number; activeHigh?: boolean; maxEngageKph?: number }) =>
    request<ImmobilizerConfig>(`/devices/${deviceId}/immobilizer`, { method: 'PUT', body: JSON.stringify(body) }),
  testImmobilizer: (deviceId: string) => request<ImmobilizerConfig>(`/devices/${deviceId}/immobilizer/test`, { method: 'POST' }),
  immobilize: (deviceId: string) => request<ImmobilizerConfig>(`/devices/${deviceId}/immobilizer/immobilize`, { method: 'POST' }),
  mobilize: (deviceId: string) => request<ImmobilizerConfig>(`/devices/${deviceId}/immobilizer/mobilize`, { method: 'POST' }),

  /** Soft delete: hides the device, keeps every position/trip/alert; restorable. */
  deleteDevice: (deviceId: string) => request<void>(`/devices/${deviceId}`, { method: 'DELETE' }),
  listDeletedDevices: () => request<Device[]>('/devices/deleted'),
  restoreDevice: (deviceId: string) => request<Device>(`/devices/${deviceId}/restore`, { method: 'POST' }),

  /** Read a tracker's reporting profile back from the device, over the air. */
  readReportingProfile: (deviceId: string, network: NetworkMode, motion: MotionMode) =>
    request<ReportingProfileResult>(`/devices/${deviceId}/config/reporting?network=${network}&motion=${motion}`),
  /** Push reporting settings to the device; returns what the device now holds. */
  writeReportingProfile: (deviceId: string, network: NetworkMode, motion: MotionMode, values: Partial<ReportingProfile>) =>
    request<ReportingProfileResult & { applied: boolean; command: string }>(
      `/devices/${deviceId}/config/reporting?network=${network}&motion=${motion}`,
      { method: 'POST', body: JSON.stringify(values) },
    ),

  billing: () => request<BillingSummary>('/billing'),
  subscribe: (planId: string) =>
    request<{ plan: { id: string } }>('/billing/subscribe', { method: 'POST', body: JSON.stringify({ planId }) }),

  registerTenant: (tenantName: string, adminEmail: string, password: string) =>
    request<{ accessToken: string; refreshToken: string }>('/auth/register-tenant', {
      method: 'POST',
      body: JSON.stringify({ tenantName, adminEmail, password }),
    }),

  listDevices: () => request<Device[]>('/devices'),

  latest: (deviceId: string) => request<Position>(`/devices/${deviceId}/latest`),

  history: (deviceId: string, from: string, to: string, limit = 2000) =>
    request<Position[]>(
      `/devices/${deviceId}/history?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=${limit}`,
    ),

  listGeofences: () => request<Geofence[]>('/geofences'),

  createGeofence: (
    body:
      | { name: string; kind: 'circle'; centerLat: number; centerLon: number; radiusM: number }
      | { name: string; kind: 'polygon'; ring: [number, number][] },
  ) => request<Geofence>('/geofences', { method: 'POST', body: JSON.stringify(body) }),

  deleteGeofence: (id: string) =>
    request<void>(`/geofences/${id}`, { method: 'DELETE' }),

  listAlerts: (deviceId?: string, limit = 50) =>
    request<AlertEvent[]>(`/alerts?limit=${limit}${deviceId ? `&deviceId=${deviceId}` : ''}`),

  report: (p: ReportParams) => request<Report>(`/reports?${reportQuery(p)}`),

  /** Clear alerts (admin). No args = all; optionally narrow by type(s) or device. */
  clearAlerts: (opts: { type?: string; deviceId?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.type) q.set('type', opts.type);
    if (opts.deviceId) q.set('deviceId', opts.deviceId);
    const qs = q.toString();
    return request<{ deleted: number }>(`/alerts${qs ? `?${qs}` : ''}`, { method: 'DELETE' });
  },

  /** Fetch an export (with auth header) as a Blob for client-side download. */
  downloadExport: async (p: ReportParams, format: ExportFormat): Promise<Blob> => {
    const token = getToken();
    const res = await fetch(`${API_URL}/reports/export?${reportQuery(p)}&format=${format}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new ApiError(res.status, 'Export failed');
    return res.blob();
  },
};
