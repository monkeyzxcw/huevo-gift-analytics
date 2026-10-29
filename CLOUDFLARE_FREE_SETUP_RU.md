# Бесплатный Cloudflare-вариант Huevo Gift Analytics

Эта схема не запускает FastAPI или Selenium внутри Cloudflare. GitHub Actions использует существующий Docker/Selenium-сборщик, собирает полный снимок маркета и публикует статический каталог в Cloudflare Worker. Текущий Render-сервис и его файлы остаются нетронутыми.

## Что делает workflow

- Запускается вручную или по расписанию раз в 6 часов.
- Берёт cookies только из GitHub Actions Secrets.
- Запускает существующий Selenium-сборщик в Docker.
- Обновляет `cloudflare-site/data.json` только после полного прохода каталога.
- При блокировке 403/418/429 не публикует частичный снимок; сохраняет последний успешный каталог и фиксирует время паузы.
- Деплоит статические файлы через Wrangler.

Снимки и каталог в `cloudflare-site/data.json` публичны, потому что обслуживают публичный сайт. Cookie-значения туда никогда не записываются.

## 1. Добавить GitHub Secrets

В репозитории открой **Settings → Secrets and variables → Actions → New repository secret** и создай:

| Имя | Что поместить |
|---|---|
| `HUEVO_COOKIES_JSON` | Полный JSON-экспорт cookies из актуальной авторизованной сессии Huevo. Не вставляй его в файлы репозитория. |
| `CLOUDFLARE_API_TOKEN` | API Token Cloudflare с правом деплоя Workers / Workers Scripts. |
| `CLOUDFLARE_ACCOUNT_ID` | ID аккаунта Cloudflare из панели аккаунта. |

В Cloudflare API Token создай токен с минимальными необходимыми правами на деплой Workers. Не используй Global API Key.

## 2. Сверить имя Worker

Открой `wrangler.jsonc`. Сейчас имя задано как `huevo-gift-analytics`. Оно должно в точности совпадать с именем Worker, который уже создан в Cloudflare. Если твой Worker называется иначе, измени поле `name` и закоммить изменение.

Этот Worker обслуживает только статические файлы, поэтому Cookies и Huevo-переменные в Runtime variables and secrets Cloudflare добавлять не нужно. Секрет cookies доступен только сборщику внутри GitHub Actions.

## 3. Разрешить обновление снимка в репозитории

Открой **Settings → Actions → General → Workflow permissions** и разреши **Read and write permissions**. Workflow сохраняет новый публичный снимок в `cloudflare-site/data.json`, чтобы история цен сохранялась между запусками.

## 4. Первый запуск

Открой вкладку **Actions → Cloudflare static market dashboard → Run workflow** и запусти workflow вручную. Затем проверь шаги в логе:

1. Build the existing Selenium image
2. Collect a complete market snapshot
3. Commit public snapshot and history
4. Deploy static assets to Cloudflare

Если сбор завершится ошибкой, открой лог шага сбора. Значения cookies не выводятся. При блокировке доступа Huevo сбор остановится, а последний успешный каталог останется на сайте.

## Не переносится в эту статическую версию

Она показывает каталог, метрики, выгодные предложения и историю снимков. FastAPI-эндпоинты, браузерные админ-действия, huEVO Payments и другие серверные функции из Render этим деплоем не переносятся. Обычный Cloudflare Worker со статическими файлами не исполняет Selenium/Python-бэкенд.

Если у Worker уже другое имя — обязательно поменяй его до первого деплоя, иначе Wrangler может создать отдельный Worker с именем из конфигурации.
