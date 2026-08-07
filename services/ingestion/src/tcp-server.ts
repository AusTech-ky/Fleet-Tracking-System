import net from 'node:net';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { Session, type SessionDeps } from './session.ts';
import type { Config } from './config.ts';
import type { Metrics } from './metrics.ts';
import type { Logger } from './logger.ts';

/**
 * Production TCP (optionally TLS) listener. Owns the socket lifecycle, enforces
 * a max-connection cap, tracks a registry of authenticated devices for downlink
 * routing, and drains gracefully on shutdown. Stateless across nodes: devices
 * reconnect on drop, so rolling deploys lose no data (unacked records resend).
 */
export class IngestionTcpServer {
  private server: net.Server;
  private connections = new Set<net.Socket>();
  private byImei = new Map<string, Session>();
  private draining = false;

  constructor(
    private readonly config: Config,
    private readonly deps: Omit<SessionDeps, 'onAuthenticated' | 'onClose'>,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {
    const handler = (socket: net.Socket) => this.onConnection(socket);
    if (config.tls.enabled) {
      this.server = tls.createServer(
        {
          key: readFileSync(config.tls.keyPath!),
          cert: readFileSync(config.tls.certPath!),
          ca: config.tls.caPath ? readFileSync(config.tls.caPath) : undefined,
          // Teltonika devices present a pre-provisioned client cert if mTLS is set
          requestCert: !!config.tls.caPath,
          rejectUnauthorized: !!config.tls.caPath,
        },
        handler,
      );
    } else {
      this.server = net.createServer(handler);
    }
  }

  private onConnection(socket: net.Socket): void {
    if (this.draining || this.connections.size >= this.config.maxConnections) {
      socket.destroy();
      return;
    }
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    this.connections.add(socket);
    this.metrics.activeConnections.set(this.connections.size);
    socket.setKeepAlive(true, 60_000);
    socket.setTimeout(this.config.idleTimeoutMs);

    const log = this.logger.child({ peer });
    const session = new Session(
      {
        send: (buf) => { if (!socket.destroyed) socket.write(buf); },
        close: () => socket.destroy(),
      },
      {
        ...this.deps,
        logger: log,
        onAuthenticated: (imei, s) => this.byImei.set(imei, s),
        onClose: () => {},
      },
    );

    socket.on('data', (chunk) => session.onData(chunk));
    socket.on('timeout', () => { log.info('idle timeout'); socket.destroy(); });
    socket.on('error', (err) => log.debug('socket error', { err: err.message }));
    socket.on('close', () => {
      this.connections.delete(socket);
      if (session.imei) this.byImei.delete(session.imei);
      session.handleClosed();
      this.metrics.activeConnections.set(this.connections.size);
    });
  }

  /** Send a Codec 12 command to a connected device by IMEI (downlink). */
  async sendCommand(imei: string, command: string): Promise<string> {
    const session = this.byImei.get(imei);
    if (!session) throw new Error(`Device ${imei} is not currently connected`);
    return session.sendCommand(command);
  }

  isConnected(imei: string): boolean {
    return this.byImei.has(imei);
  }

  /** Actual bound port (useful when config.tcpPort is 0 for tests). */
  get port(): number {
    const a = this.server.address();
    return a && typeof a === 'object' ? a.port : this.config.tcpPort;
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      // '::' binds dual-stack (IPv4 + IPv6) — device PDP context may be either.
      this.server.listen(this.config.tcpPort, '::', () => {
        this.logger.info('tcp ingestion listening', { port: this.config.tcpPort, tls: this.config.tls.enabled });
        resolve();
      });
    });
  }

  /**
   * Stop accepting, let live sockets finish, then force-close stragglers.
   * server.close() only fires its callback once ALL connections are gone, so we
   * must initiate it, wait the grace window for clients to close, force-destroy
   * whatever remains, and only THEN await the close callback — awaiting it first
   * would deadlock against the very connections we still need to destroy.
   */
  async drain(graceMs = 15_000): Promise<void> {
    this.draining = true;
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    const deadline = Date.now() + graceMs;
    while (this.connections.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    for (const s of this.connections) s.destroy();
    await closed;
    this.logger.info('tcp server drained');
  }
}
