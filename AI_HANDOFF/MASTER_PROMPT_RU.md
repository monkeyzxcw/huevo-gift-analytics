# MASTER PROMPT — довести Huevo Gift Analytics минимум до 80% готовности

Ты — ведущий инженер/архитектор, которому передали существующий репозиторий Huevo Gift Analytics. Не ограничивайся рекомендациями: самостоятельно исследуй код, воспроизводи дефекты, исправляй безопасные проблемы, добавляй тесты, обновляй документацию и доводи проект до устойчивого состояния минимум на 80% от разумного production-ready MVP.

Репозиторий: https://github.com/monkeyzxcw/huevo-gift-analytics
Основная ветка на момент handoff: main.
Работай и отчитывайся на русском языке.

## 0. Правила

1. Прочитай AI_HANDOFF/README.md, PROJECT_CONTEXT.md, KNOWN_ISSUES.md и HUEVO_MARKET_RESEARCH.md. Затем сам проверь актуальный код, default branch, последние commits, Actions runs/logs, workflows и Cloudflare configuration.
2. Выполняй работу, а не только составляй план. Если доступны GitHub tools, делай тематические commits/PR и проверяй CI. Не делай больших несвязанных изменений одним коммитом.
3. Не переписывай всё без baseline и доказанной причины. Сначала воспроизведение, затем root cause, минимальный fix, regression test, полный прогон.
4. Не заявляй, что тесты/деплой проверены, если нет фактического результата. Разделяй факты, гипотезы и неизвестное.
5. Никогда не раскрывай и не запрашивай cookies, session, hchk, Authorization, INGEST_TOKEN, Cloudflare API token, payment secrets или другие credentials. Не помещай их в logs, fixtures, issue, docs, public JSON или commits. В переписке уже была раскрыта сессионная cookie; владелец должен инвалидировать/обновить сессию. Не повторяй значения.
6. Не обходи CAPTCHA, антибот-защиту, 403/418/429 или ограничения частоты. При блокировке остановись, соблюдай Retry-After/cooldown и сохрани last-known-good данные.
7. Локальный Chrome profile должен оставаться локальным и ignored. Предпочитай локальный авторизованный браузер + публикацию очищенного JSON, если этот путь действительно работает. Не переносить сессию в Cloudflare Worker и не добавлять cookies в GitHub secrets по инерции.
8. Перед разрушительными миграциями делай backup и проверяй restore. Не удаляй и не применяй архивы из папки «Для Chatgpt» без сравнения с main.
9. Если окружение не позволяет запустить команду, не имитируй результат: выполни доступные проверки и оставь владельцу конкретный шаг.
10. Не проси владельца подтверждать обычные технические правки. Задавай вопрос только при настоящем блокирующем продуктовом выборе.

## 1. Цель продукта

Сделать надёжную аналитику huEVO, которая показывает текущие объявления, историю наблюдавшихся цен и, если источник позволяет, историю завершённых продаж. Сбор должен быть повторяемым, безопасным и честно сообщать статус/покрытие. Система должна сохранять последний успешный snapshot при частичном сборе или блокировке. UI и статистика обязаны отличать asking price от completed-sale price. Нельзя выдумывать даты, сделки или подтверждения продажи.

«80% готовности» означает надёжный основной сценарий, зелёные проверки, воспроизводимый deploy, безопасные данные и ясные инструкции; это не число изменённых файлов.

## 2. P0 — исправить красный CI

Последний проверенный run был https://github.com/monkeyzxcw/huevo-gift-analytics/actions/runs/40935044289: 113 Python tests, 6 failures в tests/test_crawler.py; browser и Docker jobs прошли. Сначала проверь актуальный статус Actions.

Падавшие сценарии:
- HTTP 418 на второй странице должен приводить к blocked, status 418, source network, Retry-After 120.
- 403/429 должны распознаваться как блокировки.
- 500 должен приводить к server_error, а не к пустому каталогу.
- нормальная пустая страница после первой может означать конец каталога.
- проход с уже встречавшимися лотами должен правильно распознавать конец.
- max_pages не должен ложно означать достигнутый конец.

Фактический симптом: crawler возвращал no_cards, HTTP 200 и ноль страниц/лотов там, где tests ожидали network status, конец каталога или server/block status.

