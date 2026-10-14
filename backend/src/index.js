import https from 'https';
import fs from 'fs';
import axios from 'axios';
import express from 'express';
import { rateLimit } from 'express-rate-limit';

import { config, PLANS } from './config.js';
import { appAuth } from './appAuth.js';
import { YooKassaClient, YooKassaError, isAllowedConfirmationUrl } from './yookassa.js';
import { handleYooKassaNotification } from './webhook.js';
import { renderReturnPage } from './returnPage.js';
import { PaymentJournal, PaymentLedger } from './util.js';
import { SubscriptionService } from './service.js';
import { YandexClient, YandexAuthError, YandexUpstreamError } from './yandex.js';
import { signSession, userAuth } from './session.js';
import { XuiClient, XuiError } from './xui.js';

const log = {
  info: (m) => console.log(`${new Date().toISOString()} INFO  ${m}`),
  warn: (m) => console.warn(`${new Date().toISOString()} WARN  ${m}`),
  error: (m) => console.error(`${new Date().toISOString()} ERROR ${m}`),
};

const xui = new XuiClient(config.xui);
const service = new SubscriptionService({
  xui,
  subBaseUrl: config.subBaseUrl,
  trialMs: config.trialMs,
  journal: new PaymentJournal(config.dataDir),
  log,
});

const ledger = new PaymentLedger(config.dataDir);

const yookassa = new YooKassaClient({
  shopId: config.yookassa.shopId,
  secretKey: config.yookassa.secretKey,
  // validateStatus: () => true — статусы разбирает сам клиент (повторы для 202/429/5xx)
  http: axios.create({ validateStatus: () => true }),
});

const yandex = new YandexClient({
  ...config.yandex,
  http: axios.create({ validateStatus: () => true }),
});

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy); // за reverse proxy, иначе rate-limit видит один IP

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const limiter = (windowMs, limit, extra = {}) =>
  rateLimit({
    windowMs,
    limit,
    ...extra,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { success: false, error: 'too_many_requests' },
  });

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// return_url ЮKassa: кнопка/редирект «Вернуться в приложение» (deep link). Без авторизации и без данных.
app.get('/payment/return', (_req, res) => {
  res
    .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'")
    .set('Cache-Control', 'no-store')
    .type('html')
    .send(renderReturnPage(config.yookassa.appDeepLink));
});

// ───────────────────────── /api/v1/* (только приложение) ─────────────────────────
const api = express.Router();
api.use(limiter(60_000, 120));          // до проверки подписи: душим перебор
api.use(express.json({ limit: '4kb' }));
api.use(appAuth(config.appHmacSecret)); // 403, если нет/невалидны X-Device-Id, X-Timestamp, X-App-Signature

// ── Вход через Яндекс (stateless): code+PKCE → Яндекс ID → наш подписанный токен ──
const CODE_RE = /^[\w-]{1,256}$/;
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/; // RFC 7636

api.post(
  '/auth/yandex',
  limiter(60 * 60_000, 30),
  wrap(async (req, res) => {
    const { code, codeVerifier } = req.body ?? {};
    if (typeof code !== 'string' || !CODE_RE.test(code) ||
        typeof codeVerifier !== 'string' || !VERIFIER_RE.test(codeVerifier)) {
      return res.status(400).json({ success: false, error: 'bad_request' });
    }
    const { userId, login } = await yandex.login({ code, codeVerifier });
    const { token, expiresAt } = signSession({ userId, login }, config.sessionSecret, { ttlMs: config.sessionTtlMs });
    log.info(`[auth] login ${userId}`);
    res.json({ success: true, token, expiresAt, login: login ?? null });
  })
);

// Всё ниже требует Authorization: Bearer <token>; userId берётся из токена, а не из тела/query.
api.use(userAuth(config.sessionSecret));

// Скользящее продление: действующий токен → новый на полный срок (без обращения к Яндексу).
api.post('/auth/refresh', (req, res) => {
  const { token, expiresAt } = signSession({ userId: req.userId, login: req.login }, config.sessionSecret, {
    ttlMs: config.sessionTtlMs,
  });
  res.json({ success: true, token, expiresAt, login: req.login ?? null });
});

