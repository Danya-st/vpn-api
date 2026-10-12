import crypto from 'node:crypto';

/*
 * Тонкий клиент API ЮKassa v3 (https://yookassa.ru/developers/api).
 *
 * Почему не npm-пакет: у ЮKassa нет официального Node.js SDK (официальные — PHP и Python), а нужные нам
 * вызовы — всего два (создать платёж, получить платёж). Клиент принимает любой axios-совместимый `http`
 * (вызов request({...}) → {status, data}), поэтому полностью тестируется без сети.
 * Интерфейс createPayment/getPayment намеренно совпадает с типичными SDK — при желании заменить легко.
 */

export class YooKassaError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = 'YooKassaError';
    this.status = status;
    this.code = code;
  }
}

const BASE_URL = 'https://api.yookassa.ru/v3';
// 202 — «запрос ещё обрабатывается»: по документации нужно повторить его с ТЕМ ЖЕ Idempotence-Key.
const RETRIABLE_STATUS = new Set([202, 429, 500, 502, 503, 504]);

export class YooKassaClient {
  constructor({
    shopId,
    secretKey,
    http,
    baseUrl = BASE_URL,
    maxAttempts = 3,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  }) {
    this.shopId = shopId;
    this.secretKey = secretKey;
    this.http = http;
    this.baseUrl = baseUrl;
    this.maxAttempts = maxAttempts;
    this.sleep = sleep;
  }

  /**
   * Платёж с автоподтверждением (capture: true) и редиректом на страницу оплаты ЮKassa.
   * metadata доступна в вебхуке и в GET /payments/{id}; задаётся только нашим сервером.
   */
  async createPayment({ amountRub, description, returnUrl, metadata, idempotenceKey = crypto.randomUUID() }) {
    const body = {
      amount: { value: amountRub.toFixed(2), currency: 'RUB' }, // строка с 2 знаками: "150.00"
      capture: true,
      confirmation: { type: 'redirect', return_url: returnUrl },
      description: description.slice(0, 128), // лимит ЮKassa — 128 символов
      metadata,
    };
    const payment = await this.#request('POST', '/payments', body, idempotenceKey);
    const confirmationUrl = payment?.confirmation?.confirmation_url;
    if (typeof payment?.id !== 'string' || typeof confirmationUrl !== 'string') {
      throw new YooKassaError('YooKassa returned a payment without confirmation_url', { status: 502 });
    }
    return { id: payment.id, status: payment.status, confirmationUrl };
  }

  /** Актуальное состояние платежа из ЮKassa — единственный источник истины для вебхука. */
  getPayment(id) {
    return this.#request('GET', `/payments/${encodeURIComponent(id)}`);
  }

  async #request(method, path, data, idempotenceKey) {
    const headers = { 'Content-Type': 'application/json' };
    if (idempotenceKey) headers['Idempotence-Key'] = idempotenceKey; // один и тот же ключ на все повторы

    for (let attempt = 1; ; attempt++) {
      const last = attempt >= this.maxAttempts;
      let res;
      try {
        res = await this.http.request({
          method,
          url: this.baseUrl + path,
          headers,
          data,
          auth: { username: this.shopId, password: this.secretKey },
          timeout: 15_000,
        });
      } catch (e) {
        if (last) throw new YooKassaError(`network error: ${e.code ?? e.message}`);
        await this.sleep(400 * attempt);
        continue;
      }

      if (res.status >= 200 && res.status < 300 && res.status !== 202) return res.data;
      if (RETRIABLE_STATUS.has(res.status) && !last) {
        await this.sleep(400 * attempt);
        continue;
      }
      // В сообщение попадают только поля ответа ЮKassa — секретный ключ в него не попадает.
      throw new YooKassaError(
        `YooKassa ${method} ${path} -> HTTP ${res.status} ${res.data?.code ?? ''} ${res.data?.description ?? ''}`.trim(),
        { status: res.status, code: res.data?.code }
      );
    }
  }
}

const CONFIRMATION_DOMAINS = ['yoomoney.ru', 'yookassa.ru'];

/** confirmation_url из документации — https://yoomoney.ru/checkout/...; чужие хосты не отдаём в приложение. */
export function isAllowedConfirmationUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && CONFIRMATION_DOMAINS.some((d) => u.hostname === d || u.hostname.endsWith(`.${d}`));
  } catch {
    return false;
  }
}
