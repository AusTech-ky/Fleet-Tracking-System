import { DeviceCommandError, type DeviceCommander } from './ports';

/**
 * Talks to the ingestion service's internal `POST /commands` endpoint. That
 * endpoint holds the device's live TCP socket; we just ask it to relay a Codec
 * 12 command and hand back the reply. Never exposed publicly — reached over
 * localhost in the all-in-one container, or the private network otherwise.
 */
export class HttpDeviceCommander implements DeviceCommander {
  constructor(
    private readonly url: string,
    private readonly secret: string,
    private readonly timeoutMs = 35_000, // ingestion waits 30s for the device
  ) {}

  async send(imei: string, command: string): Promise<string> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.secret}` },
        body: JSON.stringify({ imei, command }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new DeviceCommandError('unavailable', `ingestion service unreachable: ${(err as Error).message}`);
    }
    const body = (await res.json().catch(() => ({}))) as { reply?: string; error?: string };
    if (res.ok && typeof body.reply === 'string') return body.reply;
    switch (res.status) {
      case 404: throw new DeviceCommandError('not_connected', 'Device is not currently connected — it must be online to receive settings');
      case 504: throw new DeviceCommandError('timeout', 'Device did not answer in time');
      case 503: throw new DeviceCommandError('disabled', 'Remote configuration is not enabled on the ingestion service');
      case 401: throw new DeviceCommandError('disabled', 'Ingestion rejected the command secret');
      default:  throw new DeviceCommandError('rejected', body.error ?? `ingestion returned ${res.status}`);
    }
  }
}

/**
 * In-memory stand-in for tests and the fake-data demo. Behaves like a device
 * that is online (unless told otherwise) and answers setparam/getparam from a
 * per-IMEI parameter store, so a round-trip can be asserted without sockets.
 */
export class InMemoryDeviceCommander implements DeviceCommander {
  readonly params = new Map<string, Map<number, number>>(); // imei -> id -> value
  readonly sent: Array<{ imei: string; command: string }> = [];
  /**
   * Devices are online unless explicitly disconnected — the useful default for
   * the fake-data demo and manual UI testing. Tests call disconnect() to
   * exercise the offline path, then connect() to bring it back.
   */
  readonly offline = new Set<string>();

  connect(imei: string) { this.offline.delete(imei); }
  disconnect(imei: string) { this.offline.add(imei); }

  async send(imei: string, command: string): Promise<string> {
    this.sent.push({ imei, command });
    if (this.offline.has(imei)) throw new DeviceCommandError('not_connected', 'Device is not currently connected');
    const store = this.params.get(imei) ?? new Map<number, number>();
    this.params.set(imei, store);
    if (command.startsWith('setparam ')) {
      const pairs = command.slice(9).split(';').map((p) => p.split(':').map(Number) as [number, number]);
      for (const [id, v] of pairs) store.set(id, v);
      return `New value ${command.slice(9)} was successfully applied`;
    }
    if (command.startsWith('getparam ')) {
      const ids = command.slice(9).split(';').map(Number);
      return ids.map((id) => `Param ID:${id} Val:${store.get(id) ?? 0}`).join(';');
    }
    return `Unknown command`;
  }
}
