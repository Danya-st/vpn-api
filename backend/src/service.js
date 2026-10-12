import crypto from 'node:crypto';
import { DAY_MS, PLANS, UUID_RE } from './plans.js';
import { withKeyLock } from './util.js';

const FLOW = 'xtls-rprx-vision';

export class SubscriptionService {
  constructor({ xui, subBaseUrl, trialMs, journal, log = console }) {
    this.xui = xui;
    this.subBaseUrl = subBaseUrl;
    this.trialMs = trialMs;
    this.journal = journal;
    this.log = log;
  }

  subLink(client) {
    return client?.subId ? `${this.subBaseUrl}/${client.subId}` : null;
  }

  #newClient(deviceId, expiryTime, comment) {
    return {
      id: crypto.randomUUID(),
      email: deviceId,
      // Ссылка подписки 3x-ui строится по subId (а не по email). Случайный subId: подписку нельзя
      // получить, зная только deviceId.
      subId: crypto.randomBytes(8).toString('hex'),
      flow: FLOW,
      enable: true,
      expiryTime,
      limitIp: 0,
      totalGB: 0,
      tgId: 0, // числовой Telegram ID, 0 = нет (строка '' ломает разбор JSON в Go)
      comment,
      reset: 0,
    };
  }

  /** POST /register. Идемпотентно: повторный вызов возвращает уже существующего клиента. */
  register(deviceId) {
    return withKeyLock(deviceId, async () => {
      const traffic = await this.xui.getClientTraffic(deviceId); // как в ТЗ: проверка по email
      if (traffic) {
        const existing = await this.xui.findClient(deviceId);
        return {
          created: false,
          subLink: this.subLink(existing),
          expiryTime: Number(traffic.expiryTime) || 0,
        };
      }
      const client = this.#newClient(deviceId, Date.now() + this.trialMs, 'trial');
      await this.xui.addClient(client);
      this.log.info(`[register] trial issued to ${deviceId}`);
      return { created: true, subLink: this.subLink(client), expiryTime: client.expiryTime };
    });
  }

  /** GET /status. null => клиента нет (контроллер вернёт 404). */
  async status(deviceId) {
    const t = await this.xui.getClientTraffic(deviceId);
    if (!t) return null;
    const expiryTime = Number(t.expiryTime) || 0;
    return { isActive: t.enable === true && expiryTime > Date.now(), expiryTime };
  }

  async exists(deviceId) {
    return (await this.xui.getClientTraffic(deviceId)) !== null;
  }

  /**
   * Продление после оплаты. Вызывать только с проверенным webhook.
   * @returns {'applied'|'duplicate'}
   */
  applyPayment({ deviceId, planKey, paymentKey }) {
    const plan = PLANS[planKey];
    if (!plan || !UUID_RE.test(deviceId)) throw new Error('applyPayment: bad deviceId/plan');

    return withKeyLock(deviceId, async () => {
      if (this.journal.has(paymentKey)) return 'duplicate';

      const current = await this.xui.findClient(deviceId);
      const now = Date.now();

      if (!current) {
        // Клиента удалили, а деньги пришли — не теряем платёж, создаём клиента сразу на оплаченный срок.
        const fresh = this.#newClient(deviceId, now + plan.days * DAY_MS, `paid:${planKey}`);
        await this.xui.addClient(fresh);
        this.log.warn(`[payment] client ${deviceId} was missing, re-created for ${planKey}`);
      } else {
        const currentExpiry = Number(current.expiryTime) || 0;
        const base = currentExpiry > now ? currentExpiry : now;
        // updateClient заменяет клиента ЦЕЛИКОМ: берём существующий объект и меняем только срок/enable,
        // иначе пропали бы subId (сломается ссылка подписки), flow (сломается Vision), лимиты.
        const updated = { ...current, expiryTime: base + plan.days * DAY_MS, enable: true };
        await this.xui.updateClient(current.email, updated);
        this.log.info(`[payment] ${deviceId} +${plan.days}d -> ${new Date(updated.expiryTime).toISOString()}`);
      }

      // Помечаем ПОСЛЕ успешного обновления: при сбое 3x-ui вернём 500, и ЮKassa повторит доставку.
      this.journal.add(paymentKey);
      return 'applied';
    });
  }
}
