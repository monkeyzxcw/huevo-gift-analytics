# Huevo Gift Analytics — Cloudflare Workers

Рабочий сайт: https://huevo-gift-analytics.monkeyzxcw.workers.dev

## Архитектура

- GitHub Actions запускает сборщик Huevo по расписанию раз в 10 минут и по ручному запуску.
- Сборщик использует headless Chrome, получает полный снимок каталога и обновляет `cloudflare-site/data.json` только после успешного полного прохода.
- После сбора GitHub Actions сохраняет обновлённый снимок (или безопасный статус блокировки) в `main`.
- Отдельный job проверяет JSON и публикует статический сайт через Wrangler на Cloudflare.
- Render не используется.
- Cookies не хранятся в исходниках, публичном JSON, артефактах или логах.

## 1. GitHub Secrets

Открой репозиторий → **Settings → Secrets and variables → Actions** и добавь:

| Secret | Назначение |
|---|---|
| `HUEVO_COOKIES_JSON` | Актуальный экспорт cookies Huevo в JSON |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token с минимальными правами для Workers Scripts/Static Assets |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID из Cloudflare Dashboard |
| `HUEVO_USER_AGENT` | Необязательно: User-Agent браузера, экспортировавшего cookies |

Можно использовать `HUEVO_COOKIES` вместо `HUEVO_COOKIES_JSON`, если уже настроен этот secret. Не используй Global API Key. При утечке cookies отзови сессию на Huevo и создай новый экспорт. Никогда не вставляй значения secrets в issue, PR, исходники или логи.

## 2. Проверить Cloudflare

Файл `wrangler.jsonc` содержит имя Worker `huevo-gift-analytics` и публикует только каталог `cloudflare-site/`. Не создавай второй Worker с другим именем.

## 3. Автоматический сбор и деплой

Workflow `.github/workflows/cloudflare-static.yml`:
- запускается по расписанию каждые 10 минут (UTC);
- поддерживает ручной запуск через **Actions → Huevo collector and Cloudflare deploy → Run workflow**;
- останавливается при блокировке Huevo и сохраняет статус/период ожидания, чтобы следующий запуск не отправлял запросы раньше времени;
- проверяет снимок перед публикацией и деплоит статические файлы на Cloudflare.

GitHub может задерживать scheduled-запуски при высокой нагрузке. Полный обход каталога может занять больше 10 минут; concurrency не позволяет параллельным запускам пересекаться.

## 4. Безопасность и ограничения

- При 403/418/429, странице входа или неполном обходе сборщик не должен заменять последний корректный снимок данными неполного прохода.
- При блокировке соблюдается `Retry-After` и локально настроенная пауза; не пытайся обходить ограничения сменой IP или маскировкой.
- Cookies передаются только процессу сборщика через GitHub Secrets. Они не должны попадать в JSON снимка.
- Cloudflare Worker обслуживает статику; он не запускает Python, Selenium, SQLite или Windows Task Scheduler.
- Живая разметка Huevo и успешный реальный деплой необходимо проверять по результатам GitHub Actions. Успешные локальные тесты сами по себе не доказывают, что внешняя сессия Huevo ещё действительна.
