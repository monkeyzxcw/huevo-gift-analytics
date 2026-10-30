# Cloudflare D1: полный снимок и live-первая страница

## Схема обновления

Рынок обновляется локальным приложением HuevoDualScan на Windows; Cloudflare только принимает, хранит и раздаёт данные.

1. Chrome №1 — live-страница. Видимое окно с отдельным профилем Chrome, вручную авторизованным в huEVO. Локальный сборщик читает первую страницу маркета примерно каждые 3 секунды и отправляет очищенные поля лотов в Worker: POST /api/live/page.
2. Chrome №2 — полный каталог. Второе видимое окно с отдельным профилем Chrome, также авторизованным вручную. Оно проходит каталог и публикует полный снимок: POST /api/snapshot.
3. Очередь экземпляров. В том же втором окне после полного прохода последовательно читаются /market/lot/<id> и /gift/<id>, небольшими пачками. Третий Chrome не требуется; очередь сохраняет прогресс после каждой пачки.

Экспорт cookies, GitHub Actions, headless Chrome и cron Worker не используются для авторизации и сбора. Вход выполняется вручную в каждом из двух окон Chrome. Если Huevo показывает login, CAPTCHA, challenge, 403, 418 или 429, сборщик приостанавливает работу, а не пытается обходить ограничение.

## 1. Создать или проверить D1

В Cloudflare открой Storage & databases → D1 SQL Database и убедись, что настроена база huevo-live-data. В корневом wrangler.jsonc должен быть binding DB с реальным Database ID. Сам ID не является секретом.

GitHub deploy workflow применяет файлы из migrations/ до публикации Worker. Для этого Cloudflare API Token в GitHub Secret CLOUDFLARE_API_TOKEN должен иметь право D1: Edit и Workers Deploy.

## 2. Настроить секреты

В Worker huevo-gift-analytics создай Secret LIVE_INGEST_TOKEN со случайной длинной строкой. Вводи то же значение в поле токена локального HuevoDualScan. Не присылай его в чат и не коммить в репозиторий.

Для профиля huEVO Apps Worker также использует серверные настройки HU_APP_ID и HU_SECRET. Они не имеют отношения к ingest-токену или браузерным cookies.

В GitHub Secrets для текущего deploy нужны только CLOUDFLARE_API_TOKEN и CLOUDFLARE_ACCOUNT_ID. Секреты HUEVO_COOKIES_JSON, HUEVO_COOKIES и HUEVO_USER_AGENT не используются и добавлять их не нужно.

## 3. Локальный Chrome

1. Запусти отдельный Windows ZIP HuevoDualScan v5.
2. Введи LIVE_INGEST_TOKEN.
3. Нажми «Проверить Cloudflare», затем «Запустить и открыть Huevo».
4. Дождись открытия двух окон Chrome.
5. Войди в huEVO вручную в каждом окне. Не закрывай эти окна во время работы.
6. Оставь открытым главное окно HuevoDualScan.

Профили Chrome лежат в %LOCALAPPDATA%/HuevoGiftBridge/ChromeProfile и %LOCALAPPDATA%/HuevoGiftBridge/ChromeProfileFull. Они остаются на этом ПК и не входят в ZIP. Не удаляй их, если хочешь сохранить авторизацию.

Для сбора используется одна сессия на каждое окно. Внешние cookie-файлы не экспортируются и не передаются Worker. На сервер отправляются только очищенные структурированные данные, не raw HTML и не cookie значения.

## 4. Проверка Worker

- https://huevo-gift-analytics.monkeyzxc1437.workers.dev/api/health — проверить D1, схему и ingest.
- https://huevo-gift-analytics.monkeyzxc1437.workers.dev/api/live/status — проверить время последнего live-опроса и число элементов.
- https://huevo-gift-analytics.monkeyzxc1437.workers.dev/data.json — получить объединённый снимок.

## Частота и сохранение

- Live-опрос первой страницы выполняется примерно раз в 3 секунды, если Huevo доступен и нет challenge.
- Полный проход каталога запускается примерно раз в 5 минут; второй Chrome не выполняет параллельные действия в одной сессии.
- Очередь экземпляров использует последовательные пачки, сохраняет прогресс в D1 после каждой пачки и продолжает с оставшимися подарками.
- Worker cron в wrangler.jsonc выполняет только обслуживание и retention-cleanup D1.
- История live-цен ограничена retention-настройкой Worker. Удаление старых точек не удаляет текущий снимок рынка и пользовательские профили.
- История экземпляра не содержит сумму завершённой сделки, если Huevo её явно не показывает; цена объявления и цена выпуска не выдаются за цену продажи.
