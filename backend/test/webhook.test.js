import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleYooKassaNotification } from '../src/webhook.js';
import { YooKassaError } from '../src/yookassa.js';
import { SubscriptionService } from '../src/service.js';
import { PaymentJournal } from '../src/util.js';
import { DAY_MS } from '../src/plans.js';

const DEVICE = '3f2b8c1e-7a4d-4e9b-8c3a-1d2e3f4a5b6c';
const YK_IP = '185.71.76.5';
const quiet = { info() {}, warn() {}, error() {} };

function fakeXui() {
  const clients = new Map();
  return {
    clients,
    async getClientTraffic(e) { const c = clients.get(e); return c ? { email: e, enable: c.enable, expiryTime: c.expiryTime } : null; },
    async findClient(e) { return clients.get(e) ?? null; },
    async addClient(c) { clients.set(c.email, structuredClone(c)); },
    async updateClient(email, c) { assert.ok(clients.has(email)); clients.set(email, structuredClone(c)); },
  };
}

function setup(apiPayments = {}) {
  const xui = fakeXui();
  const service = new SubscriptionService({
    xui, subBaseUrl: 'https://h/sub', trialMs: DAY_MS, log: quiet,
    journal: new PaymentJournal(fs.mkdtempSync(path.join(os.tmpdir(), 'wh-'))),
  });
  let apiCalls = 0;
  const yookassa = {
    async getPayment(id) {
      apiCalls++;
      const p = apiPayments[id];
      if (p instanceof Error) throw p;
      if (!p) throw new YooKassaError('not found', { status: 404 });
      return p;
    },
  };
  const deps = { yookassa, service, log: quiet, ipCheck: false };
  return { xui, service, deps, calls: () => apiCalls };
}

const notification = (id, event = 'payment.succeeded', extra = {}) => ({ type: 'notification', event, object: { id, status: 'succeeded', ...extra } });
const realPayment = (over = {}) => ({
  id: 'pay-00000001', status: 'succeeded', paid: true, amount: { value: '280.00', currency: 'RUB' },
  metadata: { device_id: DEVICE, plan: '2_months' }, ...over,
});

test('valid payment extends subscription, answers 200; redelivery is a no-op', async () => {
  const { xui, service, deps } = setup({ 'pay-00000001': realPayment() });
  await service.register(DEVICE);
  const before = xui.clients.get(DEVICE).expiryTime;

  const r1 = await handleYooKassaNotification(deps, { ip: YK_IP, body: notification('pay-00000001') });
  assert.deepEqual(r1, { status: 200, text: 'ok' });
  assert.equal(xui.clients.get(DEVICE).expiryTime, before + 60 * DAY_MS);

  const r2 = await handleYooKassaNotification(deps, { ip: YK_IP, body: notification('pay-00000001') });
  assert.equal(r2.status, 200);
  assert.equal(xui.clients.get(DEVICE).expiryTime, before + 60 * DAY_MS); // второй раз не продлили
});

test('forged notification (payment unknown to YooKassa) → 400, nothing credited', async () => {
  const { xui, service, deps } = setup({});
  await service.register(DEVICE);
  const before = xui.clients.get(DEVICE).expiryTime;
  const r = await handleYooKassaNotification(deps, { ip: '6.6.6.6', body: notification('pay-FORGED01', 'payment.succeeded', { metadata: { device_id: DEVICE }, amount: { value: '400.00', currency: 'RUB' } }) });
  assert.equal(r.status, 400);
  assert.equal(xui.clients.get(DEVICE).expiryTime, before);
});

test('body is NOT trusted: API says pending though notification claims succeeded → ignored', async () => {
  const { xui, service, deps } = setup({ 'pay-00000002': realPayment({ id: 'pay-00000002', status: 'pending', paid: false }) });
  await service.register(DEVICE);
  const before = xui.clients.get(DEVICE).expiryTime;
  const r = await handleYooKassaNotification(deps, { ip: YK_IP, body: notification('pay-00000002') });
  assert.equal(r.status, 200);
  assert.equal(xui.clients.get(DEVICE).expiryTime, before);
});

test('metadata/amount in the notification body are ignored in favour of the API object', async () => {
  const { xui, service, deps } = setup({ 'pay-00000003': realPayment({ id: 'pay-00000003', amount: { value: '150.00', currency: 'RUB' }, metadata: { device_id: DEVICE, plan: '1_month' } }) });
  await service.register(DEVICE);
  const before = xui.clients.get(DEVICE).expiryTime;
  // тело претендует на 3 месяца, реально оплачен 1
  await handleYooKassaNotification(deps, { ip: YK_IP, body: notification('pay-00000003', 'payment.succeeded', { amount: { value: '400.00', currency: 'RUB' }, metadata: { device_id: DEVICE, plan: '3_months' } }) });
  assert.equal(xui.clients.get(DEVICE).expiryTime, before + 30 * DAY_MS);
});

