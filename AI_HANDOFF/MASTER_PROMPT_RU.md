# Рабочее задание — дальнейшая разработка AMNYAM

Репозиторий: https://github.com/monkeyzxcw/huevo-gift-analytics. Работай на русском. Production runtime: Cloudflare Workers + Static Assets + D1. Локальный HuevoDualScan — отдельный Windows ZIP.

## Правила
1. Сначала проверяй актуальные main, PR, commits, Actions и Cloudflare deployment.
2. Делай тематические fixes и regression tests в отдельной ветке/PR; не ломай main.
3. Не говори, что CI, live Huevo, payment, D1 write или deploy проверены без фактического результата.
4. Не запрашивай и не печатай cookies, hchk, Authorization, LIVE_INGEST_TOKEN, HU_SECRET, Cloudflare token или HAR.
5. Exported Huevo cookies не используются. Collection auth — ручной вход в оба видимых Chrome-профиля локального HuevoDualScan.
6. Не обходи CAPTCHA/anti-bot/403/418/429. Останавливай сбор и соблюдай cooldown.
7. Не путай signed huEVO launch, AMNYAM amnyam_session и локальные Chrome profiles.
8. Перед удалением файла проверяй импортный граф, workflow, test references и документы. Не удаляй last-good data или D1 migrations без backup.

## Архитектура
- cloudflare-site/: UI.
- src/worker.js: Cloudflare API.
- src/auth.js + src/huevo_launch.js: signed huEVO identity and AMNYAM session.
- migrations/: D1.
- snapshot.py: snapshot schema validation.
- GitHub CI: tests. Deploy workflow: Cloudflare deploy only. Worker cron: D1 cleanup only.
- HuevoDualScan: Chrome #1 live page 1 ~3 s; Chrome #2 full catalogue ~5 min; same Chrome #2 drains instance enrichment in successive batches of 8 and publishes after each batch.

## QA sequence
1. Inventory tracked files, imports, endpoints, workflow triggers and secrets dependencies.
2. Reproduce a bug, prove root cause, write a regression test and apply a narrow fix.
3. Test loading/disabled states, duplicate clicks, empty/invalid input, slow/network failure, retry and keyboard accessibility.
4. Run npm run check, npm run test:e2e, snapshot unit tests, JSON checks.
5. Verify latest Actions commit, not a previous commit.
6. After merge, confirm Cloudflare deploy run before claiming production release.
7. Live Huevo and real payment require the actual local browser/iframe and must be labelled unverified until tested.

## Data integrity
Чётко различай asking price, drop price и completed-sale amount. Исчезновение лота не доказывает продажу. Не выдумывай sale timestamps or prices. Сохраняй append-only history and last-good snapshot при partial/blocked crawl.

Дополнительные актуальные задачи смотри в KNOWN_ISSUES.md.
