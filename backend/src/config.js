function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing required env variable: ${name}`);
  return v.trim();
}
const optional = (name) => process.env[name]?.trim() || undefined;
const trimSlash = (s) => s.replace(/\/+$/, '');

const xui = {
  // Включая webBasePath панели, если он задан: http://host.docker.internal:2053/abcd1234
  url: trimSlash(required('XUI_URL')),
  token: optional('XUI_API_TOKEN'),
  username: optional('XUI_USERNAME'),
  password: optional('XUI_PASSWORD'),
  inboundId: Number(process.env.XUI_INBOUND_ID || 1),
};
if (!xui.token && !(xui.username && xui.password)) {
  throw new Error('Set XUI_API_TOKEN (recommended) or both XUI_USERNAME and XUI_PASSWORD');
}

export const config = Object.freeze({
  port: Number(process.env.PORT || 3000),
  trustProxy: Number(process.env.TRUST_PROXY ?? 1),
  dataDir: process.env.DATA_DIR || '/data',

  xui,

  // Базовый URL подписок 3x-ui, например https://vpn.example.com:2096/sub (без завершающего "/")
  subBaseUrl: trimSlash(required('SUB_BASE_URL')),

  yookassa: {
    shopId: required('YOOKASSA_SHOP_ID'),
    secretKey: required('YOOKASSA_SECRET_KEY'),
    // https-страница на вашем домене, на которую ЮKassa вернёт пользователя (см. GET /payment/return).
    returnUrl: required('YOOKASSA_RETURN_URL'),
    // Куда страница возврата отправляет пользователя в приложение (deep link).
    appDeepLink: process.env.APP_DEEPLINK || 'myvpn://payment_success',
    // 1 — отвергать вебхуки с IP вне списка ЮKassa. По умолчанию только предупреждение в логе:
    // подлинность и так подтверждается повторным запросом платежа через API.
    ipCheck: process.env.YOOKASSA_IP_CHECK === '1',
  },

  appHmacSecret: required('APP_HMAC_SECRET'),
  trialMs: 24 * 60 * 60 * 1000,
});

export { PLANS, DAY_MS, UUID_RE } from './plans.js';
