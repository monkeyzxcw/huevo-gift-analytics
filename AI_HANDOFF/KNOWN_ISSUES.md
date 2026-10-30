# Актуальные проблемы и риски AMNYAM

Последняя ревизия: 31 октября 2026. Перед изменениями проверяй актуальный main, PR и Actions.

## Исправлено в PR #38
- GitHub workflow больше не запускает Huevo scraper через HUEVO_COOKIES_JSON/HUEVO_COOKIES. GitHub выполняет CI и Cloudflare deploy.
- Разделены signed huEVO launch, AMNYAM session cookie и локальные Chrome-профили для ручного входа.
- Добавлены тайм-ауты для frontend/API requests; некорректный data.json не выдаётся за пустой каталог.
- Live polling сохраняет последний корректный snapshot и применяет backoff.
- Target prices проверяются как безопасные целые значения на frontend и Worker; дробные значения не округляются молча.
- Profile save requests сериализованы, transient failures повторяются с backoff.
- Повторный huEVO auth не запускает параллельные запросы.
- Payment buttons блокируются на время операции; зависший SDK confirmation ограничен тайм-аутом, а статус проверяется у сервера.
- Ошибка target price отображается в открытой карточке, не под modal overlay.
- Устаревший FastAPI/SQLite/Docker runtime, старый static frontend, headless cookie collector и связанные тесты удалены.

## CI evidence
Успешный CI: https://github.com/monkeyzxcw/huevo-gift-analytics/actions/runs/41117341599 (коммит a4555da3ba812462a314197bccb49d3e251694eb). Snapshot validation и browser/Worker tests прошли. При каждом новом коммите перепроверяй самый свежий run.
Windows ZIP HuevoDualScan v5: py_compile -Werror и 8 offline tests прошли. Live Huevo не запускался.

## Остаточные риски
1. Live Huevo и текущая DOM-разметка должны быть проверены только в локальном видимом Chrome; экспорт cookies не запрашивать.
2. Проверить реальную запись D1 после запуска локального HuevoDualScan через /api/health, /api/live/status и /data.json.
3. Проверить amnyam_session с Partitioned cookie в реальном iframe huEVO.
4. Реальный payment SDK/callback не подтверждён CI mock-тестами.
5. События /gift/ не содержат гарантированную цену сделки. Drop price и asking price не являются completed-sale amount.
6. Cloudflare сам не собирает Huevo: если локальное приложение выключено, данные устаревают.
7. В старой переписке были опубликованы request headers с cookie. Значения не сохранять. Если эта сессия ещё действительна, завершить её в Huevo и войти заново.

## Следующие улучшения
- D1 backup/restore test.
- Worker route security contract tests: auth, CSRF/CORS, ingest limits, malformed payloads.
- Focus restore/trap, keyboard-only tests for dialogs, command palette, support flow.
- Accessibility and performance checks for mobile/reduced-motion.
- CSS cascade cleanup after measuring current visual regressions.
