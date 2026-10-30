# Cloudflare live storage и опрос первой страницы

В проекте поддерживаются два вида обновления:

1. Полный снимок каталога — GitHub Actions/локальный Selenium запускает полный обход и публикует JSON в Cloudflare D1. Если D1 пока не подключена, workflow продолжает использовать прежний запасной вариант с `cloudflare-site/data.json` в Git.
2. Live-опрос первой страницы — локальный Chrome с уже авторизованной сессией запрашивает только `/market/gifts?page=1` каждые 3 секунды и отправляет очищенные поля лотов в Worker. Cookie и HTML страницы никуда не отправляются. Worker хранит текущую страницу и изменения цен в D1; сайт получает их через `/api/live/status`.

Live-опрос не пытается обходить защиту. При login/challenge или HTTP 403/418/429 он останавливается и сохраняет локальную паузу.

## 1. Создать D1

1. В Cloudflare открой **Storage & databases → D1 SQL Database**.
2. Нажми **Create database**, имя: `huevo-live-data`.
3. Открой созданную базу и скопируй её **Database ID**.
4. В корневом `wrangler.jsonc` добавь рядом с `assets` такой блок, заменив `YOUR_D1_DATABASE_ID` на реальный ID:
   
   ```json
   "d1_databases": [
     {
       "binding": "DB",
       "database_name": "huevo-live-data",
       "database_id": "YOUR_D1_DATABASE_ID"
     }
   ]
   ```

   Это идентификатор базы, не секрет. Не вставляй сюда API-токен или `HU_SECRET`.

После коммита GitHub Actions применит миграцию `migrations/0001_live_storage.sql`, если у Cloudflare API Token есть разрешение **D1: Edit**. Если миграция завершается ошибкой 403, добавь это разрешение к API Token, который хранится как GitHub Secret `CLOUDFLARE_API_TOKEN`.

## 2. Задать ingest-токен

Нужен отдельный случайный токен для отправки данных в Worker. **Не используй `HU_SECRET`, `client_secret` или cookies Huevo в качестве ingest-токена.**

1. Сгенерируй длинную случайную строку локально, например командой:
   
   ```powershell
   py -c "import secrets; print(secrets.token_urlsafe(32))"
   ```

2. В Cloudflare Worker `huevo-gift-analytics` открой **Settings → Variables and secrets → Add variable → Secret** и добавь имя `LIVE_INGEST_TOKEN`, значение — сгенерированная строка.
3. В GitHub открой **Settings → Secrets and variables → Actions → New repository secret** и создай `HUEVO_LIVE_INGEST_TOKEN` с тем же значением.
4. Сохрани эту строку локально для команды запуска poller. Не коммить её в репозиторий и не присылай в чат.

Workflow будет отправлять полный снимок в D1 только когда Worker сообщает, что D1, миграции и ingest-токен готовы. До этого он сохраняет JSON в Git как раньше. После включения D1 новые снимки перестанут создавать отдельный коммит `data.json` каждые 10 минут.

## 3. Подготовить локальную Chrome-сессию (Windows)

Профиль нужно копировать на **том же Windows-компьютере и под тем же пользователем Windows**, где Chrome хранит эту сессию. Не загружай профиль или его cookie-файлы в GitHub, Cloudflare, ZIP-архив или чат.

1. Войди в Huevo обычным Chrome и убедись, что каталог маркета открывается.
2. Полностью закрой все окна Chrome, включая фоновые процессы.
3. В PowerShell из папки проекта выполни:
   
   ```powershell
   py scripts/clone_chrome_profile.py --list
   py scripts/clone_chrome_profile.py --profile "Default"
   ```

   Если у тебя в списке другой профиль, используй его имя, например `Profile 1`. Если папка клона уже существует, скрипт попросит явно указать `--force`; старая копия будет переименована в резервную, а не удалена.

## 4. Запустить опрос каждые 3 секунды

После создания D1 и настройки секрета в текущем PowerShell-окне задай переменные (токен вставь локально, не отправляй в чат):

```powershell
$env:HUEVO_CHROME_PROFILE = "Default"
$env:HUEVO_BASE_URL = "https://huevo.su"
$env:HUEVO_LIVE_INGEST_URL = "https://huevo-gift-analytics.monkeyzxcw.workers.dev/api/live/page"
$env:HUEVO_LIVE_INGEST_TOKEN = "<твой локальный ingest-токен>"
$env:HUEVO_LIVE_POLL_SECONDS = "3"
py scripts/poll_first_page.py
```

Окно терминала должно оставаться открытым, пока нужен live-режим. Chrome откроется видимым окном и запросит первую страницу через same-origin fetch без выгрузки cookie-значений. Остановить — `Ctrl+C`.

Проверить Worker можно по адресу:

- `https://huevo-gift-analytics.monkeyzxcw.workers.dev/api/health` — должно показать `storage_configured: true`, `schema_ready: true`, `ingest_enabled: true`.
- `https://huevo-gift-analytics.monkeyzxcw.workers.dev/api/live/status` — после старта появятся `last_poll_at`, `item_count` и `fresh: true`.

В панели обновляются цены первой страницы; прочие лоты и графики остаются на последнем полном снимке. Значок `Live · первая страница` означает именно это, а не свежесть всего каталога.

## Частота, хранение и ограничения

- История live-цен хранится 72 часа; Worker удаляет старые записи каждый час. Полная история/снимки в полном JSON также ограничены `HUEVO_RETENTION_HOURS` (по умолчанию 72).
- Интервал нельзя установить ниже 3 секунд. Это до 20 запросов/минуту к Huevo, поэтому не оставляй опрос включённым без необходимости. Если Huevo вернёт login/challenge, 403, 418 или 429, poller остановится, а не станет обходить ограничение.
- Каждый опрос обновляет одну строку состояния D1; история цен записывается только при изменении цены. На Workers Free есть суточный лимит запросов и записей D1/Worker, поэтому при нескольких активных зрителях следи за Usage в Cloudflare.
- Cloudflare Workers не запускает Selenium. Live-опрос выполняется на твоём PC/VPS в обычной авторизованной сессии; Cloudflare только хранит и раздаёт данные.
