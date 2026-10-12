import test from 'node:test';
import assert from 'node:assert/strict';
import { YooKassaClient, YooKassaError, isAllowedConfirmationUrl } from '../src/yookassa.js';
import { resolvePayment } from '../src/payments.js';
import { isYooKassaIp, normalizeIp } from '../src/ipAllow.js';
import { renderReturnPage } from '../src/returnPage.js';

const DEVICE = '3f2b8c1e-7a4d-4e9b-8c3a-1d2e3f4a5b6c';

/** Фейковый axios: отдаёт ответы по очереди и запоминает запросы. */
function fakeHttp(...responses) {
  const calls = [];
  return {
    calls,
    async request(cfg) {
      calls.push(cfg);
      const r = responses.shift();
      if (r instanceof Error) throw r;
      return r;
    },
  };
}
const client = (http) => new YooKassaClient({ shopId: 'shop', secretKey: 'sekret', http, sleep: async () => {} });
const created = {
  status: 200,
  data: { id: '2d1c-pay', status: 'pending', confirmation: { type: 'redirect', confirmation_url: 'https://yoomoney.ru/checkout/payments/v2/contract?orderId=2d1c' } },
};

test('createPayment: request shape (amount string, capture, redirect, metadata, auth, Idempotence-Key)', async () => {
  const http = fakeHttp(created);
  const p = await client(http).createPayment({
    amountRub: 150, description: 'Продление VPN подписки на 1 мес.',
    returnUrl: 'https://api.example.com/payment/return', metadata: { device_id: DEVICE, plan: '1_month' },
  });
  assert.deepEqual(p, { id: '2d1c-pay', status: 'pending', confirmationUrl: created.data.confirmation.confirmation_url });
  const c = http.calls[0];
  assert.equal(c.method, 'POST');
  assert.equal(c.url, 'https://api.yookassa.ru/v3/payments');
  assert.deepEqual(c.auth, { username: 'shop', password: 'sekret' });
  assert.match(c.headers['Idempotence-Key'], /^[0-9a-f-]{36}$/);
  assert.deepEqual(c.data, {
    amount: { value: '150.00', currency: 'RUB' },
    capture: true,
    confirmation: { type: 'redirect', return_url: 'https://api.example.com/payment/return' },
    description: 'Продление VPN подписки на 1 мес.',
    metadata: { device_id: DEVICE, plan: '1_month' },
  });
});

test('createPayment: retries 5xx / 202 / network error with the SAME Idempotence-Key', async () => {
  const http = fakeHttp(new Error('ECONNRESET'), { status: 202, data: {} }, created);
  const p = await client(http).createPayment({ amountRub: 280, description: 'x', returnUrl: 'https://a/b', metadata: {} });
  assert.equal(p.id, '2d1c-pay');
  assert.equal(http.calls.length, 3);
  assert.equal(new Set(http.calls.map((c) => c.headers['Idempotence-Key'])).size, 1);
});

test('createPayment: 4xx is not retried and error text has no secret', async () => {
  const http = fakeHttp({ status: 400, data: { type: 'error', code: 'invalid_request', description: 'Receipt is missing' } });
  await assert.rejects(
    client(http).createPayment({ amountRub: 150, description: 'x', returnUrl: 'https://a/b', metadata: {} }),
    (e) => e instanceof YooKassaError && e.status === 400 && e.code === 'invalid_request' && !e.message.includes('sekret')
  );
  assert.equal(http.calls.length, 1);
});

test('createPayment: gives up after maxAttempts', async () => {
  const http = fakeHttp({ status: 500, data: {} }, { status: 500, data: {} }, { status: 500, data: {} });
  await assert.rejects(client(http).createPayment({ amountRub: 150, description: 'x', returnUrl: 'https://a/b', metadata: {} }), /HTTP 500/);
  assert.equal(http.calls.length, 3);
});

