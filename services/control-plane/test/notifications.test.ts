import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { WebhookChannel, EmailChannel, signWebhook, type FetchLike, type MailTransport } from '../src/notifications/channels';
import { NotificationDispatcher } from '../src/notifications/dispatcher';
import { emptyNotificationConfig, type AlertEvent, type NotificationConfig } from '../src/domain/entities';
import type { NotificationConfigRepository } from '../src/domain/repository';

const alert = (type: AlertEvent['type'] = 'overspeed'): AlertEvent => ({
  id: 'a1', tenantId: 'T', deviceId: 'D', imei: '860000000000001', type,
  ts: '2026-07-24T10:00:00.000Z', message: 'test', meta: {},
});
const cfg = (over: Partial<NotificationConfig>): NotificationConfig => ({ ...emptyNotificationConfig('T'), ...over });
const noSleep = () => Promise.resolve();

test('signWebhook = sha256 HMAC of the body', () => {
  const sig = signWebhook('secret', '{"a":1}');
  assert.equal(sig, `sha256=${createHmac('sha256', 'secret').update('{"a":1}').digest('hex')}`);
});

test('WebhookChannel posts to each URL with a valid signature', async () => {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetchImpl: FetchLike = async (url, init) => { calls.push({ url, ...init }); return { ok: true, status: 200 }; };
  const channel = new WebhookChannel(fetchImpl, 3, noSleep);

  await channel.send(alert(), cfg({ webhookUrls: ['http://a/hook', 'http://b/hook'], webhookSecret: 's3cr3t' }));
  assert.equal(calls.length, 2);
  const expected = signWebhook('s3cr3t', calls[0].body);
  assert.equal(calls[0].headers['x-fleet-signature'], expected);
  assert.equal(JSON.parse(calls[0].body).alert.type, 'overspeed');
});

test('WebhookChannel retries a 500 then succeeds', async () => {
  let n = 0;
  const fetchImpl: FetchLike = async () => { n++; return n < 2 ? { ok: false, status: 500 } : { ok: true, status: 200 }; };
  const channel = new WebhookChannel(fetchImpl, 3, noSleep);
  await channel.send(alert(), cfg({ webhookUrls: ['http://a'], webhookSecret: 's' }));
  assert.equal(n, 2);
});

test('WebhookChannel does not retry a 4xx and throws after exhausting retries on 5xx', async () => {
  let n4 = 0;
  await new WebhookChannel(async () => { n4++; return { ok: false, status: 400 }; }, 3, noSleep)
    .send(alert(), cfg({ webhookUrls: ['http://a'], webhookSecret: 's' }));
  assert.equal(n4, 1, '4xx is not retried');

  let n5 = 0;
  await assert.rejects(
    () => new WebhookChannel(async () => { n5++; return { ok: false, status: 503 }; }, 3, noSleep)
      .send(alert(), cfg({ webhookUrls: ['http://a'], webhookSecret: 's' })),
    /failed after 3 attempts/,
  );
  assert.equal(n5, 3);
});

test('EmailChannel sends one message per recipient', async () => {
  const sent: { to: string; subject: string }[] = [];
  const transport: MailTransport = { async sendMail(m) { sent.push({ to: m.to, subject: m.subject }); return {}; } };
  await new EmailChannel(transport).send(alert('geofence_enter'), cfg({ emailRecipients: ['a@x.co', 'b@x.co'] }));
  assert.equal(sent.length, 2);
  assert.match(sent[0].subject, /geofence enter/);
});

test('dispatcher filters by configured types', async () => {
  const seen: string[] = [];
  const channel = { name: 'x', async send(a: AlertEvent) { seen.push(a.type); } };
  const repo: NotificationConfigRepository = {
    async get() { return cfg({ webhookUrls: ['http://a'], types: ['geofence_enter'] }); },
    async set(_t, c) { return c; },
  };
  const d = new NotificationDispatcher([channel], repo);
  await d.dispatch(alert('overspeed')); // filtered out
  await d.dispatch(alert('geofence_enter')); // allowed
  assert.deepEqual(seen, ['geofence_enter']);
});

test('dispatcher: one failing channel does not block the others', async () => {
  const ok: string[] = [];
  const bad = { name: 'bad', async send() { throw new Error('down'); } };
  const good = { name: 'good', async send() { ok.push('sent'); } };
  const repo: NotificationConfigRepository = {
    async get() { return cfg({ webhookUrls: ['http://a'] }); },
    async set(_t, c) { return c; },
  };
  const warnings: string[] = [];
  const d = new NotificationDispatcher([bad, good], repo, { warn: (m) => warnings.push(m) });
  await d.dispatch(alert());
  assert.deepEqual(ok, ['sent']);
  assert.equal(warnings.length, 1);
});

test('dispatcher: no channels configured is a no-op', async () => {
  let called = false;
  const channel = { name: 'x', async send() { called = true; } };
  const repo: NotificationConfigRepository = { async get() { return emptyNotificationConfig('T'); }, async set(_t, c) { return c; } };
  await new NotificationDispatcher([channel], repo).dispatch(alert());
  assert.equal(called, false);
});