test('other events are acknowledged without calling the API', async () => {
  const { deps, calls } = setup({});
  for (const ev of ['payment.canceled', 'payment.waiting_for_capture', 'refund.succeeded']) {
    assert.deepEqual(await handleYooKassaNotification(deps, { ip: YK_IP, body: notification('pay-00000004', ev) }), { status: 200, text: 'ignored' });
  }
  assert.equal(calls(), 0);
});

test('garbage bodies → 400 (no API call)', async () => {
  const { deps, calls } = setup({});
  for (const body of [undefined, {}, { type: 'x' }, { type: 'notification', event: 'payment.succeeded' },
    notification('../../etc/passwd'), notification('a'), { type: 'notification', event: 5, object: { id: 'pay-00000005' } }]) {
    assert.equal((await handleYooKassaNotification(deps, { ip: YK_IP, body })).status, 400);
  }
  assert.equal(calls(), 0);
});

test('IP check: warning only by default, 403 when enforced', async () => {
  const { deps } = setup({ 'pay-00000001': realPayment() });
  assert.equal((await handleYooKassaNotification(deps, { ip: '8.8.8.8', body: notification('pay-00000001') })).status, 200);
  assert.equal((await handleYooKassaNotification({ ...deps, ipCheck: true }, { ip: '8.8.8.8', body: notification('pay-00000001') })).status, 403);
  assert.equal((await handleYooKassaNotification({ ...deps, ipCheck: true }, { ip: '::ffff:185.71.76.5', body: notification('pay-00000001') })).status, 200);
});

test('transient failures propagate (→ non-200 so YooKassa retries) and the payment is not lost', async () => {
  const { xui, service, deps } = setup({ 'pay-00000001': realPayment() });
  await service.register(DEVICE);
  const before = xui.clients.get(DEVICE).expiryTime;

  // сбой ЮKassa API
  const flaky = { ...deps, yookassa: { async getPayment() { throw new YooKassaError('HTTP 503', { status: 503 }); } } };
  await assert.rejects(handleYooKassaNotification(flaky, { ip: YK_IP, body: notification('pay-00000001') }));

  // сбой 3x-ui при продлении
  const orig = xui.updateClient;
  xui.updateClient = async () => { throw new Error('panel down'); };
  await assert.rejects(handleYooKassaNotification(deps, { ip: YK_IP, body: notification('pay-00000001') }));
  xui.updateClient = orig;

  // повторная доставка проходит и продлевает ровно один раз
  assert.equal((await handleYooKassaNotification(deps, { ip: YK_IP, body: notification('pay-00000001') })).status, 200);
  assert.equal(xui.clients.get(DEVICE).expiryTime, before + 60 * DAY_MS);
});

test('real but unusable payment (no device_id) → 200 so YooKassa stops retrying', async () => {
  const { deps } = setup({ 'pay-00000006': realPayment({ id: 'pay-00000006', metadata: {} }) });
  assert.equal((await handleYooKassaNotification(deps, { ip: YK_IP, body: notification('pay-00000006') })).status, 200);
});

test('payment for a deleted client re-creates it', async () => {
  const { xui, deps } = setup({ 'pay-00000001': realPayment() });
  assert.equal((await handleYooKassaNotification(deps, { ip: YK_IP, body: notification('pay-00000001') })).status, 200);
  assert.ok(Math.abs(xui.clients.get(DEVICE).expiryTime - (Date.now() + 60 * DAY_MS)) < 5000);
});

test('ledger: one record per applied payment (with settlement time), none for duplicates, failures do not break the webhook', async () => {
  const { service, deps } = setup({ 'pay-00000001': realPayment({ captured_at: '2026-10-05T10:11:12.000Z' }) });
  await service.register(DEVICE);
  const records = [];
  const withLedger = { ...deps, ledger: { record: (r) => records.push(r) } };

  await handleYooKassaNotification(withLedger, { ip: YK_IP, body: notification('pay-00000001') });
  await handleYooKassaNotification(withLedger, { ip: YK_IP, body: notification('pay-00000001') }); // повтор
  assert.deepEqual(records, [{
    paidAt: '2026-10-05T10:11:12.000Z', paymentId: 'pay-00000001', amount: '280.00',
    currency: 'RUB', plan: '2_months', deviceId: DEVICE,
  }]);

  // сломанный диск: подписка уже продлена, ответ всё равно 200
  const { service: s2, deps: d2 } = setup({ 'pay-00000009': realPayment({ id: 'pay-00000009' }) });
  await s2.register(DEVICE);
  const broken = { ...d2, ledger: { record() { throw new Error('disk full'); } } };
  assert.equal((await handleYooKassaNotification(broken, { ip: YK_IP, body: notification('pay-00000009') })).status, 200);
});
