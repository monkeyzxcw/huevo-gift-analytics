# Актуальные проблемы и риски AMNYAM

Последняя ревизия: 31 октября 2026. Перед изменениями проверяй актуальные main, PR и Actions.

## Исправлено

### PR #38 — Cloudflare cleanup / runtime hardening
- Убрана scheduled Huevo cookie scraper job; GitHub выполняет CI, D1 migrations и Cloudflare deploy, но не авторизуется на Huevo.
- Разделены signed huEVO launch, AMNYAM session cookie и ручной вход в локальных Chrome-профилях.
- Добавлены request timeouts, fail-closed malformed snapshot handling и backoff для live polling/profile saves.
- Target prices валидируются одинаково в UI и Worker как safe integer.
- Исправлены duplicate huEVO auth requests, payment busy/timeout state и ошибка target price в detail dialog.
- Удалены 62 устаревших файла/фикстуры старого FastAPI/SQLite/Docker/headless collector и дублирующего static frontend.

### PR #40 — safe payment recovery in the browser
- Pending intent хранится локально отдельно для huEVO user ID до 7 дней.
- Тайм-аут общей проверки статуса ограничен; ручная кнопка «Проверить статус» не создаёт новый intent.
- Неопределённый статус явно предупреждает пользователя не создавать повторный платёж.
- Playwright проверяет outage, reload, запрет duplicate intent и успешную повторную проверку.

### PR #41 — server-side payment deduplication
- Worker ищет существующий pending intent для huEVO user + mode до создания нового платежа.
- Сверяет его с huEVO status API; при pending или временной ошибке возвращает прежний intent.
- При подтверждённом final status обновляет D1 и позволяет создать новый сознательный платеж.
- Provider idempotency key стабилизирует конкурентные запросы для того же пользователя.
- Добавлены Worker-level tests на повторный запрос и недоступность status API.

### PR #42 — keyboard navigation
- Главный tablist поддерживает ArrowLeft/ArrowRight, Home и End с правильным roving focus.

## CI / deploy evidence

- PR #38–#42 merged в main.
- Последний main commit: `b3156757be451b7be93dea12dddff8b7ebafab45` (Git tree совпадает с задеплоенным `375336e1`).
- CI: https://github.com/monkeyzxcw/huevo-gift-analytics/actions/runs/41122557695 — browser suite 36/36 passed; snapshot tests 10/10 and data.json validation (474 lots) passed. Verify final overall workflow conclusion for this exact SHA.
- Cloudflare deploy: https://github.com/monkeyzxcw/huevo-gift-analytics/actions/runs/41122555746 — success; Worker version `9aec6a50-652f-4f5e-92b4-aeb181e6160f`.
- HuevoDualScan v6 package: `py_compile -Werror` and 10/10 offline parser/history/auth tests passed. No live Huevo account/browser test was performed.

## Остаточные риски / действия владельца

1. **Live Huevo session.** Войти вручную в обоих видимых Chrome окнах HuevoDualScan v6. Exported Huevo cookies are not supported and must not be requested.
2. **D1 ingest.** После запуска коллектора проверить /api/health, /api/live/status и /data.json; реальная запись D1 зависит от доступного LIVE_INGEST_TOKEN и ручной Huevo session.
3. **huEVO iframe.** Проверить Partitioned cookie `amnyam_session` в актуальном встроенном браузере.
4. **Payments.** Worker duplicate-intent prevention and UI recovery are automated, but actual huEVO SDK confirmation and callback need a real test payment in the iframe.
5. **D1 backup/restore.** Нет отдельного end-to-end теста восстановления.
6. **CSS maintainability.** Stylesheet has many layered overrides and !important rules; consolidate only with screenshot/visual regression tests.
7. **Freshness.** Если локальный HuevoDualScan закрыт или Chrome просит вход, новые лоты не поступают; Cloudflare сам Huevo не сканирует.

## Следующие инженерные задачи

- D1 backup/restore test and a documented recovery procedure.
- Worker route security contract tests: auth, CSRF/CORS, ingest body limits, malformed payloads. Payment status visibility intentionally не блокирует релиз по решению владельца.
- Keyboard-only audit for all dialogs and command palette (main tablist navigation is fixed).
- Visual regression / CSS deduplication and mobile checks with reduced motion.
- Live Huevo DOM validation in both manual Chrome profiles; never substitute cookie exports.

## Engineering update — 2026-11-01

Recent merged PRs after the previous handoff:

- PR #58: huEVO provider requests now have an 8-second abort timeout; regression test verifies timeout errors do not create false pending-payment records.
- PR #59: ingest security contracts cover missing/wrong Bearer token, disabled ingest configuration, malformed JSON, unsupported content encoding, and oversized snapshots. Both CI jobs passed.
- PR #60: frontend contracts lock the ~3-second Live lane, 5-minute full-snapshot lane, same-page polling, safe DOM/CSP, and sound-only/no-Push notification behavior. Added the release acceptance checklist. CI passed.
- PR #61: documented D1 SQL export and Time Travel recovery; tests assert explicit D1 binding, ordered migrations, and migration-before-deploy. CI passed.
- PR #62: fixed shared frontend polling backoff. A failure in `/api/live/status` previously could suppress the separate `/data.json` refresh and vice versa. Each lane now has independent failure counters, backoff deadlines, and visibility-resume resets. CI passed.
- PR #63: added post-deploy smoke checks for `/api/health`, `/api/live/status`, and `/data.json`, including D1/schema readiness, ingest secret presence, and a non-empty snapshot. Live freshness is reported but does not fail a deploy when the local collector is simply offline. CI passed.

### Local collector artifact

- HuevoDualScan v12 was generated as a separate Windows ZIP artifact, not committed to the repository.
- SHA-256: `8f9cd153ef6c29e386c29acfe27ace91e6f0afe7041ad80ce5c0de677b5d23d9`.
- Verification: `python -Werror -m py_compile HuevoDualScan_app.py` passed; offline parser/history/auth suite: 41/41 passed.
- v12 fixes an inconsistency where the Live worker's private challenge-marker list missed explicit HTTP 418/429 pages. It now uses the same shared challenge detector as the full scan and enrichment queue; the shared detector recognizes HTTP 418/429 variants. The manual-login screen is still distinguished from a rate-limit/challenge.
- The visible UI title was corrected from stale v8 text to v12; the Windows Credential Manager entry remains compatible with v5.
- No live Huevo login or current DOM check was performed from this environment. Manual login in both visible Chrome windows remains required; do not use exported cookies.

### Production verification status

- PR #63's CI passed and it is merged. The deployment workflow now includes a post-deploy smoke step, but a successful production smoke result has **not yet been observed in this handoff**. Check the latest GitHub Actions run for “AMNYAM Cloudflare deploy” and confirm the smoke step passes before claiming production is healthy.
- Cloudflare's separate Git-integration Preview bot has continued to report failed Preview builds on PRs. Its comments link to authenticated Cloudflare dashboard build logs; the exact failure reason was not available in this session. Do not guess that cause or confuse a failed Preview build with the GitHub Actions deploy workflow.
- Production endpoint checks from this assistant environment have been inaccessible. Treat current production runtime and fresh collector data as unverified until the post-deploy smoke step and a live HuevoDualScan run are confirmed.

### New operational documentation

- `docs/RELEASE_QA.md`: release acceptance, dual-window collector checks, manual login and sound-only constraints.
- `docs/D1_BACKUP_RESTORE.md`: D1 SQL export, Time Travel restore safeguards and post-restore verification.
