/** Чистые функции диагностики (без сети) — используются check-xui.js и тестами. */

const parse = (v) => {
  if (v && typeof v === 'object') return v;
  try { return JSON.parse(v ?? '{}'); } catch { return {}; }
};

export function describeInbound(inbound) {
  const stream = parse(inbound?.streamSettings);
  const settings = parse(inbound?.settings);
  const network = stream.network ?? '?';
  const security = stream.security ?? 'none';
  return {
    id: inbound?.id,
    remark: inbound?.remark ?? '',
    port: inbound?.port,
    protocol: inbound?.protocol ?? '?',
    network,
    security,
    enabled: inbound?.enable !== false,
    clients: Array.isArray(settings.clients) ? settings.clients.length : 0,
    // Именно такие клиенты создаёт backend: vless + flow xtls-rprx-vision + Reality поверх raw TCP
    suitable: inbound?.protocol === 'vless' && network === 'tcp' && security === 'reality',
  };
}

/** Подсказка по типичным ошибкам подключения к панели. */
export function hintForError(e) {
  const code = e?.code ?? e?.cause?.code;
  const msg = String(e?.message ?? '');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'Имя хоста не находится. Для host.docker.internal в docker-compose должна быть секция extra_hosts: "host.docker.internal:host-gateway".';
  }
  if (code === 'ECONNREFUSED') {
    return 'Соединение отклонено: в XUI_URL неверный порт, либо панель слушает только 127.0.0.1 (в настройках панели поле «Listen IP» должно быть пустым или 0.0.0.0).';
  }
  if (['ETIMEDOUT', 'EHOSTUNREACH', 'ECONNABORTED', 'ENETUNREACH'].includes(code) || /timeout/i.test(msg)) {
    return 'Нет ответа — почти всегда фаервол хоста. Разрешите docker-сети доступ к порту панели: ufw allow from 172.16.0.0/12 to any port 2053 proto tcp';
  }
  if (/self.signed|SELF_SIGNED|certificate|CERT_/i.test(`${code} ${msg}`)) {
    return 'У панели https с самоподписанным сертификатом. Проще всего использовать в XUI_URL http:// (панель при этом не должна быть доступна из интернета).';
  }
  if (/token rejected/i.test(msg)) {
    const status = /HTTP (\d+)/.exec(msg)?.[1];
    return status === '401'
      ? 'Панель отклонила токен (401): он неверный, отозван или выключен. Создайте новый: Настройки панели → Безопасность → API Token, и обновите XUI_API_TOKEN в backend/.env (токен копируйте целиком, без пробелов и кавычек).'
      : 'Ответ 404 при заданном токене: (1) неверный путь панели (webBasePath) в XUI_URL; (2) панель старше 3.0.2 и не знает токенов — обновите 3x-ui или используйте XUI_USERNAME/XUI_PASSWORD; (3) в более старых версиях неверный токен тоже даёт 404, а не 401, — проверьте токен.';
  }
  if (/HTTP 404/.test(msg)) {
    return 'Ответ 404: неверный путь панели (webBasePath). Откройте панель в браузере: всё, что после порта, должно быть в XUI_URL, например http://host.docker.internal:2053/AbCd12';
  }
  if (/login failed/i.test(msg)) {
    return 'Панель ответила, но логин не принят: проверьте XUI_USERNAME/XUI_PASSWORD. Включённая двухфакторная аутентификация не поддерживается.';
  }
  return null;
}
