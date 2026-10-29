# Huevo Gift Analytics — GitHub Actions + Cloudflare

## Как работает

Пользовательский ПК не участвует в сборе, хранении или деплое.

```
GitHub Actions (каждые 10 минут)
  → headless Chrome + Selenium
  → Huevo: полный проход каталога
  → cloudflare-site/data.json (коммит, если файл изменился)
  → Wrangler deploy
  → Cloudflare Worker: статический сайт и снимок
```

Фронтенд проверяет опубликованный `data.json` каждую секунду без кеша и перерисовывается только при изменении снимка. Это обновляет отображение каждую секунду, но не создаёт запрос к Huevo каждую секунду.

«Последний лот» — первый подарок на первой странице. Порядок лотов сохраняется при экспорте снимка.

## GitHub Secrets

Открой **Settings → Secrets and variables → Actions → Repository secrets**. Нужны:

| Secret | Назначение |
|---|---|
| `HUEVO_COOKIES_JSON` | JSON-экспорт актуальных cookies Huevo |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token для деплоя Worker |
| `CLOUDFLARE_ACCOUNT_ID` | ID аккаунта Cloudflare |
| `HUEVO_USER_AGENT` | Необязательно: User-Agent, соответствующий сессии |

Вместо `HUEVO_COOKIES_JSON` можно использовать `HUEVO_COOKIES`, если этот secret уже создан. Cookies не должны находиться в исходниках, публичном JSON или логах. При утечке сессии отзови её на Huevo и создай новые cookies.

## Разрешения GitHub Actions

В репозитории открой **Settings → Actions → General → Workflow permissions** и включи **Read and write permissions**. Это нужно, чтобы плановый сборщик мог обновлять `cloudflare-site/data.json`.

## Автоматизация

Workflow `.github/workflows/cloudflare-static.yml` запускается по расписанию `*/10 * * * *` (время UTC), а также при изменениях статического сайта в `main` и вручную через **Actions → Huevo cloud collector and Cloudflare deploy → Run workflow**.

GitHub может задерживать scheduled-запуски при высокой нагрузке. Полный обход каталога также может занимать больше 10 минут в зависимости от количества страниц и ответов Huevo. Workflow не обходит защиту Huevo: при блокировке или неполном проходе последний успешный каталог не должен заменяться пустым снимком.

## Проверка

1. Открой **Actions → Huevo cloud collector and Cloudflare deploy**.
2. Запусти **Run workflow** вручную для первой проверки.
3. Убедись, что прошли шаги установки Chrome, сбора каталога, обновления снимка и деплоя Wrangler.
4. Открой сайт Worker и проверь время генерации снимка.

Cloudflare Worker обслуживает статические файлы. Python/Selenium работает в GitHub Actions, а не внутри Cloudflare Worker.