test('getPayment: GET without Idempotence-Key; 404 surfaces as status 404', async () => {
  const http = fakeHttp({ status: 404, data: { type: 'error', code: 'not_found' } });
  await assert.rejects(client(http).getPayment('abc'), (e) => e.status === 404);
  assert.equal(http.calls[0].method, 'GET');
  assert.equal(http.calls[0].url, 'https://api.yookassa.ru/v3/payments/abc');
  assert.equal(http.calls[0].headers['Idempotence-Key'], undefined);
});

test('confirmation url allowlist', () => {
  assert.equal(isAllowedConfirmationUrl('https://yoomoney.ru/checkout/payments/v2/contract?orderId=1'), true);
  assert.equal(isAllowedConfirmationUrl('https://yookassa.ru/x'), true);
  assert.equal(isAllowedConfirmationUrl('http://yoomoney.ru/x'), false);
  assert.equal(isAllowedConfirmationUrl('https://yoomoney.ru.evil.com/x'), false);
  assert.equal(isAllowedConfirmationUrl('https://evilyoomoney.ru/x'), false);
  assert.equal(isAllowedConfirmationUrl('nonsense'), false);
});

const paid = (over = {}) => ({
  id: 'p1', status: 'succeeded', paid: true, amount: { value: '280.00', currency: 'RUB' },
  metadata: { device_id: DEVICE, plan: '2_months' }, ...over,
});

test('resolvePayment: happy path, fallback by amount, rejects', () => {
  assert.deepEqual(resolvePayment(paid()), { ok: true, deviceId: DEVICE, planKey: '2_months', paymentId: 'p1' });
  assert.equal(resolvePayment(paid({ metadata: { device_id: DEVICE } })).planKey, '2_months'); // по сумме
  assert.equal(resolvePayment(paid({ amount: { value: '400.00', currency: 'RUB' }, metadata: { device_id: DEVICE } })).planKey, '3_months');
  assert.equal(resolvePayment(paid({ status: 'pending', paid: false })).reason, 'not_succeeded');
  assert.equal(resolvePayment(paid({ paid: false })).reason, 'not_succeeded');
  assert.equal(resolvePayment(paid({ amount: { value: '280.00', currency: 'USD' } })).reason, 'bad_currency');
  assert.equal(resolvePayment(paid({ metadata: { plan: '2_months' } })).reason, 'no_device_id');
  assert.equal(resolvePayment(paid({ metadata: { device_id: 'x; DROP', plan: '2_months' } })).reason, 'no_device_id');
  assert.equal(resolvePayment(paid({ amount: { value: '123.00', currency: 'RUB' }, metadata: { device_id: DEVICE } })).reason, 'unknown_plan');
  assert.equal(resolvePayment(paid({ amount: { value: '150.00', currency: 'RUB' } })).reason, 'underpaid'); // plan=2_months, заплатили 150
  assert.equal(resolvePayment(paid({ metadata: { device_id: DEVICE, plan: '__proto__' }, amount: { value: '150.00', currency: 'RUB' } })).planKey, '1_month');
  assert.equal(resolvePayment(null).ok, false);
});

test('IP allowlist (IPv4, IPv6, mapped IPv6)', () => {
  for (const ip of ['185.71.76.1', '185.71.76.31', '185.71.77.5', '77.75.153.100', '77.75.156.11', '77.75.156.35',
    '77.75.154.200', '2a02:5180::1', '2a02:5180:ffff::1', '::ffff:185.71.76.5']) {
    assert.equal(isYooKassaIp(ip), true, ip);
  }
  for (const ip of ['185.71.76.32', '185.71.78.1', '77.75.153.128', '77.75.156.12', '8.8.8.8', '2a02:5181::1',
    '127.0.0.1', '::1', '', undefined, 'garbage']) {
    assert.equal(isYooKassaIp(ip), false, String(ip));
  }
  assert.equal(normalizeIp('::ffff:1.2.3.4'), '1.2.3.4');
});

test('return page: deep link is embedded and escaped', () => {
  const html = renderReturnPage('myvpn://payment_success');
  assert.match(html, /href="myvpn:\/\/payment_success"/);
  assert.match(html, /location\.href="myvpn:\/\/payment_success"/);
  assert.ok(!renderReturnPage('x"><script>alert(1)</script>').includes('"><script>alert(1)</script>'));
});