Порядок:
1. Прочитай crawler.py, huevo_probe.py, lot_parser.py, tests/test_crawler.py, tests/test_probe.py, fixtures и diffs последних commits. Особенно изучи commits 11f2d9fe5cd99efd9b9d4e70eb55b97a589a56cd, e43b1291ea18869944f37f624f8ccc564d8ac7f3 и 4809adb578e9a09b4bebaf53c8343c2d0263a517.
2. Запусти crawler tests отдельно и полный Python suite. Проследи путь navigate → ready wait → performance log → classify network/page → parse cards → pagination.
3. Найди доказанную первопричину. Не ослабляй assertions, не отключай tests и не проглатывай ошибки.
4. Добавь regression tests.
5. Убедись, что blocked/incomplete crawl не заменяет snapshot, не помечает lots inactive и не меняет историю цены.
6. Запусти все проверки и добейся зелёного CI.

## 3. P0 — проверить end-to-end автоматизацию и деплой

Есть противоречие:
- CLOUDFLARE_FREE_SETUP_RU.md описывает GitHub Actions scheduled collection с HUEVO_COOKIES_JSON secret и Docker/Selenium.
- Проверенный cloudflare-static.yml только деплоит assets через Wrangler, без cron и collector.
- run_scheduled_collector.bat и install_auto_schedule.bat реализуют локальную Windows Task Scheduler схему: local Chrome profile → collect_snapshot.py --local-profile → commit/push только cloudflare-site/data.json → Cloudflare deploy on push.

Задачи:
1. Проследи реальный путь от первого local login до публичного Cloudflare сайта.
2. Проверь run_local_collector.bat, scripts/collect_snapshot.py modes --local-login и --local-profile. Проверь истёкшую сессию, профиль, headless/interactive режим, Chrome conflicts и exit codes.
3. Проверь pull/rebase conflicts, failed push recovery, concurrency, сохранение локальных изменений и логи. Не затирай незакоммиченные изменения владельца.
4. Подтверди, что изменение data.json запускает deploy workflow и permissions достаточны.
5. Выбери один основной безопасный workflow и перепиши README_RU.md и CLOUDFLARE_FREE_SETUP_RU.md так, чтобы инструкции соответствовали коду. Cloudflare Worker обслуживает static assets; Python/Selenium внутри него не запускается.
6. Проверь public snapshot на secrets и лишние личные данные.
7. Не утверждай, что Task Scheduler работает, без реального запуска/лога.

## 4. P1 — реализовать историю завершённых продаж

Подтверждённый HTML источник: https://huevo.su/market/history. Таблица .mk-table содержит Lot, Price, Seller, Buyer, Date; lot URL вида /market/lot/<id>. Есть фильтры kind=gift, kind=username, mine=1. В HTML указано 652 страницы. Пример времени отображается как 01:22; календарная дата не подтверждена. /market/gifts?page=3 тоже отдаёт HTML, а не JSON. Заголовки X-Huevo-Frag и X-Huevo-Pjax похожи на PJAX navigation, но сами по себе не доказывают формат фрагмента.

План:
1. Создай отдельный history parser и очищенные/synthetic fixtures; не перегружай lot_parser.
2. Тестируй ID лота, название, цену, URL, пустые/частичные строки, escaping, unusual whitespace и duplicates.
3. Исследуй 2–3 страницы, пагинацию и timestamp semantics. Не сканируй все 652 страницы вслепую.
4. Определи устойчивый trade key. Не считай lot_id автоматически уникальным trade ID, если один лот может участвовать в повторных операциях. Если используется composite fingerprint, задокументируй риск коллизий.
5. Сделай idempotent upsert/deduplication.
6. Храни raw displayed date/time отдельно от normalized sale timestamp (nullable), observed_at, source URL/page и parser version. Не присваивай дату запуска как дату сделки.
7. Минимизируй персональные данные; не публикуй имена продавцов/покупателей, если они не нужны для метрик.
8. Ограничь частоту запросов; остановись на login/challenge/403/418/429/5xx; уважай Retry-After; не делай retry loops.
9. Partial crawl не должен помечать данные полными или затирать last-known-good history.
10. Добавь отдельные completed-sale metrics (count, median, quantiles, price distribution; time series только при достоверной дате). Не смешивай с asking-price stats. Обрабатывай выбросы, включая подозрительные цены по 1 монэтке.
11. Если timestamp или стабильный ключ не удаётся получить, реализуй безопасную часть и опиши ограничение вместо выдумывания данных.

## 5. P1 — полный аудит корректности

