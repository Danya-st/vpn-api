import test from 'node:test';
import assert from 'node:assert/strict';
import { describeInbound, hintForError } from '../src/xuiDiagnostics.js';

// Так 3x-ui отдаёт инбаунд: settings и streamSettings — JSON-строки
const reality = {
  id: 1, remark: 'Reality', enable: true, port: 443, protocol: 'vless',
  settings: JSON.stringify({ clients: [{ id: 'a', email: 'x' }, { id: 'b', email: 'y' }] }),
  streamSettings: JSON.stringify({ network: 'tcp', security: 'reality', realitySettings: {} }),
};

test('describeInbound: suitable VLESS+TCP+Reality', () => {
  assert.deepEqual(describeInbound(reality), {
    id: 1, remark: 'Reality', port: 443, protocol: 'vless', network: 'tcp', security: 'reality',
    enabled: true, clients: 2, suitable: true,
  });
});

test('describeInbound: unsuitable variants and broken JSON', () => {
  const mk = (over) => describeInbound({ ...reality, ...over });
  assert.equal(mk({ protocol: 'vmess' }).suitable, false);
  assert.equal(mk({ streamSettings: JSON.stringify({ network: 'ws', security: 'tls' }) }).suitable, false);
  assert.equal(mk({ streamSettings: JSON.stringify({ network: 'xhttp', security: 'reality' }) }).suitable, false);
  assert.equal(mk({ enable: false }).enabled, false);
  const broken = mk({ settings: '{oops', streamSettings: 'nope' });
  assert.equal(broken.suitable, false);
  assert.equal(broken.clients, 0);
  assert.equal(describeInbound(undefined).suitable, false);
});

test('hintForError: common failures', () => {
  assert.match(hintForError({ code: 'ENOTFOUND' }), /extra_hosts/);
  assert.match(hintForError({ code: 'ECONNREFUSED' }), /Listen IP/);
  assert.match(hintForError({ code: 'ETIMEDOUT' }), /ufw allow from 172\.16\.0\.0\/12/);
  assert.match(hintForError({ message: 'timeout of 10000ms exceeded' }), /ufw/);
  assert.match(hintForError({ message: '3x-ui login failed (HTTP 404): bad response' }), /webBasePath/);
  assert.match(hintForError({ message: '3x-ui login failed (HTTP 200): wrong username or password' }), /XUI_USERNAME/);
  assert.match(hintForError({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT', message: 'self-signed certificate' }), /http:\/\//);
  assert.match(hintForError({ message: '3x-ui token rejected: GET /panel/api/inbounds/list -> HTTP 401' }), /XUI_API_TOKEN/);
  assert.match(hintForError({ message: '3x-ui token rejected: GET /panel/api/inbounds/list -> HTTP 404' }), /3\.0\.2/);
  assert.equal(hintForError(new Error('something else')), null);
});
