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

## 2. Перенести старую историю из Render (необязательно)

Если хочешь сохранить существующую историю из `huevo.db`, скачай бэкап с работающего Render-сервиса до отключения:

```powershell
curl.exe -H "Authorization: Bearer YOUR_INGEST_TOKEN" -o huevo.db https://huevo-gift-analytics.onrender.com/api/backup
```

Замени `YOUR_INGEST_TOKEN` локально на значение `INGEST_TOKEN` из **Render → Environment**. Не отправляй токен в чат. Если старая история не нужна, пропусти этот шаг — она начнётся с первого успешного снимка на GitHub Actions.

Из корня репозитория запусти импортёр:

```powershell
python scripts/import_sqlite_snapshot.py "C:\path\to\huevo.db"
```

Импортёр обновит `cloudflare-site/data.json`: перенесёт только каталог, историю цен и снимки рынка. Он намеренно не читает таблицу `support_payments` и другие внутренние таблицы. Проверь размер и содержимое созданного JSON и включи его в PR до первого запуска workflow. **Не коммить и не загружай в публичный репозиторий сам файл `huevo.db`** — он может содержать внутренние записи.

## 3. Сверить имя Worker

Открой `wrangler.jsonc`. Сейчас имя задано как `huevo-gift-analytics`. Оно должно в точности совпадать с именем Worker, который уже создан в Cloudflare. Если твой Worker называется иначе, измени поле `name` и закоммить изменение.

Этот Worker обслуживает только статические файлы, поэтому Cookies и Huevo-переменные в Runtime variables and secrets Cloudflare добавлять не нужно. Секрет cookies доступен только сборщику внутри GitHub Actions.

## 4. Разрешить обновление снимка в репозитории

Открой **Settings → Actions → General → Workflow permissions** и разреши **Read and write permissions**. Workflow сохраняет новый публичный снимок в `cloudflare-site/data.json`, чтобы история цен сохранялась между запусками.

## 5. Первый запуск

Открой вкладку **Actions → Cloudflare static market dashboard → Run workflow** и запусти workflow вручную. Затем проверь шаги в логе:

1. Build the existing Selenium image
2. Collect a complete market snapshot
3. Commit public snapshot and history
4. Deploy static assets to Cloudflare

Если сбор завершится ошибкой, открой лог шага сбора. Значения cookies не выводятся. При блокировке доступа Huevo сбор остановится, а последний успешный каталог останется на сайте.

## Не переносится в эту статическую версию

Она показывает каталог, метрики, выгодные предложения и историю снимков. FastAPI-эндпоинты, браузерные админ-действия, huEVO Payments и другие серверные функции из Render этим деплоем не переносятся. Обычный Cloudflare Worker со статическими файлами не исполняет Selenium/Python-бэкенд.

Если у Worker уже другое имя — обязательно поменяй его до первого деплоя, иначе Wrangler может создать отдельный Worker с именем из конфигурации.
