# AMNYAM MODE — Cloudflare Workers

Рабочий сайт: https://huevo-gift-analytics.monkeyzxc1437.workers.dev

## Текущая архитектура

- Cloudflare Worker обслуживает API и статические файлы из cloudflare-site/.
- Cloudflare D1 хранит полный снимок рынка, live-первую страницу, аккаунты пользователей и настройки профилей.
- GitHub Actions выполняет тесты, проверяет data.json, применяет D1 migrations и деплоит Worker через Wrangler.
- Локальный HuevoDualScan на Windows открывает два видимых Chrome-профиля. Пользователь входит в huEVO вручную в обоих окнах; сборщик отправляет проверенные данные в Worker.
- GitHub Actions и Cloudflare Worker не запускают Selenium и не заходят на Huevo для сбора рынка.
- Render, VPS и отдельный FastAPI-сервер для текущей production-схемы не используются.

## 1. GitHub Secrets

В Settings → Secrets and variables → Actions нужны только:

| Secret | Назначение |
|---|---|
| CLOUDFLARE_API_TOKEN | Cloudflare API Token с Workers Deploy и D1 Edit |
| CLOUDFLARE_ACCOUNT_ID | Account ID из Cloudflare |

Не добавляй HUEVO_COOKIES, HUEVO_COOKIES_JSON или HUEVO_USER_AGENT: текущий workflow их не использует. Экспорт cookies не поддерживается как способ входа для локального сборщика.

## 2. Секреты Cloudflare Worker

В Cloudflare Worker huevo-gift-analytics хранятся secrets/vars:

- LIVE_INGEST_TOKEN — отдельный случайный токен, которым локальный HuevoDualScan подписывает запросы /api/live/page и /api/snapshot.
- HU_APP_ID и HU_SECRET — серверные настройки проверки подписанного запуска huEVO Apps.

Ни один из этих секретов не должен находиться в HTML, JavaScript, публичном JSON, Git или чате. Один и тот же LIVE_INGEST_TOKEN вводится в локальном приложении и хранится как Secret Worker.

## 3. Cookies: что работает и для чего

Экспортированные cookies Huevo не нужны для входа в AMNYAM или для работы текущего локального сборщика.

Для профиля AMNYAM используется отдельная cookie amnyam_session. Она выдаётся Worker только после успешной проверки подписанных параметров hu_* от huEVO и имеет атрибуты HttpOnly; Secure; SameSite=None; Partitioned. Такая сессия предназначена для работы приложения внутри cross-site iframe в браузерах с поддержкой partitioned cookies. В обычной вкладке без подписанного запуска доступны публичные страницы рынка, но не персональная синхронизация аккаунта.

Для сбора Huevo используются обычные видимые Chrome-окна и ручной вход пользователя. Профили хранятся на этом компьютере и не входят в архив приложения.

## 4. Деплой

Workflow .github/workflows/cloudflare-static.yml запускается после изменений интерфейса, Worker, миграций и конфигурации либо вручную через GitHub Actions → AMNYAM Cloudflare deploy. Он:

1. проверяет структуру cloudflare-site/data.json;
2. проверяет секреты Cloudflare;
3. применяет D1 migrations;
4. публикует Worker и Static Assets через Wrangler.

Workflow не запускает сборщик рынка. Cron в wrangler.jsonc используется Worker для очистки старых записей D1, а не для посещения Huevo.

## 5. Проверка

- /api/health — готовность хранилища, схемы D1 и приёма данных.
- /api/live/status — актуальность live-первой страницы.
- /data.json — объединённый полный снимок и live-данные.

Живую авторизацию Huevo и текущую HTML-разметку можно проверить только в локальном Chrome с ручным входом. Успешные CI-тесты подтверждают программную логику, но не доказывают действительность внешней браузерной сессии.
