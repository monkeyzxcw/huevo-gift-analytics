# AMNYAM MODE — Huevo Gift Market Analytics

Аналитическая панель рынка подарков huEVO: полный каталог, live-предложения, «Ниже рынка», история цены объявления, характеристики экземпляров, история событий, избранное, целевые цены и персональные настройки.

## Актуальная архитектура

Проект публикуется на **Cloudflare Workers + Static Assets + D1**. GitHub хранит исходный код и запускает тесты/деплой. Сбор рынка работает отдельно на компьютере владельца в локальном приложении HuevoDualScan: оно открывает видимые окна Chrome с сохранёнными профилями, а не использует экспорт cookies.

| Компонент | Ответственность |
|---|---|
| `cloudflare-site/` | HTML/CSS/JS интерфейса AMNYAM |
| `src/worker.js` | API Worker, объединение live-данных и полного снимка, поддержка, профили пользователей |
| `src/auth.js` + `src/huevo_launch.js` | проверка подписи запуска huEVO и сессия AMNYAM |
| `migrations/` | схема Cloudflare D1 |
| `wrangler.jsonc` | Worker, Static Assets, D1 binding и cron очистки старых данных |
| `snapshot.py` | проверка и миграция публичного снимка `cloudflare-site/data.json` |
| `tests/e2e/` | Playwright-тесты интерфейса и профиля |
| `tests/worker/` | тесты Worker и signed-launch |

## Cookies и вход

Здесь существуют два независимых механизма — их нельзя смешивать.

1. **Профиль пользователя AMNYAM.** Когда приложение открывается внутри huEVO, huEVO передаёт подписанные параметры `hu_*`. Worker проверяет HMAC-SHA256 подпись, `hu_app_id`, timestamp и ID пользователя. После проверки Worker создаёт собственную HttpOnly cookie `amnyam_session` с атрибутами `Secure; SameSite=None; Partitioned`. Она хранит сессию AMNYAM внутри iframe. Экспортированные cookies Huevo для этого не нужны.
2. **Сбор рынка.** Локальный HuevoDualScan открывает два видимых Chrome-профиля, где пользователь вручную входит в huEVO. Профили остаются только на компьютере. Экспорт cookies, GitHub Secrets `HUEVO_COOKIES*` и headless-сессия не являются поддерживаемым способом авторизации для этого процесса.

GitHub Actions не должен заходить на Huevo, читать его страницу или запускать парсер с секретами cookies. Он только проверяет код/снимок, применяет D1 миграции и публикует Worker. Планировщик Worker выполняет обслуживание D1, но не сканирует Huevo.

## Сбор данных

- Окно Chrome №1 локального сборщика наблюдает первую страницу рынка и отправляет изменения в `POST /api/live/page`.
- Окно Chrome №2 выполняет полный обход каталога и отправляет проверенный снимок в `POST /api/snapshot`.
- В том же втором окне отдельная последовательная очередь читает страницы `/market/lot/<id>` и `/gift/<id>`, сохраняя характеристики и видимую историю.
- Если Huevo показывает CAPTCHA, challenge или ограничение доступа, сборщик останавливает запросы и выдерживает cooldown. Ограничения источника не обходятся.
- Цена объявления, цена выпуска/дропа и цена завершённой сделки — разные величины. Если Huevo не показывает сумму сделки, приложение её не выдумывает.

Сборщик HuevoDualScan распространяется отдельным Windows ZIP-пакетом и в этот Cloudflare runtime не входит. Для текущей версии используй отдельный Windows-пакет HuevoDualScan v6 и входи вручную в обоих окнах Chrome. В v6 расширено распознавание истёкшей сессии; архив прошёл 10 офлайн-тестов, но живой Huevo всё равно проверяется только в обычном Chrome с ручным входом.

## Публикация

Требуются GitHub Secrets:
- `CLOUDFLARE_API_TOKEN` — токен Cloudflare с правами Workers Deploy и D1 Edit.
- `CLOUDFLARE_ACCOUNT_ID` — ID аккаунта Cloudflare.

Для huEVO Apps в настройках Worker должны быть заданы серверные secrets/vars, предусмотренные конфигурацией запуска (например, `HU_APP_ID` и `HU_SECRET`), а для приёма снимков — `LIVE_INGEST_TOKEN`. Не добавляй эти секреты в файлы репозитория, публичный JSON или чат.

Деплой запускается при изменении `cloudflare-site/`, `src/`, `migrations/`, `wrangler.jsonc`, `snapshot.py` и workflow, либо вручную через GitHub Actions → AMNYAM Cloudflare deploy. Workflow применяет D1 миграции до деплоя и останавливается, если D1 binding или права доступа отсутствуют.

## API

Основные внутренние маршруты:
- `POST /api/auth/launch` — проверка подписанного запуска huEVO.
- `GET /api/me`, `PUT /api/me/profile` — персональный профиль AMNYAM.
- `GET /data.json` — публичный снимок рынка, объединённый с live-данными.
- `POST /api/live/page` — обновление первой страницы рынка (Bearer `LIVE_INGEST_TOKEN`).
- `POST /api/snapshot` — полный снимок рынка (Bearer `LIVE_INGEST_TOKEN`).
- `GET /api/health` — готовность D1 и схемы.
- `/api/support/*` — официальные платёжные запросы huEVO Apps и статус подтверждения.

## Проверки

Локально:
```bash
npm install
npx playwright install chromium
npm run check
npm run test:e2e
python -m unittest discover -s tests -p 'test_snapshot.py' -v
```

CI проверяет снимок, синтаксис Worker/UI, сценарии dashboard, signed huEVO launch, профиль и Worker. Живой вход в huEVO и получение реальных страниц проверяются только в локальном Chrome владельца; офлайн фикстуры не заменяют такой тест.
