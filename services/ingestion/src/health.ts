import http from 'node:http';
import type { Metrics } from './metrics.ts';

/**
 * Health + metrics HTTP endpoint (separate port from device traffic).
 *   GET /healthz  liveness
 *   GET /readyz   readiness (ready() gate)
 *   GET /metrics  Prometheus exposition
 */
export class HealthServer {
  private server: http.Server;
  constructor(
    private readonly port: number,
    private readonly metrics: Metrics,
    private readonly ready: () => boolean,
  ) {
    this.server = http.createServer((req, res) => {
      if (req.url === '/healthz') return this.send(res, 200, 'ok');
      if (req.url === '/readyz') return this.ready() ? this.send(res, 200, 'ready') : this.send(res, 503, 'not ready');
      if (req.url === '/metrics') {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        return void res.end(this.metrics.render());
      }
      this.send(res, 404, 'not found');
    });
  }
  private send(res: http.ServerResponse, code: number, body: string) {
    res.writeHead(code, { 'content-type': 'text/plain' });
    res.end(body);
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
