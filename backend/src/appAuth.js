import crypto from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX64_RE = /^[0-9a-f]{64}$/i;
export const MAX_SKEW_MS = 5 * 60 * 1000;

/** hex(HMAC-SHA256(key = secret, message = deviceId + timestamp)) — ровно то же считает Android. */
export function computeAppSignature(deviceId, timestamp, secret) {
  return crypto.createHmac('sha256', secret).update(`${deviceId}${timestamp}`, 'utf8').digest('hex');
}

/** Чистая функция: тестируется без Express. */
export function verifyAppSignature({ deviceId, timestamp, signature }, secret, now = Date.now()) {
  if (typeof deviceId !== 'string' || !UUID_RE.test(deviceId)) return false;
  if (typeof timestamp !== 'string' || !/^\d{10,16}$/.test(timestamp)) return false;
  if (typeof signature !== 'string' || !HEX64_RE.test(signature)) return false;
  if (Math.abs(now - Number(timestamp)) > MAX_SKEW_MS) return false; // и старые, и «из будущего»

  const expected = Buffer.from(computeAppSignature(deviceId, timestamp, secret), 'hex');
  const actual = Buffer.from(signature, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/** Express middleware для /api/v1/*. Кладёт проверенный deviceId в req.deviceId. */
export function appAuth(secret) {
  const deny = (res) => res.status(403).json({ success: false, error: 'forbidden' });
  return (req, res, next) => {
    const deviceId = req.get('X-Device-Id');
    const ok = verifyAppSignature(
      { deviceId, timestamp: req.get('X-Timestamp'), signature: req.get('X-App-Signature') },
      secret
    );
    if (!ok) return deny(res);

    // deviceId в теле/query обязан совпадать с подписанным заголовком, иначе валидная подпись
    // одного устройства позволила бы работать с чужим клиентом.
    const supplied = req.method === 'GET' ? req.query?.deviceId : req.body?.deviceId;
    if (supplied !== undefined && supplied !== deviceId) return deny(res);

    req.deviceId = deviceId;
    next();
  };
}
