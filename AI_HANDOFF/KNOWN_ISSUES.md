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
