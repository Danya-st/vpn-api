import test from 'node:test';
import assert from 'node:assert/strict';
import { XuiClient, XuiError } from '../src/xui.js';

/** Фейковый http: записывает запросы, ответы берёт из очереди/функции. */
function fakeHttp(handler) {
  const calls = [];
  return {
    calls,
    post: async (url, data, opts) => { calls.push({ method: 'POST', url, data, opts }); return handler({ method: 'POST', url }); },
    request: async (cfg) => { calls.push(cfg); return handler(cfg); },
  };
}
const ok = (obj) => ({ status: 200, data: { success: true, obj } });

test('конструктор: нужен токен либо логин+пароль', () => {
  assert.throws(() => new XuiClient({ url: 'http://x', inboundId: 1 }), XuiError);
  assert.throws(() => new XuiClient({ url: 'http://x', username: 'a', inboundId: 1 }), XuiError);
  assert.equal(new XuiClient({ url: 'http://x', token: ' t ', inboundId: 1, http: fakeHttp(() => ok(null)) }).authMode, 'token');
  assert.equal(new XuiClient({ url: 'http://x', username: 'a', password: 'b', inboundId: 1, http: fakeHttp(() => ok(null)) }).authMode, 'password');
});

test('режим токена: логин не вызывается, запрос идёт без перелогина', async () => {
  const http = fakeHttp(() => ok([{ id: 1, protocol: 'vless' }]));
  const c = new XuiClient({ url: 'http://x', token: 'tok', inboundId: 1, http });
  const list = await c.listInbounds();
  assert.equal(list.length, 1);
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].url, '/panel/api/inbounds/list');
  assert.ok(!http.calls.some((x) => x.url === '/login'));
});

test('режим токена: 401 и 404 -> XuiError "token rejected" без повторов и логина', async () => {
  for (const status of [401, 404]) {
    const http = fakeHttp(() => ({ status, data: '' }));
    const c = new XuiClient({ url: 'http://x', token: 'bad', inboundId: 1, http });
    await assert.rejects(c.listInbounds(), (e) => e instanceof XuiError && /token rejected/.test(e.message) && e.status === status);
    assert.equal(http.calls.length, 1, `status ${status}: один запрос, без ретрая`);
  }
});

test('режим токена: success=false превращается в XuiError с сообщением панели', async () => {
  const http = fakeHttp(() => ({ status: 200, data: { success: false, msg: 'boom' } }));
  const c = new XuiClient({ url: 'http://x', token: 't', inboundId: 1, http });
  await assert.rejects(c.listInbounds(), /boom/);
});

test('режим токена: getClientTraffic для неизвестного email -> null', async () => {
  const http = fakeHttp(() => ok(null));
  const c = new XuiClient({ url: 'http://x', token: 't', inboundId: 1, http });
  assert.equal(await c.getClientTraffic('nobody'), null);
});

test('режим пароля (запасной): логин, затем запрос; 404 -> один перелогин', async () => {
  let authed = false;
  const http = fakeHttp(({ url }) => {
    if (url === '/login') { authed = true; return ok(null); }
    return authed ? ok([]) : { status: 404, data: '' };
  });
  const c = new XuiClient({ url: 'http://x', username: 'a', password: 'b', inboundId: 1, http });
  await c.listInbounds();
  assert.equal(http.calls.filter((x) => x.url === '/login').length, 1);
  authed = false; // «сессия протухла»
  await c.listInbounds();
  assert.equal(http.calls.filter((x) => x.url === '/login').length, 2);
});

// ---- форма запросов к /panel/api/clients/* ----
import { normalizeClient } from '../src/xui.js';

const UUID = '550e8400-e29b-41d4-a716-446655440000';
const tokenClient = (http, inboundId = 1) => new XuiClient({ url: 'http://x', token: 't', inboundId, http });

test('addClient: POST /panel/api/clients/add с {client, inboundIds:[N]} (не inboundId!)', async () => {
  const http = fakeHttp(() => ({ status: 200, data: { success: true, msg: 'Client added' } }));
  const client = { id: UUID, email: 'test@example.com', enable: true, flow: 'xtls-rprx-vision', expiryTime: 1 };
  await tokenClient(http, 7).addClient(client);
  const call = http.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, '/panel/api/clients/add');
  assert.deepEqual(call.data, { client, inboundIds: [7] });
  assert.ok(!('inboundId' in call.data) && !('settings' in call.data));
});

test('updateClient: POST /panel/api/clients/update/:email, тело — плоский клиент', async () => {
  const http = fakeHttp(() => ({ status: 200, data: { success: true, msg: 'Client updated' } }));
  const client = { id: UUID, email: 'a b@x.com', enable: true, expiryTime: 5 };
  await tokenClient(http).updateClient('a b@x.com', client);
  assert.equal(http.calls[0].url, '/panel/api/clients/update/a%20b%40x.com');
  assert.deepEqual(http.calls[0].data, client);
});

test('findClient: нормализует ответ (uuid -> id, служебные поля убраны); неизвестный -> null', async () => {
  const http = fakeHttp(() => ok({
    id: 14, uuid: UUID, email: 'e', subId: 's', flow: 'xtls-rprx-vision', enable: true,
    inboundIds: [1], traffic: { up: 1 }, createdAt: 1, updatedAt: 2,
  }));
  const found = await tokenClient(http).findClient('e');
  assert.deepEqual(found, { id: UUID, email: 'e', subId: 's', flow: 'xtls-rprx-vision', enable: true });
  assert.equal(http.calls[0].url, '/panel/api/clients/get/e');

  assert.equal(await tokenClient(fakeHttp(() => ok(null))).findClient('nobody'), null);
  const nf = fakeHttp(() => ({ status: 200, data: { success: false, msg: 'record not found' } }));
  assert.equal(await tokenClient(nf).findClient('nobody'), null);
  assert.equal(normalizeClient(undefined), null);
});

test('getClientTraffic: GET /panel/api/clients/traffic/:email', async () => {
  const http = fakeHttp(() => ok({ email: 'e', enable: true, expiryTime: 9 }));
  const t = await tokenClient(http).getClientTraffic('e');
  assert.equal(t.expiryTime, 9);
  assert.equal(http.calls[0].url, '/panel/api/clients/traffic/e');
});
