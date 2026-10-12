import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';

export class XuiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'XuiError';
    this.status = status;
  }
}

/**
 * Клиент MHSanaei/3x-ui.
 *
 * Авторизация (приоритет у токена):
 *  - API-токен (3x-ui >= 3.0.2): заголовок `Authorization: Bearer <token>` на КАЖДОМ запросе.
 *    Логина и cookie нет, CSRF для токена не требуется. Токен не истекает, пока его не отозвали в панели.
 *  - Логин/пароль (запасной вариант): POST {XUI_URL}/login (form: username, password) — НЕ /panel/login;
 *    на неавторизованные /panel/api/* панель отвечает 404 (прячет себя), поэтому 404/401 => повторный логин.
 *
 * Ответы панели при токене: 401 — токен неверный/отключён (в новых версиях), 404 — заголовка нет, токен не
 * поддерживается (старая панель) либо неверный webBasePath. Повторять запрос смысла нет, ошибка сразу понятная.
 *
 * clients/traffic и clients/get для несуществующего email: obj:null либо success:false "not found" (оба -> null).
 */
export class XuiClient {
  #loginPromise = null;
  #loggedIn = false;

  constructor({ url, token, username, password, inboundId, http }) {
    this.token = token?.trim() || null;
    this.username = username;
    this.password = password;
    this.inboundId = inboundId;
    if (!this.token && !(username && password)) {
      throw new XuiError('3x-ui: нужен XUI_API_TOKEN либо XUI_USERNAME + XUI_PASSWORD');
    }
    this.http =
      http ??
      wrapper(
        axios.create({
          baseURL: url,
          jar: new CookieJar(), // нужен только для режима логина; с токеном cookie не используются
          withCredentials: true,
          timeout: 10_000,
          headers: {
            Accept: 'application/json',
            ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          },
          validateStatus: () => true, // статусы разбираем сами
        })
      );
  }

  get authMode() {
    return this.token ? 'token' : 'password';
  }

  /** Режим логина: один параллельный логин на всех. В режиме токена ничего не делает. */
  login(force = false) {
    if (this.token) return Promise.resolve();
    if (this.#loggedIn && !force) return Promise.resolve();
    this.#loginPromise ??= (async () => {
      try {
        const res = await this.http.post(
          '/login',
          new URLSearchParams({ username: this.username, password: this.password }).toString(),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        if (res.status !== 200 || res.data?.success !== true) {
          throw new XuiError(`3x-ui login failed (HTTP ${res.status}): ${res.data?.msg ?? 'bad response'}`, res.status);
        }
        this.#loggedIn = true;
      } finally {
        this.#loginPromise = null;
      }
    })();
    return this.#loginPromise;
  }

  async #request(method, path, data) {
    await this.login();
    const send = () => this.http.request({ method, url: path, data });
    let res = await send();

    const unauth = (r) =>
      r.status === 401 || r.status === 404 || (typeof r.data === 'string' && /<html/i.test(r.data));
    if (unauth(res)) {
      if (this.token) {
        // Токен не «протухает», перелогиниваться нечем — сообщаем причину, а не ретраим.
        throw new XuiError(
          `3x-ui token rejected: ${method} ${path} -> HTTP ${res.status}`,
          res.status
        );
      }
      this.#loggedIn = false;
      await this.login(true);
      res = await send();
    }

    if (res.status !== 200 || res.data === null || typeof res.data !== 'object') {
      throw new XuiError(`3x-ui ${method} ${path} -> HTTP ${res.status}`, res.status);
    }
    if (res.data.success !== true) {
      throw new XuiError(`3x-ui ${method} ${path} failed: ${res.data.msg ?? 'unknown error'}`, res.status);
    }
    return res.data;
  }

  /**
   * Строка трафика клиента (enable, expiryTime, up, down...) или null, если email не найден.
   * GET /panel/api/clients/traffic/:email — одиночный объект в obj.
   */
  async getClientTraffic(email) {
    try {
      const data = await this.#request('GET', `/panel/api/clients/traffic/${encodeURIComponent(email)}`);
      const obj = Array.isArray(data.obj) ? data.obj[0] : data.obj;
      return obj ?? null;
    } catch (e) {
      if (e instanceof XuiError && /not found/i.test(e.message)) return null;
      throw e;
    }
  }

  /** Список инбаундов (для диагностики check-xui.js). */
  async listInbounds() {
    const data = await this.#request('GET', '/panel/api/inbounds/list');
    return Array.isArray(data.obj) ? data.obj : [];
  }

  /**
   * Полный объект клиента в той же форме, что принимают add/update (id = UUID, subId, flow, limitIp...).
   * GET /panel/api/clients/get/:email. Клиент в 3x-ui v3 — самостоятельная сущность, а не запись в
   * settings инбаунда, поэтому читаем его оттуда, а не из inbounds/get.
   */
  async findClient(email) {
    let data;
    try {
      data = await this.#request('GET', `/panel/api/clients/get/${encodeURIComponent(email)}`);
    } catch (e) {
      if (e instanceof XuiError && /not found/i.test(e.message)) return null;
      throw e;
    }
    return normalizeClient(data.obj);
  }

  /**
   * Создать клиента и привязать к инбаунду одним вызовом.
   * POST /panel/api/clients/add  {"client": {...}, "inboundIds": [N]}
   * Именно `inboundIds` (массив): поле `inboundId` панель молча игнорирует и отвечает
   * "at least one inbound is required".
   */
  async addClient(client) {
    await this.#request('POST', '/panel/api/clients/add', {
      client,
      inboundIds: [this.inboundId],
    });
  }

  /**
   * Обновить клиента. POST /panel/api/clients/update/:email — тело ПЛОСКИЙ объект клиента (без обёртки).
   * Сервер заменяет запись ЦЕЛИКОМ, пропущенные поля обнуляются, поэтому передавайте полный объект
   * (см. findClient). `email` в пути — ТЕКУЩИЙ email клиента. Привязка к инбаундам не меняется.
   */
  async updateClient(email, client) {
    await this.#request('POST', `/panel/api/clients/update/${encodeURIComponent(email)}`, client);
  }
}

/** Поля ответа, которых нет в модели клиента (служебные/агрегированные). */
const NON_CLIENT_KEYS = ['inboundIds', 'traffic', 'externalLinks', 'externalConfigIds', 'createdAt', 'updatedAt'];

/**
 * Приводит ответ clients/get к форме add/update. В списках панели числовой `id` — ID записи, а UUID
 * лежит в `uuid`; в add/update UUID передаётся в `id`.
 */
export function normalizeClient(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const client = { ...obj };
  for (const k of NON_CLIENT_KEYS) delete client[k];
  if (typeof client.uuid === 'string' && client.uuid) {
    client.id = client.uuid;
    delete client.uuid;
  }
  return client;
}