Проверь:
- lot_parser.py: selectors, ID, title, serial, rarity, price, status, image URL, escaping, deduplication, number parsing.
- crawler.py: page limits, timeout, status precedence, login/challenge detection, pagination/end logic, completeness threshold.
- storage.py: migrations, unique keys, transactions, history dedupe, backup/restore.
- analytics.py: median/quartiles, comparable lots, outliers, empty datasets, inactive lots, price units.
- scripts/collect_snapshot.py: atomic write, validation, schema version, exit codes, last-good preservation, local profile.
- scripts/import_sqlite_snapshot.py: filtering, no support/payment data, deterministic output, no DB secrets.
- cloudflare-site/app.js/index.html: schema handling, safe DOM rendering/XSS, large data, loading/error/empty states, filters, mobile layout and accessibility.
- static/app.js, static/browser_collector.js, app.py, support.py: auth, ingestion, payment callbacks, compatibility.
- security.py: CSP and security headers.

Сохраняй regression tests и совместимость. Не переписывай всё ради стиля.

## 6. P1 — security/privacy audit

Проверь auth/ingest token, CORS/CSRF, rate limits, CSP/security headers, URL allowlists, payment signature, replay/staleness/idempotency, logging, secrets, cookie handling и public snapshot. Сканируй историю безопасно, выводя только redacted paths/status, никогда не сами secret values. Если секрет был committed, нужен rotation/revocation; оценить очистку Git history. Убедись, что .env, SQLite DB, Chrome profile, logs, cookie exports, HAR и raw personal data игнорируются и не попадают в repo. Не сохраняй Cookie/Authorization/raw body в logs.

## 7. P2 — CI, документация и эксплуатация

Запусти и исправь:
- Python unit/API tests;
- npm run check;
- node --check cloudflare-site/app.js;
- py_compile для collector/importer;
- JSON validation для data.json и wrangler.jsonc;
- Playwright E2E;
- Docker build и smoke test;
- GitHub Actions после push/PR.

Проверь workflow permissions, triggers, concurrency, timeouts, dependency versions и runtime warnings. Обнови README_RU.md, CLOUDFLARE_FREE_SETUP_RU.md, .env.example и runbook при необходимости. Документируй первый запуск, истёкшую сессию, block/cooldown, failed git push, повреждённый JSON, rollback, логи и проверку Task Scheduler.

## 8. Итерации и commits

A. Inventory/baseline и актуальный статус CI.
B. Root cause crawler + tests.
C. End-to-end automation/deployment + документация.
D. History parser/model + fixtures/tests/deduplication.
E. Analytics/UI: asking price и completed sales отдельно.
F. Security/data correctness audit.
G. Full verification, deployment check, итоговый handoff.

Каждый commit тематический и небольшой. Не коммить тестовые данные как production snapshot. Не удаляй last-good data. Если используешь PR, дождись checks.

## 9. Acceptance checklist

- [ ] root cause всех CI failures исправлен;
- [ ] все существующие Python, E2E, config и Docker checks зелёные;
- [ ] тесты не отключены и assertions не ослаблены ради зелёного CI;
- [ ] local collection → data.json → push → Cloudflare deploy проверены end-to-end;
- [ ] документация совпадает с фактической архитектурой;
- [ ] atomic snapshot и last-good behavior проверены;
- [ ] history parser покрыт fixtures/tests, дедуплицирует записи, либо документировано конкретное ограничение источника;
- [ ] asking prices и completed sales отделены;
- [ ] unknown sale dates не выдуманы;
- [ ] secrets/session data отсутствуют в Git, public assets и logs;
- [ ] critical/high security issues исправлены;
- [ ] пользовательские инструкции и runbook готовы;
- [ ] итоговый отчёт содержит файлы, commits, ссылки Actions, точные результаты тестов, deploy status, риски и оставшиеся задачи.

## 10. Итоговый отчёт владельцу

На русском языке сообщи:
1. Что исправлено по приоритетам.
2. Какие файлы изменены и зачем.
3. Какие команды/тесты запущены и точные результаты.
4. Ссылки на commits/PR/Actions.
5. Deployment status только при наличии подтверждения.
6. Как запускать и проверять сборщик/Task Scheduler.
7. Что осталось и почему.
8. Реалистичную оценку готовности по acceptance checklist, не завышая её.

Начни с проверки актуального состояния и исправления root cause красного CI. Не заканчивай только планом.
