import { YooKassaError } from './yookassa.js';
import { resolvePayment } from './payments.js';
import { isYooKassaIp } from './ipAllow.js';

const PAYMENT_ID_RE = /^[0-9a-zA-Z-]{8,64}$/;

/**
 * Обработка HTTP-уведомления ЮKassa. Без Express — тестируется на фейках.
 *
 * У ЮKassa нет подписи уведомлений. Подлинность: (1) IP из списка ЮKassa, (2) главное — тело НЕ
 * принимается на веру: платёж запрашивается у ЮKassa по id нашими ключами, дальше используется только он.
 *
 * Коды ответа: ЮKassa считает доставленным только HTTP 200; на любой другой повторяет 24 часа.
 *   200 — обработано / дубликат / не наше событие / реальный, но непригодный платёж (повтор не поможет)
 *   400 — мусор или платёж, которого у нас нет (подделка)
 *   403 — IP вне списка при включённом YOOKASSA_IP_CHECK
 *   исключение (→ 502/500 в Express) — временный сбой ЮKassa/3x-ui: пусть ЮKassa повторит доставку
 *
 * @returns {Promise<{status: number, text: string}>}
 */
export async function handleYooKassaNotification({ yookassa, service, log, ipCheck, ledger }, { ip, body }) {
  if (!isYooKassaIp(ip)) {
    log.warn(`[webhook] request from non-YooKassa IP ${ip}`);
    if (ipCheck) return { status: 403, text: 'forbidden' };
  }

  const paymentId = body?.object?.id;
  if (body?.type !== 'notification' || typeof body?.event !== 'string' ||
      typeof paymentId !== 'string' || !PAYMENT_ID_RE.test(paymentId)) {
    return { status: 400, text: 'bad request' };
  }
  if (body.event !== 'payment.succeeded') {
    return { status: 200, text: 'ignored' }; // waiting_for_capture / canceled / refund.* нам не нужны
  }

  let payment;
  try {
    payment = await yookassa.getPayment(paymentId);
  } catch (e) {
    if (e instanceof YooKassaError && (e.status === 404 || e.status === 400)) {
      log.warn(`[webhook] payment ${paymentId} not found at YooKassa (forged?)`);
      return { status: 400, text: 'unknown payment' };
    }
    throw e; // сеть / 401 (неверные ключи) / 5xx
  }

  const order = resolvePayment(payment);
  if (!order.ok) {
    if (order.reason === 'not_succeeded') {
      log.warn(`[webhook] ${paymentId}: notification says succeeded, API says ${payment?.status} — ignored`);
    } else {
      log.error(`[webhook] PAID but unusable payment ${paymentId}: ${order.reason}`);
    }
    return { status: 200, text: 'ignored' };
  }

  const result = await service.applyPayment({
    userId: order.userId,
    planKey: order.planKey,
    paymentKey: `yookassa:${order.paymentId}`,
  });
  log.info(`[webhook] yookassa:${order.paymentId} user=${order.userId} plan=${order.planKey}: ${result}`);

  if (result === 'applied' && ledger) {
    try {
      ledger.record({
        paidAt: payment.captured_at ?? new Date().toISOString(), // момент расчёта — его указывают в чеке
        paymentId: order.paymentId,
        amount: payment.amount.value,
        currency: payment.amount.currency,
        plan: order.planKey,
        userId: order.userId,
      });
    } catch (e) {
      // Подписка уже продлена — вебхук не должен падать из-за диска; запись восстановима по реестру ЮKassa.
      log.error(`[ledger] failed to record ${order.paymentId}: ${e.message}`);
    }
  }
  return { status: 200, text: 'ok' };
}
