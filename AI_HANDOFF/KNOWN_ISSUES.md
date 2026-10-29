# Подтверждённые проблемы и риски

Состояние проверено по GitHub 2026-10-29 UTC. Перед изменениями проверь актуальный main и свежие Actions runs.

## P0 — Python CI не проходит
Run: https://github.com/monkeyzxcw/huevo-gift-analytics/actions/runs/40935044289
Python job ID: 123663238061
Commit: 36773e981bb128af372d25954e96a68deab202a1
Результат: 113 tests, FAILED (failures=6). Browser и Docker jobs прошли.

Шесть падений в tests/test_crawler.py:
1. test_418_on_page_two_stops_without_retry_and_is_not_complete — ожидалось blocked, HTTP 418, source network, Retry-After 120; получено no_cards, 200, network, no Retry-After.
2. test_429_and_403_are_blocks — ожидалась блокировка с 429/403; получено no_cards и 200.
3. test_500_is_server_error_not_empty_catalog — ожидался server_error; получено no_cards.
4. test_empty_normal_page_after_first_is_end_of_catalog — ожидалось ok, reached_end=True, 2 lots; получено no_cards, 0 lots.
5. test_full_pass_reaches_end_when_page_has_no_new_lots — ожидалось ok, reached_end=True, 5 lots, 2 pages; получено no_cards, 0 lots/pages.
6. test_max_pages_does_not_claim_end — ожидалось ok, reached_end=False, 3 pages; получено no_cards, 0 pages.

Начни с воспроизведения тестов и изучения crawler.py, huevo_probe.py, lot_parser.py, tests/test_crawler.py, tests/test_probe.py и fixtures. Изучи diff последних commits, особенно:
- 11f2d9fe5cd99efd9b9d4e70eb55b97a589a56cd — Use canonical gifts URL for first crawl page
- e43b1291ea18869944f37f624f8ccc564d8ac7f3 — Handle slow Huevo market page loads in Selenium collector
- 4809adb578e9a09b4bebaf53c8343c2d0263a517 — Support scheduled collection with local Chrome profile

Общий симптом указывает, что crawler получает no_cards и обнуляет страницы/лоты до того, как корректно классифицирует mocked page/network scenario. Это описание симптома, не доказанная причина. Проследи реальный порядок navigate → ready wait → parse performance log → classify HTTP/page → parse cards → pagination/end. Не ослабляй assertions и не отключай тесты. Добавь regression tests и сохрани fail-closed: incomplete/block не обновляет snapshot, не деактивирует лоты и не продвигает историю цен.

## P0/P1 — несогласованные инструкции автоматизации
CLOUDFLARE_FREE_SETUP_RU.md говорит о scheduled GitHub Actions с cookies secret и Docker/Selenium collection каждые 6 часов. Проверенный cloudflare-static.yml только деплоит static assets; cron/collector job отсутствует. Есть локальные BAT-скрипты для Chrome profile. Выбери основной путь, проверь end-to-end и обнови документацию. Не заставляй пользователя переносить cookies в GitHub Secrets без необходимости. Cloudflare Worker здесь обслуживает статические файлы, Python/Selenium внутри Worker не запускаются.

Проверь pull/rebase conflicts, exit codes, failed push recovery, log handling, Task Scheduler state, concurrency/race conditions и то, что push data.json вызывает deploy.

## P1 — история продаж пока не интегрирована
HTML https://huevo.su/market/history содержит таблицу .mk-table с колонками Лот, Цена, Продавец, Покупатель, Дата; ссылки лота вида /market/lot/<id>. Фильтры: kind=gift, kind=username, mine=1. В HTML указано «Страница 1 из 652». В видимом фрагменте время — например 01:22, 01:19, 00:54; календарная дата/год не подтверждены.

Предлагаемая работа:
- отдельный history parser и очищенные/synthetic fixtures;
- устойчивый ключ сделки и idempotent deduplication;
- raw displayed time отдельно от normalized timestamp (nullable) и observed_at;
- не выдумывать дату сделки и не использовать observed_at как timestamp продажи;
- осторожная пагинация, задержки, timeouts и остановка на login/challenge/403/418/429/5xx;
- не помечать partial crawl полным и не затирать last-known-good history;
- минимизировать публичные данные: имена продавца/покупателя не публиковать, если не нужны;
- отдельные метрики completed sales, не смешивать с asking prices;
- не сканировать 652 страницы сразу без проверки доступности и ограничений.

