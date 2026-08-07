import { createHmac } from 'node:crypto';
import type { AlertEvent, NotificationConfig } from '../domain/entities';

/**
 * Notification delivery channels. Each channel takes an alert + the tenant's
 * config and delivers it. Kept behind an interface with injected transports
 * (fetch, mailer) so they are fully unit-testable without real network/SMTP.
 */
export interface NotificationChannel {
  readonly name: string;
  send(alert: AlertEvent, config: NotificationConfig): Promise<void>;
}

export type FetchLike = (url: string, init: {
  method: string; headers: Record<string, string>; body: string;
}) => Promise<{ ok: boolean; status: number }>;

/** Sign a webhook body: hex HMAC-SHA256 of the raw body with the tenant secret. */
export function signWebhook(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * Outbound webhook channel. POSTs the alert as JSON to each configured URL with
 * an X-Fleet-Signature header, retrying transient failures with backoff.
 */
export class WebhookChannel implements NotificationChannel {
  readonly name = 'webhook';
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly retries = 3,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async send(alert: AlertEvent, config: NotificationConfig): Promise<void> {
    if (!config.webhookUrls.length) return;
    const body = JSON.stringify({ type: 'alert', alert });
    const signature = signWebhook(config.webhookSecret, body);
    await Promise.all(config.webhookUrls.map((url) => this.deliver(url, body, signature)));
  }

  private async deliver(url: string, body: string, signature: string): Promise<void> {
    for (let attempt = 1; attempt <= this.retries; attempt++) {
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-fleet-signature': signature },
          body,
        });
        if (res.ok) return;
        if (res.status < 500 && res.status !== 429) return; // 4xx (except 429) = don't retry
      } catch {
        // network error → retry
      }
      if (attempt < this.retries) await this.sleep(200 * attempt);
    }
    throw new Error(`webhook delivery to ${url} failed after ${this.retries} attempts`);
  }
}

/** Minimal mail transport (satisfied by nodemailer's createTransport().sendMail). */
export interface MailTransport {
  sendMail(msg: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

/** Email channel — one message per recipient (BCC-style fan-out kept simple). */
export class EmailChannel implements NotificationChannel {
  readonly name = 'email';
  constructor(private readonly transport: MailTransport, private readonly from = 'alerts@fleetview.app') {}

  async send(alert: AlertEvent, config: NotificationConfig): Promise<void> {
    if (!config.emailRecipients.length) return;
    const subject = `[FleetView] ${alert.type.replace(/_/g, ' ')} — ${alert.imei}`;
    const text = `${alert.message}\n\nDevice IMEI: ${alert.imei}\nTime: ${alert.ts}\nType: ${alert.type}`;
    await Promise.all(
      config.emailRecipients.map((to) => this.transport.sendMail({ from: this.from, to, subject, text })),
    );
  }
}
