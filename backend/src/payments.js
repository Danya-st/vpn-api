import { PLANS, UUID_RE } from './plans.js';

/**
 * Разбор ПРОВЕРЕННОГО объекта платежа (полученного из GET /v3/payments/{id}, а не из тела вебхука).
 *
 * @returns {{ok: true, deviceId: string, planKey: string, paymentId: string}
 *          | {ok: false, reason: string}}
 */
export function resolvePayment(payment) {
  if (payment?.status !== 'succeeded' || payment?.paid !== true) return { ok: false, reason: 'not_succeeded' };
  if (payment.amount?.currency !== 'RUB') return { ok: false, reason: 'bad_currency' };

  const deviceId = payment.metadata?.device_id;
  if (typeof deviceId !== 'string' || !UUID_RE.test(deviceId)) return { ok: false, reason: 'no_device_id' };

  const sum = Number(payment.amount.value);
  if (!Number.isFinite(sum)) return { ok: false, reason: 'bad_amount' };

  // Тариф — из metadata.plan (его задаёт только наш сервер); если его нет — по сумме (150/280/400).
  const metaPlan = payment.metadata?.plan;
  const planKey =
    typeof metaPlan === 'string' && Object.hasOwn(PLANS, metaPlan)
      ? metaPlan
      : Object.keys(PLANS).find((k) => PLANS[k].price === sum);
  if (!planKey) return { ok: false, reason: 'unknown_plan' };

  // Не принимаем недоплату (переплата допустима: например, цены подняли, а платёж создан по старой).
  if (sum + 0.005 < PLANS[planKey].price) return { ok: false, reason: 'underpaid' };

  return { ok: true, deviceId, planKey, paymentId: payment.id };
}
