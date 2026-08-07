/**
 * FleetView TypeScript SDK — a thin typed client over the control-plane's
 * GraphQL API (plus REST login). Zero dependencies (uses global fetch).
 *
 *   const fleet = new FleetClient({ baseUrl: 'https://api.fleetview.app' });
 *   await fleet.login('me@acme.ky', 'password');
 *   const devices = await fleet.devices();
 */

export interface Device {
  id: string;
  imei: string;
  name: string | null;
  model: string;
  status: string;
  departmentId: string | null;
  vehicleId: string | null;
}
export interface Position {
  deviceId: string;
  imei: string;
  ts: string;
  latitude: number;
  longitude: number;
  speedKph: number;
  heading: number;
  ignition: boolean | null;
}
export interface Alert {
  id: string;
  deviceId: string;
  imei: string;
  type: string;
  ts: string;
  message: string;
}
export interface Geofence {
  id: string;
  name: string;
  kind: string;
  centerLat: number | null;
  centerLon: number | null;
  radiusM: number | null;
  ring: number[][] | null;
}
export interface Me {
  userId: string;
  tenantId: string;
  email: string;
  role: string;
  departmentId: string | null;
}
export interface Billing {
  planId: string;
  planName: string;
  limits: { devices: number; users: number };
  devicesUsed: number;
  usersUsed: number;
}

export interface FleetClientOptions {
  baseUrl: string;
  token?: string;
  /** injectable fetch (defaults to global fetch) — handy for tests */
  fetch?: typeof fetch;
}

export class FleetApiError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
  }
}

export class FleetClient {
  private token: string | undefined;
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;

  constructor(opts: FleetClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.token = opts.token;
    this.doFetch = opts.fetch ?? fetch;
  }

  setToken(token: string) {
    this.token = token;
  }

  /** REST login; stores the returned access token for subsequent calls. */
  async login(email: string, password: string): Promise<void> {
    const res = await this.doFetch(`${this.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const body = (await res.json()) as { accessToken?: string; mfaRequired?: boolean };
    if (body.mfaRequired) throw new FleetApiError('MFA required — complete the challenge to obtain a token');
    if (!res.ok || !body.accessToken) throw new FleetApiError('Login failed', body);
    this.token = body.accessToken;
  }

  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await this.doFetch(`${this.baseUrl}/graphql`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (body.errors?.length) throw new FleetApiError(body.errors.map((e) => e.message).join('; '), body.errors);
    if (!body.data) throw new FleetApiError('Empty GraphQL response');
    return body.data;
  }

  me(): Promise<Me> {
    return this.gql<{ me: Me }>('{ me { userId tenantId email role departmentId } }').then((d) => d.me);
  }

  devices(): Promise<Device[]> {
    return this.gql<{ devices: Device[] }>('{ devices { id imei name model status departmentId vehicleId } }').then((d) => d.devices);
  }

  device(id: string): Promise<Device> {
    return this.gql<{ device: Device }>(
      'query($id:ID!){ device(id:$id){ id imei name model status departmentId vehicleId } }',
      { id },
    ).then((d) => d.device);
  }

  latestPosition(deviceId: string): Promise<Position | null> {
    return this.gql<{ latestPosition: Position | null }>(
      'query($id:ID!){ latestPosition(deviceId:$id){ deviceId imei ts latitude longitude speedKph heading ignition } }',
      { id: deviceId },
    ).then((d) => d.latestPosition);
  }

  geofences(): Promise<Geofence[]> {
    return this.gql<{ geofences: Geofence[] }>('{ geofences { id name kind centerLat centerLon radiusM ring } }').then((d) => d.geofences);
  }

  alerts(deviceId?: string, limit = 100): Promise<Alert[]> {
    return this.gql<{ alerts: Alert[] }>(
      'query($d:ID,$l:Int){ alerts(deviceId:$d,limit:$l){ id deviceId imei type ts message } }',
      { d: deviceId ?? null, l: limit },
    ).then((d) => d.alerts);
  }

  billing(): Promise<Billing> {
    return this.gql<{ billing: Billing }>('{ billing { planId planName limits { devices users } devicesUsed usersUsed } }').then((d) => d.billing);
  }

  provisionDevice(imei: string, model: string, departmentId?: string): Promise<Device> {
    return this.gql<{ provisionDevice: Device }>(
      'mutation($imei:String!,$model:String!,$dep:ID){ provisionDevice(imei:$imei,model:$model,departmentId:$dep){ id imei name model status departmentId vehicleId } }',
      { imei, model, dep: departmentId ?? null },
    ).then((d) => d.provisionDevice);
  }
}
