import crypto from 'node:crypto';
import { DAY_MS, PLANS, isSubjectId } from './plans.js';
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

  #newClient(userId, expiryTime, comment) {
    return {
      id: crypto.randomUUID(),
      email: userId,
      // Ссылка подписки 3x-ui строится по subId (а не по email). Случайный subId: подписку нельзя
      // получить, зная только userId.
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
  register(userId) {
    return withKeyLock(userId, async () => {
      const traffic = await this.xui.getClientTraffic(userId); // как в ТЗ: проверка по email
      if (traffic) {
        const existing = await this.xui.findClient(userId);
        return {
          created: false,
          subLink: this.subLink(existing),
          expiryTime: Number(traffic.expiryTime) || 0,
        };
      }
      const inbounds = await this.xui.listInbounds();
      if (!inbounds || inbounds.length === 0) {
        throw new Error('No suitable inbounds found (VLESS + TCP + Reality)');
      }
      const inboundIds = inbounds.map(i => i.id);
      this.log.info(`[register] found ${inboundIds.length} suitable inbounds: [${inboundIds.join(', ')}]`);

      const client = this.#newClient(userId, Date.now() + this.trialMs, 'trial');
      await this.xui.addClient(client, inboundIds);
      this.log.info(`[register] trial issued to ${userId}`);
      return { created: true, subLink: this.subLink(client), expiryTime: client.expiryTime };
    });
  }

  /** GET /status. null => клиента нет (контроллер вернёт 404). */
  async status(userId) {
    const t = await this.xui.getClientTraffic(userId);
    if (!t) return null;
    const expiryTime = Number(t.expiryTime) || 0;
    return { isActive: t.enable === true && expiryTime > Date.now(), expiryTime };
  }

  async exists(userId) {
    return (await this.xui.getClientTraffic(userId)) !== null;
  }

  /**
   * Продление после оплаты. Вызывать только с проверенным webhook.
   * @returns {'applied'|'duplicate'}
   */
  applyPayment({ userId, planKey, paymentKey }) {
    const plan = PLANS[planKey];
    if (!plan || !isSubjectId(userId)) throw new Error('applyPayment: bad userId/plan');

    return withKeyLock(userId, async () => {
      if (this.journal.has(paymentKey)) return 'duplicate';

      const current = await this.xui.findClient(userId);
      const now = Date.now();

      if (!current) {
        // Клиента удалили, а деньги пришли — не теряем платёж, создаём клиента сразу на оплаченный срок.
        const fresh = this.#newClient(userId, now + plan.days * DAY_MS, `paid:${planKey}`);
        await this.xui.addClient(fresh);
        this.log.warn(`[payment] client ${userId} was missing, re-created for ${planKey}`);
      } else {
        const currentExpiry = Number(current.expiryTime) || 0;
        const currentExpiryMs = currentExpiry < 10000000000 ? rawExpiry * 1000 : currentExpiry;
        const base = currentExpiry > now ? currentExpiry : now;
        this.log.info(`[DEBUG] raw=${currentExpiry}, now=${now}, base=${base}`);
        const updated = { ...current, email: userId, expiryTime: base + plan.days * DAY_MS, enable: true };
        await this.xui.updateClient(userId, updated);
        this.log.info(`[payment] ${userId} +${plan.days}d -> ${new Date(updated.expiryTime).toISOString()}`);
      }

      // Помечаем ПОСЛЕ успешного обновления: при сбое 3x-ui вернём 500, и ЮKassa повторит доставку.
      this.journal.add(paymentKey);
      return 'applied';
    });
  }
}
