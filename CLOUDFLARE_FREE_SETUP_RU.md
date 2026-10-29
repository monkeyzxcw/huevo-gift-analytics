# Бесплатный Cloudflare-вариант Huevo Gift Analytics

> **Как это работает на самом деле (проверено по коду и workflow).** Сбор данных идёт **только на вашем компьютере**: `scripts/collect_snapshot.py` открывает локальный Chrome-профиль с уже выполненным входом в Huevo. Python/Selenium не запускаются ни в Cloudflare, ни в GitHub Actions. Workflow `.github/workflows/cloudflare-static.yml` **только публикует** статические файлы (`cloudflare-site/`) через Wrangler после push в `main`, который меняет эти файлы. Расписания сбора в GitHub Actions нет.

```
Huevo → локальный Chrome-профиль → scripts/collect_snapshot.py → cloudflare-site/data.json
      → git commit/push (run_scheduled_collector.bat) → GitHub Actions (cloudflare-static.yml) → Cloudflare Worker (статика)
```

## Что требует вашего компьютера
- Windows с включённым ПК и вашим входом в систему (планировщик задач работает только пока вы вошли).
- Один раз: `run_local_collector.bat` (создаёт `.venv`, открывает отдельный профиль Chrome, где вы входите в Huevo вручную). Профиль лежит в `.local-huevo-chrome-profile/` (в `.gitignore`) и никуда не отправляется.
- Автозапуск раз в 6 часов: `install_auto_schedule.bat` → `run_scheduled_collector.bat` (git pull --rebase, сбор, commit и push только `data.json`). Журнал: `logs\scheduled-collector.log`.

## Поведение при сбоях (fail-closed)
- Блокировка 403/418/429, страница входа, тайм-аут, неполный проход или резкое падение числа лотов (<50% прежних активных) **не заменяют** последний хороший `data.json` пустым результатом.
- Пауза после блокировки (не короче `Retry-After` и `CRAWL_BLOCK_COOLDOWN_HOURS`) хранится в локальном файле `.collector-state.json` (в `.gitignore`), поэтому `git restore` в `.bat` её не стирает. Во время паузы запросы к Huevo не отправляются (ручной `--local-login` предупреждает, но запускается по вашему решению).
- Лот, пропавший из полного прохода, помечается «Не найден в последнем полном проходе», а **не** «продан».

## Сессия и cookies
Cookies в репозиторий и в GitHub Secrets класть не нужно: локальный профиль их заменяет. Если сессия когда-либо попала в чат или лог — выйдите из аккаунта на huevo.su и войдите заново (старые значения недействительны), затем повторите вход в локальном профиле. Секреты GitHub нужны только для деплоя: `CLOUDFLARE_API_TOKEN` и `CLOUDFLARE_ACCOUNT_ID`.

## История сделок (локально, опционально)
`python scripts/collect_history.py --local-profile --pages 3` читает первые страницы `/market/history`, сохраняет подтверждённые сделки в локальный `history.db` (без имён продавцов и покупателей) и ничего не публикует. Дата сделки сохраняется только если сайт отдаёт её явно (атрибут со временем и часовым поясом или unix-время); иначе остаётся только отображаемое время. Структура страницы подтверждена лишь по присланному фрагменту; на живом сайте парсер не проверялся.

---
**Ниже — устаревший план с GitHub Actions по расписанию; он не реализован в репозитории и оставлен как справка. Не следуйте разделам про `HUEVO_COOKIES_JSON` в Secrets.**

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