## P1 — сессионные данные могли раскрыться
В переписке был вставлен Request Headers с cookie, включая session и hchk. Значения здесь не сохраняются. Считай сессию раскрытой и попроси владельца инвалидировать/обновить её. Не повторяй и не запрашивай cookies. Проверь current tree и git history на случайные secrets безопасно, с redacted output. Если секрет был committed, одной очистки текущего файла недостаточно — требуется rotation/revocation и оценка очистки Git history.

Убедись, что .env, DB, Chrome profile, logs, cookie exports, HAR и raw personal data не попадают в Git. Не сохраняй Cookie/Authorization/raw body в логах или public data.json.

## P1 — корректность данных и статистики
- snapshot публичен и содержит каталог и price observation history, но это не completed-sales database.
- incomplete crawl не должен менять active flags, market snapshots или историю цен.
- проверить atomic writes, JSON schema/version, history retention, lot dedupe и числовой parsing.
- проверять empty/one-item datasets, outliers, malformed snapshots, stale frontend data.
- не считать исчезновение лота доказательством продажи.
- чётко объяснять, как рассчитывается «выгодный лот» и с чем сравнивается цена.

## P2 — полный аудит
Security: auth, CORS/CSRF, CSP/headers, rate limits, payment signature/replay/idempotency, logs, secrets.
Storage: schema migrations, transactions, backup/restore, importer filters, atomic writes.
Frontend: accessibility, responsive layout, safe DOM rendering/XSS, loading/error/empty states, sorting/filtering, performance.
Deployment: Cloudflare workflow triggers/permissions, secrets scope, deploy smoke tests.
Maintenance: dependency versions, Actions runtime warnings, log retention, health/diagnostics.


## Обновление (исправления в ветке fix/crawler-ci-history)
- P0 причина падения Python CI подтверждена по исходникам: в PR #4 строка `n = ...` в `FakeBrowser.get` оказалась внутри комментария (литеральный `\n` вместо перевода строки), поэтому каждый `get()` падал с `NameError`. Исправлено в `tests/test_crawler.py`; текст логов Actions из песочницы недоступен, результат CI нужно подтвердить на GitHub.
- `scripts/collect_snapshot.py`: `first_seen` теперь переносится из прошлого снимка; пауза после блокировки хранится в `.collector-state.json` и действует для всех режимов.
- Добавлены `history_parser.py`, таблица `sales` (схема v3), `analytics.sales_summary`, `run_history_crawl`, `scripts/collect_history.py`, `GET /api/sales/summary`. Не проверено на живом Huevo.
- Не сделано: показ подтверждённых сделок в `cloudflare-site`, публикация истории, автоматическая ротация/проверка сессии.

## Обновление (ветка feature/dashboard-snapshots)
- Сделано: ограниченные повторы временных сетевых сбоев (`crawler.observe_with_retry`); `snapshot.py` (схема v2, проверка, миграция, `compare`, категории, топ дорогих, защита от дубля точки истории, атомарная запись с fsync); новый дашборд `cloudflare-site/` (фильтры, сортировка, пагинация, карточка лота с историей цены, графики, блок изменений, баннеры состояния данных, CSP через `_headers` и meta); проверка `data.json` перед деплоем в workflow; `permissions: contents: read` в CI; `--autostash` и явная обработка паузы в `run_scheduled_collector.bat`; опциональная публикация агрегатов продаж (`--with-sales`).
- Папка `Для Chatgpt/` удалена из репозитория.
- Не проверено на живых системах: селекторы Huevo, структура `/market/history`, реальный деплой в Cloudflare, Планировщик Windows.
- Не сделано: сравнение произвольных пар снимков в UI (хранится только последнее сравнение `changes`), детализация продаж по названиям в UI (данные `sales.by_title` уже в файле), закрепление версий GitHub Actions по SHA.
- Публикация статуса блокировки на сайт не делается: после неудачного запуска `git restore` откатывает `data.json`; сайт сам показывает предупреждение «данные устарели» по возрасту последнего успешного сбора.
