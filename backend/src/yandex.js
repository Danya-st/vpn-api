const TOKEN_URL = 'https://oauth.yandex.ru/token';
const INFO_URL = 'https://login.yandex.ru/info';

/** Код/токен не принят Яндексом (просрочен, использован, неверный verifier) → клиенту 401. */
export class YandexAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'YandexAuthError';
  }
}
/** Яндекс недоступен или ответил непонятно → клиенту 502. */
export class YandexUpstreamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'YandexUpstreamError';
  }
}

/**
 * Серверная часть Authorization Code + PKCE.
 * Приложение открывает oauth.yandex.ru/authorize (с code_challenge) и получает `code` в redirect.
 * Обмен кода идёт ЗДЕСЬ: client_secret хранится только на сервере и в APK не попадает, а токен Яндекса
 * после получения userId нигде не сохраняется — состояния на сервере нет.
 */
export class YandexClient {
  constructor({ clientId, clientSecret, redirectUri, http }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.http = http;
  }

  async #exchange(code, codeVerifier) {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
    });
    let res;
    try {
      res = await this.http.post(TOKEN_URL, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10_000,
      });
    } catch (e) {
      throw new YandexUpstreamError(`oauth.yandex.ru unreachable: ${e.message}`);
    }
    if (res.status === 400 || res.status === 401) throw new YandexAuthError(res.data?.error ?? 'invalid_grant');
    if (res.status !== 200 || typeof res.data?.access_token !== 'string') {
      throw new YandexUpstreamError(`oauth.yandex.ru /token -> HTTP ${res.status}`);
    }
    return res.data.access_token;
  }

  async #userInfo(accessToken) {
    let res;
    try {
      res = await this.http.get(INFO_URL, {
        params: { format: 'json' },
        headers: { Authorization: `OAuth ${accessToken}` },
        timeout: 10_000,
      });
    } catch (e) {
      throw new YandexUpstreamError(`login.yandex.ru unreachable: ${e.message}`);
    }
    if (res.status === 401) throw new YandexAuthError('invalid_token');
    const id = String(res.data?.id ?? '');
    if (res.status !== 200 || !/^\d{1,20}$/.test(id)) {
      throw new YandexUpstreamError(`login.yandex.ru /info -> HTTP ${res.status}`);
    }
    return { id, login: typeof res.data.login === 'string' ? res.data.login : undefined };
  }

  /** @returns {Promise<{userId: string, login?: string}>} */
  async login({ code, codeVerifier }) {
    const accessToken = await this.#exchange(code, codeVerifier);
    const { id, login } = await this.#userInfo(accessToken);
    return { userId: `ya-${id}`, login };
  }
}
