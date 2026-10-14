# vpn-api

Backend личного VPN-сервиса **LainTun**: выдаёт триал, продлевает подписки после оплаты через ЮKassa и управляет клиентами в панели **3x-ui** (VLESS + Reality). Вход пользователей — через **Яндекс ID**. Собственной базы данных нет: источник истины по подпискам — 3x-ui, личность — подписанный токен.


## Возможности

- Вход через Яндекс OAuth (Authorization Code + PKCE), stateless-сессии на подписанном JWT (HS256)
- Автоматический триал на 24 часа при первом входе
- Оплата тарифов через ЮKassa, продление подписки по вебхуку (идемпотентно, срок суммируется с остатком)
- Управление клиентами 3x-ui через его API (токен или логин/пароль)
- Защита API: HMAC-подпись приложения, rate-limit, проверка вебхука повторным запросом платежа
- Запуск в Docker: read-only ФС, без capabilities, непривилегированный пользователь

## Стек

Node.js ≥ 20 (ESM) · Express 4 · express-rate-limit · axios (+ axios-cookiejar-support, tough-cookie для режима логина 3x-ui) · встроенные `node:crypto`, `node:test`. Тесты — без сторонних фреймворков.

## Структура

```
docker-compose.yml
backend/
  Dockerfile  .dockerignore  .env.example  package.json
  src/
    index.js          маршруты, rate-limit, обработка ошибок, HTTPS-сервер
    config.js         чтение и валидация переменных окружения
    plans.js          тарифы, регулярки идентификаторов
    appAuth.js        HMAC-подпись приложения (X-Device-Id / X-Timestamp / X-App-Signature)
    yandex.js         обмен code → токен Яндекса → Яндекс ID
    session.js        выпуск/проверка JWT, middleware userAuth
    service.js        бизнес-логика: register / status / applyPayment
    xui.js            клиент API 3x-ui
    yookassa.js       клиент API ЮKassa (создать/получить платёж, повторы, Idempotence-Key)
    payments.js       разбор проверенного платежа
    webhook.js        обработка уведомления ЮKassa
    ipAllow.js        список IP ЮKassa
    returnPage.js     страница возврата после оплаты
    util.js           блокировки по ключу, журнал платежей, книга платежей
    check-xui.js, xuiDiagnostics.js   диагностика связи с 3x-ui
```


| Метод и путь | Тело / ответ |
|---|---|
| `GET /healthz` | `{ok: true}` |
| `POST /api/v1/auth/yandex` | `{code, codeVerifier}` → `{success, token, expiresAt, login}` |
| `POST /api/v1/auth/refresh` | → новый `{token, expiresAt, login}` на полный срок |
| `POST /api/v1/register` | → `{success, subLink, expiryTime}`. Идемпотентно: существующему клиенту вернёт его ссылку; новому выдаст триал 24 ч |
| `GET /api/v1/status` | → `{success, isActive, expiryTime}`; **404**, если клиента нет |
| `POST /api/v1/create-payment` | `{plan: "1_month" \| "2_months" \| "3_months"}` → `{success, paymentUrl}` |
| `POST /webhook/yookassa` | уведомление ЮKassa: 200 / 400 / 403 (при `YOOKASSA_IP_CHECK=1`) / 5xx (ЮKassa повторит) |
| `GET /payment/return` | HTML-страница возврата (`return_url`) |

Коды ошибок (`{success:false, error}`): `403 forbidden` (подпись), `401 unauthorized` / `invalid_code`, `400 bad_request` / `invalid_plan`, `404 client_not_found`, `429 too_many_requests`, `502 upstream_unavailable`, `500 internal_error`.

### Тарифы

| Ключ | Срок | Цена |
|---|---|---|
| `1_month` | 30 дней | 150 ₽ |
| `2_months` | 60 дней | 280 ₽ |
| `3_months` | 90 дней | 400 ₽ |

### Ограничения частоты

| Маршрут | Лимит (на IP) |
|---|---|
| `/api/v1/*` в целом | 120 / мин |
| `POST /auth/yandex` | 30 / час |
| `POST /register` (только выдача **нового** триала) | 10 / час |
| `POST /create-payment` | 30 / час |
| `POST /webhook/yookassa` | 300 / мин |

