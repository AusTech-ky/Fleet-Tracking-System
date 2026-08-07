import nodemailer from 'nodemailer';
import { WebhookChannel, EmailChannel, type FetchLike, type MailTransport } from './channels';
import { NotificationDispatcher, type DispatchLogger } from './dispatcher';
import type { NotificationConfigRepository } from '../domain/repository';

/** FetchLike over the global fetch (only the fields the channel needs). */
const webhookFetch: FetchLike = async (url, init) => {
  const r = await fetch(url, init);
  return { ok: r.ok, status: r.status };
};

/** SMTP transport when SMTP_URL is set; otherwise a dev transport that logs. */
function mailTransport(): MailTransport {
  const url = process.env.SMTP_URL;
  if (url) return nodemailer.createTransport(url) as unknown as MailTransport;
  return {
    async sendMail(msg) {
      // eslint-disable-next-line no-console
      console.log(`[email:dev] to=${msg.to} subject="${msg.subject}"`);
      return {};
    },
  };
}

export function buildNotificationDispatcher(
  configRepo: NotificationConfigRepository,
  logger?: DispatchLogger,
): NotificationDispatcher {
  const channels = [new WebhookChannel(webhookFetch), new EmailChannel(mailTransport())];
  return new NotificationDispatcher(channels, configRepo, logger);
}
