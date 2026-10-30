# Контекст AMNYAM / Huevo Gift Analytics

Репозиторий: https://github.com/monkeyzxcw/huevo-gift-analytics
Production architecture: Cloudflare Workers + Static Assets + D1. Python FastAPI, SQLite runtime, Docker app and headless Huevo scraper are retired and removed.

## Актуальные компоненты
- cloudflare-site/: frontend HTML/CSS/JS and the checked-in last-known-good snapshot fallback.
- src/worker.js: Cloudflare API, D1 storage, payments and static asset routing.
- src/auth.js + src/huevo_launch.js: huEVO signed launch validation and AMNYAM session.
- migrations/: D1 schema.
- snapshot.py: snapshot schema validation and migration.
- tests/e2e, tests/worker, tests/test_snapshot.py: current automated checks.
- .github/workflows/ci.yml: tests only.
- .github/workflows/cloudflare-static.yml: Cloudflare deployment only.

## Сбор Huevo
Сбор выполняет отдельный Windows-пакет HuevoDualScan, не репозиторный runtime. Он запускает два видимых Chrome-профиля: Chrome #1 опрашивает первую страницу примерно каждые 3 секунды; Chrome #2 выполняет полный каталог примерно каждые 5 минут и затем последовательно обрабатывает очередь /market/lot/<id> → /gift/<id>. Очередь работает пачками до 8 элементов, немедленно продолжает следующей пачкой до дедлайна полного обхода и сохраняет прогресс в Cloudflare после каждой пачки.

ZIP v5: HuevoDualScan_app.py, start_dual_scan.bat, README_RU.txt, requirements.txt, test_details_parser.py, CHANGELOG.txt, DO_NOT_RUN_OLD_COLLECTOR.txt. В этой QA-сессии ZIP прошёл py_compile -Werror и 8 offline tests; live Huevo не проверялся.

## Авторизация: три независимых понятия
1. Huevo collection: ручной вход в huEVO в ОБОИХ видимых Chrome-окнах. Профили остаются локально в %LOCALAPPDATA%/HuevoGiftBridge/ChromeProfile и ChromeProfileFull.
2. AMNYAM user profile: Worker проверяет подписанные hu_* параметры запуска, затем выдаёт отдельную HttpOnly cookie amnyam_session с Secure, SameSite=None и Partitioned для iframe.
3. Data ingest: LIVE_INGEST_TOKEN — отдельный секрет для отправки очищенных JSON-данных в Worker.

Экспортированные Huevo cookies не нужны ни в одном из этих механизмов. Не использовать HUEVO_COOKIES_JSON, HUEVO_COOKIES или HUEVO_USER_AGENT; не возвращать headless GitHub scraper.

## Последняя QA-ветка
PR #38: https://github.com/monkeyzxcw/huevo-gift-analytics/pull/38
Ветка: audit/cloudflare-runtime-cleanup. В ней исправлены сетевые тайм-ауты, обработка malformed snapshot, валидация целевых цен на frontend и Worker, сериализация profile saves с backoff, auth duplicate guard, payment busy/timeout state и отображение target validation внутри detail dialog. Также удалена старая FastAPI/SQLite/Docker/cookie collection ветка.

Deploy новой версии после merge подтверждён GitHub Actions run 41118429757. Прямой запрос к /api/health из среды разработки не подтвердился из-за DNS-ограничения окружения; это не отменяет успешный deploy workflow.

## Остаточные неизвестные
- Live Huevo login/DOM and page selectors in both Chrome windows.
- Real D1 ingest after local collector startup.
- Real huEVO iframe partitioned-cookie behavior.
- Real payment SDK, confirmation and callback.
- D1 backup/restore procedure needs a dedicated test.
