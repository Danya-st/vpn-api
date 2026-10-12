const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Страница, на которую ЮKassa возвращает пользователя после оплаты (return_url).
 * Она нужна, потому что в документации return_url — это https-адрес; кастомная схема myvpn:// там не
 * гарантирована. Страница пытается открыть приложение сама, а кнопка — запасной вариант
 * (браузеры часто требуют жест пользователя для перехода по кастомной схеме).
 * Статус платежа здесь НЕ показывается и не проверяется: приложение само опрашивает /status.
 */
export function renderReturnPage(appDeepLink) {
  const link = escapeHtml(appDeepLink);
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Оплата</title>
<style>
  body{font-family:system-ui,sans-serif;text-align:center;padding:56px 24px;color:#222}
  p{color:#555;line-height:1.5}
  a.btn{display:inline-block;margin-top:24px;padding:14px 28px;border-radius:28px;background:#2e7d32;color:#fff;text-decoration:none;font-size:18px}
</style></head>
<body>
<h2>Спасибо!</h2>
<p>Если оплата прошла, подписка продлится в течение минуты.</p>
<a class="btn" href="${link}">Вернуться в приложение</a>
<script>setTimeout(function(){location.href=${JSON.stringify(appDeepLink).replace(/</g, '\\u003c')}},300)</script>
</body></html>`;
}
