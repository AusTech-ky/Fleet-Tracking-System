import type { AlertEvent } from '../domain/entities';
import type { NotificationConfigRepository } from '../domain/repository';
import type { NotificationChannel } from './channels';

export interface DispatchLogger {
  warn(msg: string, fields?: Record<string, unknown>): void;
}

/**
 * Routes an alert to every configured channel for its tenant. Channels run
 * concurrently and independently — one failing (e.g. a dead webhook) never
 * blocks another (email still goes out). Delivery is best-effort/at-most-once
 * from the hot path; a production system would enqueue for guaranteed retry
 * (noted in ARCHITECTURE §12/Alerts).
 */
export class NotificationDispatcher {
  constructor(
    private readonly channels: NotificationChannel[],
    private readonly configRepo: NotificationConfigRepository,
    private readonly logger?: DispatchLogger,
  ) {}

  async dispatch(alert: AlertEvent): Promise<void> {
    const config = await this.configRepo.get(alert.tenantId);
    if (config.types && !config.types.includes(alert.type)) return;
    if (!config.webhookUrls.length && !config.emailRecipients.length) return;

    const results = await Promise.allSettled(this.channels.map((c) => c.send(alert, config)));
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        this.logger?.warn('notification channel failed', {
          channel: this.channels[i].name, alertId: alert.id, err: String(r.reason?.message ?? r.reason),
        });
      }
    });
  }
}
