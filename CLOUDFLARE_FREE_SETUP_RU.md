# Huevo Gift Analytics — Cloudflare Workers Free

Рабочий сайт: **https://huevo-gift-analytics.monkeyzxcw.workers.dev**

В этой версии Cloudflare обслуживает только статические файлы. Сам сбор Huevo запускается на твоём Windows-ПК в локальном Chrome-профиле. GitHub Actions не сканирует Huevo и не хранит cookies: он только проверяет cloudflare-site/data.json и публикует сайт через Wrangler.

## 1. Настроить GitHub Secrets

Открой репозиторий → **Settings → Secrets and variables → Actions → New repository secret**. Добавь:

| Имя | Значение |
|---|---|
| **CLOUDFLARE_API_TOKEN** | Cloudflare API Token с минимальными правами, необходимыми для публикации Workers Scripts/Static Assets |
| **CLOUDFLARE_ACCOUNT_ID** | Account ID из Cloudflare Dashboard |

Не используй Global API Key. **Не добавляй HUEVO_COOKIES_JSON, HUEVO_COOKIES, локальный Chrome-профиль или другие сессионные данные в GitHub.** Сессия остаётся только на твоём компьютере.

## 2. Проверить имя Worker

Файл wrangler.jsonc уже содержит имя huevo-gift-analytics, которое соответствует адресу выше. Не создавай второй Worker с другим именем. На странице Cloudflare Worker не нужно добавлять Runtime Variables and Secrets для сборщика: статическая версия не выполняет Python/Selenium.

## 3. Первый запуск сборщика на Windows

1. Скачай/клонируй репозиторий на свой Windows-ПК и открой папку проекта.
2. Запусти run_local_collector.bat. Он подготовит Python-окружение, откроет отдельный Chrome-профиль и позволит войти на Huevo вручную.
3. После успешного полного прохода сборщик обновит cloudflare-site/data.json, создаст commit и отправит его в GitHub.
4. Push изменения в main, затрагивающего cloudflare-site/**, wrangler.jsonc или workflow, запускает GitHub Actions. Workflow проверяет формат снимка и выполняет wrangler deploy; сайт обновляется на Cloudflare.

Если требуется вручную импортировать локальный снимок SQLite, используй scripts/import_sqlite_snapshot.py из корня проекта. Для опциональной истории подтверждённых продаж scripts/collect_history.py запускается отдельно; продажи публикуются только как агрегаты и только при достаточном количестве данных.

## 4. Автоматический запуск каждые 6 часов

После успешного первого запуска запусти install_auto_schedule.bat. Он создаёт задачу Windows Task Scheduler, которая запускает run_scheduled_collector.bat каждые 6 часов. Компьютер должен быть включён, а пользователь — войти в Windows. Журнал хранится в logs/scheduled-collector.log.

Chrome-профиль, .collector-state.json, history.db, виртуальная среда и журналы исключены из Git через .gitignore. Не удаляй эти правила и не коммить эти локальные файлы.

## 5. Если сбор не удался

- При 403/418/429, странице входа, сетевой ошибке или неполном проходе последний корректный data.json сохраняется.
- После ограничения Huevo сборщик ждёт как минимум указанный Retry-After и настроенную паузу. Во время паузы запросы не отправляются.
- Если разметка каталога или страницы /market/history изменилась, проверяй фикстуры и парсер. Живая разметка может отличаться от тестовых HTML-фрагментов.
- GitHub Actions деплоит только статику; он не запускает Selenium, Windows Task Scheduler, локальный профиль Chrome или FastAPI API.
