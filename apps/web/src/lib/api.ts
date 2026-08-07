import { API_URL } from './config';
import { getToken } from './auth';
import type {
  Device, Position, Geofence, AlertEvent, Report, ReportType, ExportFormat,
  NotificationConfig, TeamUser, Role, LoginResult, Department, BillingSummary,
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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(API_URL + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
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
    request<{ accessToken: string }>('/auth/mfa/verify', {
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
  updateUser: (id: string, body: { role?: Role; active?: boolean; departmentId?: string | null }) =>
    request<TeamUser>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  listDepartments: () => request<Department[]>('/departments'),
  createDepartment: (body: { name: string; parentId?: string | null }) =>
    request<Department>('/departments', { method: 'POST', body: JSON.stringify(body) }),
  deleteDepartment: (id: string) => request<void>(`/departments/${id}`, { method: 'DELETE' }),

  assignDeviceDepartment: (deviceId: string, departmentId: string | null) =>
    request<Device>(`/devices/${deviceId}/department`, { method: 'PATCH', body: JSON.stringify({ departmentId }) }),

  renameDevice: (deviceId: string, name: string | null) =>
    request<Device>(`/devices/${deviceId}/name`, { method: 'PATCH', body: JSON.stringify({ name }) }),

  billing: () => request<BillingSummary>('/billing'),
  subscribe: (planId: string) =>
    request<{ plan: { id: string } }>('/billing/subscribe', { method: 'POST', body: JSON.stringify({ planId }) }),

  registerTenant: (tenantName: string, adminEmail: string, password: string) =>
    request<{ accessToken: string }>('/auth/register-tenant', {
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
