# Контекст проекта Huevo Gift Analytics

## Репозиторий
- URL: https://github.com/monkeyzxcw/huevo-gift-analytics
- Основная ветка на момент проверки: main
- Продукт: аналитика рынка huEVO (huevo.su), прежде всего текущих объявлений подарков.
- В проекте есть два разных пути: исходное FastAPI/SQLite приложение и отдельная статическая панель, опубликованная как Cloudflare Worker Assets. Не путай их и не считай Cloudflare Worker средой для Python/Selenium.

## Архитектура по текущим файлам

### FastAPI / SQLite вариант
- app.py — HTTP/API, авторизация, лимиты, security headers.
- storage.py — SQLite, миграции, upsert, snapshots, каталог и backup.
- crawler.py — Selenium crawler с классификацией ошибок/блокировок.
- lot_parser.py — HTML в строки текущих лотов.
- cookies.py — импорт cookies JSON/Netscape и allowlist доменов.
- huevo_probe.py — классификация страниц, HTTP status и Retry-After из Chrome performance log.
- analytics.py — медианы, квартили, сравнение сопоставимых лотов и сделки-выгодные предложения.
- support.py — платежи huEVO Apps, подпись запуска, callback и идемпотентность.
- security.py — CSP.
- static/ — интерфейс, включая browser_collector.js.
- Dockerfile, docker-compose.yml — локальный/самостоятельный FastAPI-вариант; на Cloudflare публикуются только статические assets.

### Статическая Cloudflare панель
- cloudflare-site/index.html и app.js — frontend.
- cloudflare-site/data.json — публичный snapshot каталога и истории наблюдений.
- scripts/collect_snapshot.py — полный snapshot через crawler.
- scripts/import_sqlite_snapshot.py — импорт части данных SQLite в статический JSON.
- wrangler.jsonc — Worker name huevo-gift-analytics, assets directory cloudflare-site.
- .github/workflows/cloudflare-static.yml — проверенный файл только деплоит assets через Wrangler при изменениях cloudflare-site/**, wrangler.jsonc или workflow, а также по workflow_dispatch. Cron и сборщика в нём нет.
- .github/workflows/ci.yml — Python tests, JavaScript/config checks, Playwright E2E и Docker smoke test.
- run_local_collector.bat — локальный setup/run path; проверь актуальное содержимое.
- run_scheduled_collector.bat — синхронизирует main, запускает scripts/collect_snapshot.py --local-profile, коммитит только cloudflare-site/data.json и пушит; push запускает Cloudflare deploy workflow.
- install_auto_schedule.bat — создаёт Windows Task Scheduler каждые 6 часов для текущего интерактивного пользователя; компьютер должен быть включён, пользователь должен оставаться залогиненным в Windows.
- .local-huevo-chrome-profile/ — локальный Chrome профиль с авторизованной сессией, должен оставаться на ПК и игнорироваться Git.
- logs/ — локальные логи, игнорируются Git.

## Снимок данных при последней проверке
cloudflare-site/data.json:
- schema_version 1
- generated_at 2026-10-29T18:47:08.468831+00:00
- collector status ok
- 634 уникальных лота, 22 страницы; 23-я без карточек признана концом каталога
- все 634 лота имели цену
- min 20 000, max 1 000 000, average 410 300.62, median 299 999, p25 99 999, p75 700 000 монэток.
Это исторический snapshot, не обещание актуальности. Поля лота включают lot_id, title, serial, rarity, price, status, image_url, lot_url, first_seen, last_seen, active и history с observed_at/price. Не смешивай историю наблюдения цены с фактическими завершёнными сделками.

## Важное несоответствие документации и реальности
CLOUDFLARE_FREE_SETUP_RU.md описывает GitHub Actions workflow с запуском каждые 6 часов, HUEVO_COOKIES_JSON secret и Docker/Selenium collection. Проверенный cloudflare-static.yml только выполняет deploy и не содержит cron trigger или collection step. Параллельно добавлены локальные BAT-скрипты с Chrome profile. Следующий агент должен выбрать и документировать один безопасный путь. Предпочтительный по пользовательскому контексту путь — локальный профиль и публикация только очищенного JSON, если он действительно работает. Не отправляй cookies в GitHub Secrets автоматически по старой инструкции.

## Последние проверки Actions (29 октября 2026 UTC)
- Последний проверенный CI run: https://github.com/monkeyzxcw/huevo-gift-analytics/actions/runs/40935044289
- Commit 36773e981bb128af372d25954e96a68deab202a1.
- Python job failed: 113 тестов, 6 failures в tests/test_crawler.py.
- Browser job прошёл, Docker job прошёл.
- Более ранний Cloudflare deploy run для commit a010e491ea18869944f37f624f8ccc564d8ac7f3 завершился success; это не доказывает, что последние commits уже deployed.

## Важные файлы
tests/test_crawler.py — приоритет из-за CI.
tests/test_parser.py и tests/fixtures/market_page_*.html — parser contract.
tests/test_probe.py — network/status classification.
tests/e2e/collector.test.cjs и tests/e2e/ui.test.cjs — browser/collector/UI.
tests/test_storage.py, tests/test_analytics.py, tests/test_app.py, tests/test_support.py — storage, analytics, API, payments.
Проверь README_RU.md, CLOUDFLARE_FREE_SETUP_RU.md, .env.example, package.json, requirements.txt, Dockerfile, docker-compose.yml и wrangler.jsonc на соответствие Cloudflare-only deployment path.

В корне также есть архивы в папке «Для Chatgpt», включая huevo-gift-analytics-v4.zip и huevo-v4-patches.zip. Сравни их с main и проверь происхождение; не заменяй ими текущий код без diff.
