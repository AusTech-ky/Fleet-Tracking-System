import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Metrics } from './metrics.ts';

/**
 * Health + metrics + internal command HTTP endpoint (separate port from device
 * traffic; NOT exposed publicly — the control-plane reaches it on the private
 * network / localhost inside the all-in-one container).
 *   GET  /healthz    liveness
 *   GET  /readyz     readiness (ready() gate)
 *   GET  /metrics    Prometheus exposition
 *   POST /commands   downlink a Codec 12 GPRS command to a connected device
 *                    body: { imei, command }  auth: Authorization: Bearer <secret>
 *                    200 { imei, command, reply }   404 device not connected
 *                    401 bad/missing secret          503 endpoint disabled (no secret configured)
 */
export interface CommandSender {
  sendCommand(imei: string, command: string): Promise<string>;
  isConnected(imei: string): boolean;
}

export class HealthServer {
  private server: http.Server;
  constructor(
    private readonly port: number,
    private readonly metrics: Metrics,
    private readonly ready: () => boolean,
    private readonly commands?: { sender: CommandSender; secret: string },
  ) {
    this.server = http.createServer((req, res) => {
      if (req.url === '/healthz') return this.send(res, 200, 'ok');
      if (req.url === '/readyz') return this.ready() ? this.send(res, 200, 'ready') : this.send(res, 503, 'not ready');
      if (req.url === '/metrics') {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        return void res.end(this.metrics.render());
      }
      if (req.url === '/commands' && req.method === 'POST') return void this.handleCommand(req, res);
      this.send(res, 404, 'not found');
    });
  }

  private async handleCommand(req: http.IncomingMessage, res: http.ServerResponse) {
    // Fail closed: no secret configured → endpoint does not exist.
    if (!this.commands || !this.commands.secret) return this.json(res, 503, { error: 'command endpoint disabled' });
    const auth = req.headers.authorization ?? '';
    const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!safeEqual(presented, this.commands.secret)) return this.json(res, 401, { error: 'unauthorized' });

    let body: { imei?: unknown; command?: unknown };
    try {
      body = JSON.parse(await readBody(req, 4096));
    } catch {
      return this.json(res, 400, { error: 'invalid JSON body' });
    }
    const imei = typeof body.imei === 'string' ? body.imei : '';
    const command = typeof body.command === 'string' ? body.command.trim() : '';
    if (!/^\d{15}$/.test(imei)) return this.json(res, 400, { error: 'imei must be 15 digits' });
    // A GPRS command is at most 160 chars per the wiki; refuse anything larger.
    if (!command || command.length > 160) return this.json(res, 400, { error: 'command must be 1..160 chars' });

    if (!this.commands.sender.isConnected(imei)) {
      return this.json(res, 404, { error: 'device not connected', imei });
    }
    try {
      const reply = await this.commands.sender.sendCommand(imei, command);
      return this.json(res, 200, { imei, command, reply });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A timeout means the device is on the socket but didn't answer in time.
      return this.json(res, /timed out/i.test(msg) ? 504 : 502, { error: msg, imei, command });
    }
  }

  private send(res: http.ServerResponse, code: number, body: string) {
    res.writeHead(code, { 'content-type': 'text/plain' });
    res.end(body);
  }
  private json(res: http.ServerResponse, code: number, body: unknown) {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.port, resolve));
  }
  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
  get address() {
    return this.server.address();
  }
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c: Buffer) => {
      data += c.toString('utf8');
      if (data.length > limit) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** Constant-time compare so the secret can't be probed byte by byte. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
