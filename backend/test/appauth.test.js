import test from 'node:test';
import assert from 'node:assert/strict';
import { computeAppSignature, verifyAppSignature, MAX_SKEW_MS } from '../src/appAuth.js';

const DEVICE = '3f2b8c1e-7a4d-4e9b-8c3a-1d2e3f4a5b6c';
const SECRET = 'app-secret';

test('app signature: valid / tampered / stale / future / bad format', () => {
  const now = 1_800_000_000_000;
  const ts = String(now);
  const sig = computeAppSignature(DEVICE, ts, SECRET);
  assert.equal(verifyAppSignature({ deviceId: DEVICE, timestamp: ts, signature: sig }, SECRET, now), true);
  assert.equal(verifyAppSignature({ deviceId: DEVICE, timestamp: ts, signature: sig }, 'other', now), false);
  assert.equal(verifyAppSignature({ deviceId: DEVICE, timestamp: ts, signature: sig.toUpperCase() }, SECRET, now), true);
  assert.equal(verifyAppSignature({ deviceId: DEVICE, timestamp: ts, signature: sig }, SECRET, now + MAX_SKEW_MS + 1), false);
  assert.equal(verifyAppSignature({ deviceId: DEVICE, timestamp: ts, signature: sig }, SECRET, now - MAX_SKEW_MS - 1), false);
  assert.equal(verifyAppSignature({ deviceId: DEVICE, timestamp: ts, signature: 'zz' }, SECRET, now), false);
  assert.equal(verifyAppSignature({ deviceId: 'not-a-uuid', timestamp: ts, signature: sig }, SECRET, now), false);
  assert.equal(verifyAppSignature({ deviceId: undefined, timestamp: ts, signature: sig }, SECRET, now), false);
});

test('app signature: cross-platform vector (matches Android AppSignerTest)', () => {
  assert.equal(
    computeAppSignature(DEVICE, '1800000000000', 'test-secret-key'),
    '1604b7df168bba30eea7be2471048fc9d90bff2346024aaff4524af14f5a3846'
  );
});
