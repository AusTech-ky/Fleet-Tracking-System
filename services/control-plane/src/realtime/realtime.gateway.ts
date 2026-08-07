import { Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import type { WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { RealtimePublisher } from '../integrations/ports';
import type { Position, AlertEvent } from '../domain/entities';
import type { JwtPayload } from '../common/auth';

/**
 * Live position feed over WebSocket at `/rt`. Clients connect with the JWT as a
 * query param (`/rt?token=...`) — the browser WebSocket API can't send headers.
 * Each socket is bound to its tenant; position updates fan out only to that
 * tenant's sockets. Single-node fan-out; multi-node would bridge via Redis
 * pub/sub keyed by tenant (ARCHITECTURE §3, §9).
 */
@WebSocketGateway({ path: '/rt' })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect, RealtimePublisher {
  private readonly log = new Logger(RealtimeGateway.name);
  private readonly tenantOf = new Map<WebSocket, string>();

  constructor(private readonly jwt: JwtService) {}

  handleConnection(client: WebSocket, req: IncomingMessage) {
    try {
      const url = new URL(req.url ?? '', 'http://localhost');
      const token = url.searchParams.get('token');
      if (!token) throw new Error('missing token');
      const payload = this.jwt.verify<JwtPayload>(token);
      this.tenantOf.set(client, payload.tenantId);
      client.send(JSON.stringify({ type: 'connected', tenantId: payload.tenantId }));
    } catch {
      client.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
      client.close(1008, 'unauthorized');
    }
  }

  handleDisconnect(client: WebSocket) {
    this.tenantOf.delete(client);
  }

  publish(tenantId: string, position: Position) {
    this.broadcast(tenantId, { type: 'position', position });
  }

  publishAlert(tenantId: string, alert: AlertEvent) {
    this.broadcast(tenantId, { type: 'alert', alert });
  }

  private broadcast(tenantId: string, payload: unknown) {
    const msg = JSON.stringify(payload);
    for (const [client, t] of this.tenantOf) {
      if (t === tenantId && client.readyState === 1 /* OPEN */) client.send(msg);
    }
  }
}
