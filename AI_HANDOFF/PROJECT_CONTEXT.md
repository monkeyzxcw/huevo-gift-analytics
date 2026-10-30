# Контекст AMNYAM / Huevo Gift Analytics

Репозиторий: https://github.com/monkeyzxcw/huevo-gift-analytics
Production architecture: Cloudflare Workers + Static Assets + D1. Старые FastAPI/SQLite/Docker/headless-cookie collector компоненты удалены как неиспользуемые.

## Актуальные компоненты
- cloudflare-site/: frontend HTML/CSS/JS and last-known-good snapshot fallback.
- src/worker.js: Cloudflare API, D1 storage, payment flow and static asset routing.
- src/auth.js + src/huevo_launch.js: huEVO signed launch validation and AMNYAM session.
- migrations/: D1 schema.
- snapshot.py: snapshot schema validation and migration.
- tests/e2e, tests/worker, tests/test_snapshot.py: current automated checks.
- .github/workflows/ci.yml: tests only.
- .github/workflows/cloudflare-static.yml: Cloudflare deployment only.

## Сбор Huevo

Рынок собирает отдельный Windows-пакет HuevoDualScan v6, не входящий в GitHub runtime. Архив этой QA-сессии был передан владельцу как `HuevoDualScan-Windows-v6.zip` (SHA-256 `8b25da1ace7ea13e84fe13c6e9752a46217d861cb7c817b54103f93ca8b13939`). ZIP не включён в GitHub repository; временный путь среды выполнения не считать постоянным.

Он запускает два видимых независимых Chrome-профиля:
1. Chrome #1 опрашивает первую страницу примерно раз в 3 секунды и публикует live-изменения.
2. Chrome #2 выполняет полный проход каталога примерно раз в 5 минут.
3. Тот же Chrome #2 после полного прохода обрабатывает очередь /market/lot/<id> → /gift/<id> пачками максимум по 8. Это лимит пачки, не всего цикла: очередь автоматически запускает следующие пачки до дедлайна следующего полного обхода и сохраняет каждый результат в Cloudflare.

В v6 расширено распознавание истёкшей ручной Huevo-сессии (типовые русские/английские сообщения, login title/path), и статус главного окна явно подсказывает, когда нужно снова войти. Python compile с `-Werror` и все 10 офлайн-тестов проходят. Живая авторизация/разметка Huevo в тестовой среде не запускались.

## Авторизация: три независимых понятия
1. Huevo collection: ручной вход в huEVO в ОБОИХ видимых Chrome-окнах. Профили остаются локально в `%LOCALAPPDATA%/HuevoGiftBridge/ChromeProfile` и `ChromeProfileFull`.
2. AMNYAM user profile: Worker проверяет подписанные hu_* параметры запуска, затем выдаёт отдельную HttpOnly cookie `amnyam_session` с Secure, SameSite=None и Partitioned для iframe.
3. Data ingest: `LIVE_INGEST_TOKEN` — отдельный секрет для отправки очищенных JSON-данных в Worker.

Экспортированные Huevo cookies не нужны ни в одном из этих механизмов. Не использовать `HUEVO_COOKIES_JSON`, `HUEVO_COOKIES` или `HUEVO_USER_AGENT`; не возвращать headless GitHub scraper.

## Последние QA-изменения в main

- PR #38 — Cloudflare runtime hardening и удаление 62 устаревших файлов FastAPI/SQLite/Docker/headless cookie collector.
- PR #39 — обновлён post-merge handoff и исправлен canonical Workers URL в runbooks.
- PR #40 — pending payment intent сохраняется в localStorage per huEVO user; bounded status polling, безопасная ручная перепроверка и блокировка второго intent в том же браузере.
- PR #41 — Worker повторно использует серверный pending intent того же пользователя/режима, проверяет huEVO status и применяет детерминированный provider idempotency key для конкурентных запросов.
- PR #42 — keyboard navigation в главном ARIA tablist (ArrowLeft/Right, Home/End).
- Последний main commit: `375336e1fe77cf3b3dbadd622a7e1b8def3ffb34`.
- Последний CI: https://github.com/monkeyzxcw/huevo-gift-analytics/actions/runs/41122557695 — browser suite 36/36 passed; snapshot unit suite 10 tests and data.json validation (474 lots) passed. Recheck final workflow conclusion before relying on a later commit.
- Последний Cloudflare deploy: https://github.com/monkeyzxcw/huevo-gift-analytics/actions/runs/41122555746 — success; Worker Version ID `9aec6a50-652f-4f5e-92b4-aeb181e6160f`.

## Остаточные неизвестные

- Live Huevo login/session expiry and current DOM selectors in both Chrome windows.
- Real D1 ingest after the owner starts local HuevoDualScan v6 and manually logs into both windows.
- Real `amnyam_session` Partitioned-cookie behavior inside huEVO iframe.
- Real huEVO payment SDK/callback. CI uses mocked provider/SDK; server-side idempotency logic is covered by Worker tests.
- D1 backup/restore procedure needs a dedicated test.
- CSS cleanup: current stylesheet has accumulated historical overrides; only refactor after screenshot/visual regression checks.

## Не заявлять то, что не проверено

Successful CI/deploy proves automated tests and Worker publication, not a live Huevo session, real payments or data freshness. If the local collector is closed, the market stops updating; Cloudflare does not scrape Huevo itself.
