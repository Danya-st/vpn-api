import crypto from 'node:crypto';
import { USER_ID_RE } from './plans.js';

/**
 * Stateless-сессия: подписанный HS256-токен (JWT) без хранилища на сервере.
 * Всё нужное лежит в самом токене: sub = userId (`ya-<id Яндекса>`), iat, exp.
 * Подпись проверяется ключом SESSION_SECRET; смена ключа разлогинивает всех сразу.
 * Без зависимостей: достаточно node:crypto.
 */
const b64u = (v) => Buffer.from(v).toString('base64url');
// Заголовок фиксирован: токены с другим alg (в т.ч. "none") отвергаются простым сравнением строк.
const HEADER = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

const mac = (data, secret) => crypto.createHmac('sha256', secret).update(data).digest();

export const DEFAULT_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** @returns {{token: string, expiresAt: number}} expiresAt — epoch ms */
export function signSession({ userId, login }, secret, { ttlMs = DEFAULT_SESSION_TTL_MS, now = Date.now() } = {}) {
  const iat = Math.floor(now / 1000);
  const exp = iat + Math.floor(ttlMs / 1000);
  const payload = b64u(JSON.stringify({ sub: userId, iat, exp, ...(login ? { login } : {}) }));
  const sig = b64u(mac(`${HEADER}.${payload}`, secret));
  return { token: `${HEADER}.${payload}.${sig}`, expiresAt: exp * 1000 };
}

/** @returns {{userId: string, login?: string, exp: number} | null} */
export function verifySession(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 1024) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== HEADER) return null;

  const expected = mac(`${parts[0]}.${parts[1]}`, secret);
  const actual = Buffer.from(parts[2], 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;

  let claims;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof claims?.sub !== 'string' || !USER_ID_RE.test(claims.sub)) return null;
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= now) return null;
  return { userId: claims.sub, login: claims.login, exp: claims.exp * 1000 };
}

/** Express middleware: `Authorization: Bearer <token>` → req.userId. Иначе 401. */
export function userAuth(secret) {
  return (req, res, next) => {
    const m = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/.exec(req.get('Authorization') ?? '');
    const session = m && verifySession(m[1], secret);
    if (!session) return res.status(401).json({ success: false, error: 'unauthorized' });
    req.userId = session.userId;
    req.login = session.login;
    next();
  };
}
