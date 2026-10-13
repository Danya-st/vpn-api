/** Тарифы: цена в рублях, срок в днях. Должны совпадать с Plan в Android-приложении (только для показа). */
export const PLANS = Object.freeze({
  '1_month': { days: 30, months: 1, price: 150 },
  '2_months': { days: 60, months: 2, price: 280 },
  '3_months': { days: 90, months: 3, price: 400 },
});

export const DAY_MS = 86_400_000;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Идентификатор пользователя = email клиента в 3x-ui: `ya-<числовой id Яндекса>`. */
export const USER_ID_RE = /^ya-\d{1,20}$/;
/** Принимаем и старые UUID (клиенты и платежи, созданные до перехода на Яндекс ID). */
export const isSubjectId = (s) => typeof s === 'string' && (USER_ID_RE.test(s) || UUID_RE.test(s));