api.post(
  '/register',
  // Лимит — на ВЫДАЧУ новых триалов (главная цель злоупотреблений), а не на запросы: /register идемпотентен,
  // и каждый повторный вход существующего пользователя (выход → вход) иначе упирался бы в 429.
  wrap(async (req, _res, next) => {
    req.knownClient = await service.exists(req.userId);
    next();
  }),
  limiter(60 * 60_000, 10, { skip: (req) => req.knownClient === true }), // 10 новых регистраций в час с одного IP
  wrap(async (req, res) => {
    const r = await service.register(req.userId);
    res.json({ success: true, subLink: r.subLink, expiryTime: r.expiryTime });
  })
);

api.get(
  '/status',
  wrap(async (req, res) => {
    const s = await service.status(req.userId);
    if (!s) return res.status(404).json({ success: false, error: 'client_not_found' });
    res.json({ success: true, ...s });
  })
);

api.post(
  '/create-payment',
  limiter(60 * 60_000, 30),
  wrap(async (req, res) => {
    const planKey = req.body?.plan;
    if (typeof planKey !== 'string' || !Object.hasOwn(PLANS, planKey)) {
      return res.status(400).json({ success: false, error: 'invalid_plan' });
    }
    // Платёж только за существующего клиента.
    if (!(await service.exists(req.userId))) {
      return res.status(404).json({ success: false, error: 'client_not_found' });
    }
    const plan = PLANS[planKey];
    const payment = await yookassa.createPayment({
      amountRub: plan.price,
      description: `Продление VPN подписки на ${plan.months} мес.`,
      returnUrl: config.yookassa.returnUrl,
      // Привязка платежа к пользователю: metadata задаётся только нашим сервером и возвращается ЮKassa как есть.
      metadata: { user_id: req.userId, plan: planKey },
    });
    if (!isAllowedConfirmationUrl(payment.confirmationUrl)) {
      log.error(`[payment] unexpected confirmation_url host for payment ${payment.id}`);
      return res.status(502).json({ success: false, error: 'upstream_unavailable' });
    }
    log.info(`[payment] created ${payment.id} user=${req.userId} plan=${planKey}`);
    res.json({ success: true, paymentUrl: payment.confirmationUrl });
  })
);

app.use('/api/v1', api);

// ───────────────────────── webhook ЮKassa ─────────────────────────
// У ЮKassa НЕТ подписи уведомлений. Подлинность подтверждаем так (как рекомендует документация):
//   1) IP отправителя из списка ЮKassa (предупреждение в логе; жёсткий отказ — YOOKASSA_IP_CHECK=1);
//   2) главное: НЕ верим телу, а запрашиваем платёж у ЮKassa по id своими ключами и работаем только с ним.
// Ответ 200 — единственный «успех»: на любой другой код ЮKassa повторяет доставку 24 часа.
app.post(
  '/webhook/yookassa',
  limiter(60_000, 300),
  express.json({ limit: '100kb' }),
  wrap(async (req, res) => {
    const r = await handleYooKassaNotification(
      { yookassa, service, log, ipCheck: config.yookassa.ipCheck, ledger },
      { ip: req.ip, body: req.body }
    );
    res.status(r.status).send(r.text);
  })
);

// ───────────────────────── ошибки ─────────────────────────
app.use((_req, res) => res.status(404).json({ success: false, error: 'not_found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    return res.status(400).json({ success: false, error: 'bad_request' });
  }
  if (err instanceof YandexAuthError) {
    log.warn(`[auth] yandex rejected: ${err.message}`);
    return res.status(401).json({ success: false, error: 'invalid_code' });
  }
  if (err instanceof YandexUpstreamError || err instanceof XuiError || err instanceof YooKassaError) {
    log.error(`[upstream] ${err.message}`);
    return res.status(502).json({ success: false, error: 'upstream_unavailable' });
  }
  log.error(`[unhandled] ${err.stack ?? err}`);
  res.status(500).json({ success: false, error: 'internal_error' });
});

const httpsOptions = {
  key: fs.readFileSync(process.env.HTTPS_KEY_PATH),
  cert: fs.readFileSync(process.env.HTTPS_CERT_PATH),
};

const server = https.createServer(httpsOptions, app).listen(config.port, () => {
  log.info(`HTTPS API listening on :${config.port}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
