// Диагностика связи с 3x-ui. Запуск (в работающем контейнере):
//   docker compose exec api node src/check-xui.js
import { XuiClient } from './xui.js';
import { describeInbound, hintForError } from './xuiDiagnostics.js';

const env = (k, d) => (process.env[k] ?? d ?? '').trim();
const url = env('XUI_URL').replace(/\/+$/, '');
const inboundId = Number(env('XUI_INBOUND_ID', '1'));
const subBase = env('SUB_BASE_URL').replace(/\/+$/, '');

const ok = (m) => console.log(`✔ ${m}`);
const bad = (m) => console.log(`✘ ${m}`);

async function main() {
  const token = env('XUI_API_TOKEN');
  const username = env('XUI_USERNAME');
  const password = env('XUI_PASSWORD');
  if (!url || (!token && !(username && password))) {
    bad('Не заданы XUI_URL и XUI_API_TOKEN (либо XUI_USERNAME + XUI_PASSWORD) в backend/.env');
    process.exit(1);
  }
  const xui = new XuiClient({ url, token, username, password });

  try {
    if (xui.authMode === 'token') {
      console.log('Авторизация: API-токен (Bearer). Проверяю запросом списка инбаундов…');
    } else {
      console.log('Авторизация: логин/пароль (запасной режим; лучше перейти на XUI_API_TOKEN).');
      await xui.login();
      ok(`Логин в 3x-ui успешен (${url})`);
    }

    const inbounds = (await xui.listInbounds()).map(describeInbound);
    if (xui.authMode === 'token') ok(`Токен принят панелью (${url})`);
    console.log('\nИнбаунды в панели:');
    if (!inbounds.length) console.log('  (пусто — создайте VLESS + TCP + Reality инбаунд)');
    for (const i of inbounds) {
      const mark = i.id === inboundId ? '   ← XUI_INBOUND_ID' : '';
      console.log(`  id=${i.id}  "${i.remark}"  ${i.protocol}  ${i.network}+${i.security}  порт ${i.port}  клиентов: ${i.clients}${i.enabled ? '' : '  (ВЫКЛЮЧЕН)'}${mark}`);
    }
    console.log('');

    ok(`Найдено ${inbounds.length} подходящих инбаундов`);
    console.log(`  При регистрации новый клиент будет автоматически добавлен во ВСЕ эти ${inbounds.length} инбаундов.`);
    console.log('  Приложение получит одну ссылку подписки, содержащую конфигурации для всех портов (round-robin).');

    if (!subBase) bad('SUB_BASE_URL не задан');
    else {
      ok(`Ссылки подписок будут вида ${subBase}/<subId>`);
      console.log('  Откройте такую ссылку в браузере с телефона (не с сервера): должна открыться страница с base64-текстом,\n' +
        '  без предупреждений о сертификате — приложение использует системные сертификаты.');
    }
  } catch (e) {
    bad(`${e.message || e.code}`);
    const hint = hintForError(e);
    if (hint) console.log(`  → ${hint}`);
    process.exitCode = 1;
  }
}

main();
