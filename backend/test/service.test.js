import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubscriptionService } from '../src/service.js';
import { PaymentJournal } from '../src/util.js';
import { DAY_MS } from '../src/plans.js';

const DEVICE = '3f2b8c1e-7a4d-4e9b-8c3a-1d2e3f4a5b6c';
const quiet = { info() {}, warn() {}, error() {} };

/** Минимальная имитация 3x-ui: хранит клиентов, updateClient ЗАМЕНЯЕТ запись целиком (как настоящий). */
function fakeXui() {
  const clients = new Map(); // email -> client
  const calls = [];
  return {
    clients, calls,
    async getClientTraffic(email) {
      const c = clients.get(email);
      return c ? { email, enable: c.enable, expiryTime: c.expiryTime } : null;
    },
    async findClient(email) { return clients.get(email) ?? null; },
    async addClient(c) {
      calls.push('add');
      if (clients.has(c.email)) throw new Error('duplicate email');
      await new Promise((r) => setTimeout(r, 5));
      clients.set(c.email, structuredClone(c));
    },
    async updateClient(email, c) {
      calls.push('update');
      const old = clients.get(email);
      assert.ok(old, 'updateClient must be called with the current client email');
      await new Promise((r) => setTimeout(r, 5));
      clients.set(old.email, structuredClone(c)); // замена целиком
    },
  };
}

function make() {
  const xui = fakeXui();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'));
  const svc = new SubscriptionService({
    xui, subBaseUrl: 'https://h:2096/sub', trialMs: DAY_MS, journal: new PaymentJournal(dir), log: quiet,
  });
  return { xui, svc, dir };
}

test('register: trial 24h, idempotent, parallel calls create one client', async () => {
  const { xui, svc } = make();
  const [a, b] = await Promise.all([svc.register(DEVICE), svc.register(DEVICE)]);
  assert.equal(xui.calls.filter((c) => c === 'add').length, 1);
  assert.equal([a, b].filter((r) => r.created).length, 1);
  const c = xui.clients.get(DEVICE);
  assert.equal(c.flow, 'xtls-rprx-vision');
  assert.ok(c.expiryTime - Date.now() > DAY_MS - 5_000 && c.expiryTime - Date.now() <= DAY_MS);
  assert.equal(a.subLink, `https://h:2096/sub/${c.subId}`);
  assert.equal(b.subLink, a.subLink);
});

test('status: not found / active / expired', async () => {
  const { xui, svc } = make();
  assert.equal(await svc.status(DEVICE), null);
  await svc.register(DEVICE);
  assert.equal((await svc.status(DEVICE)).isActive, true);
  xui.clients.get(DEVICE).expiryTime = Date.now() - 1;
  assert.equal((await svc.status(DEVICE)).isActive, false);
  xui.clients.get(DEVICE).expiryTime = Date.now() + 1000;
  xui.clients.get(DEVICE).enable = false;
  assert.equal((await svc.status(DEVICE)).isActive, false);
});

test('payment: extends from current expiry when active, from now when expired; keeps subId/flow', async () => {
  const { xui, svc } = make();
  await svc.register(DEVICE);
  const before = structuredClone(xui.clients.get(DEVICE));

  await svc.applyPayment({ deviceId: DEVICE, planKey: '1_month', paymentKey: 'p1' });
  const afterActive = xui.clients.get(DEVICE);
  assert.equal(afterActive.expiryTime, before.expiryTime + 30 * DAY_MS);
  assert.equal(afterActive.subId, before.subId);
  assert.equal(afterActive.flow, 'xtls-rprx-vision');
  assert.equal(afterActive.id, before.id);

  afterActive.expiryTime = Date.now() - 10 * DAY_MS;
  afterActive.enable = false; // 3x-ui отключает истёкших
  const t0 = Date.now();
  await svc.applyPayment({ deviceId: DEVICE, planKey: '2_months', paymentKey: 'p2' });
  const afterExpired = xui.clients.get(DEVICE);
  assert.equal(afterExpired.enable, true);
  assert.ok(afterExpired.expiryTime >= t0 + 60 * DAY_MS && afterExpired.expiryTime <= Date.now() + 60 * DAY_MS);
});

test('payment: webhook retries and parallel duplicates credit exactly once; journal survives restart', async () => {
  const { xui, svc, dir } = make();
  await svc.register(DEVICE);
  const base = xui.clients.get(DEVICE).expiryTime;

  const results = await Promise.all(
    Array.from({ length: 5 }, () => svc.applyPayment({ deviceId: DEVICE, planKey: '3_months', paymentKey: 'same' }))
  );
  assert.equal(results.filter((r) => r === 'applied').length, 1);
  assert.equal(xui.clients.get(DEVICE).expiryTime, base + 90 * DAY_MS);

  const svc2 = new SubscriptionService({
    xui, subBaseUrl: 'x', trialMs: DAY_MS, journal: new PaymentJournal(dir), log: quiet,
  });
  assert.equal(await svc2.applyPayment({ deviceId: DEVICE, planKey: '3_months', paymentKey: 'same' }), 'duplicate');
});

test('payment: failed 3x-ui update is NOT journaled (so the YooKassa retry can succeed)', async () => {
  const { xui, svc } = make();
  await svc.register(DEVICE);
  const orig = xui.updateClient;
  xui.updateClient = async () => { throw new Error('panel down'); };
  await assert.rejects(svc.applyPayment({ deviceId: DEVICE, planKey: '1_month', paymentKey: 'retry' }));
  xui.updateClient = orig;
  assert.equal(await svc.applyPayment({ deviceId: DEVICE, planKey: '1_month', paymentKey: 'retry' }), 'applied');
});

test('payment for a deleted client re-creates it for the paid period', async () => {
  const { xui, svc } = make();
  await svc.applyPayment({ deviceId: DEVICE, planKey: '1_month', paymentKey: 'orphan' });
  const c = xui.clients.get(DEVICE);
  assert.ok(Math.abs(c.expiryTime - (Date.now() + 30 * DAY_MS)) < 5_000);
});
