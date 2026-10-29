# Запуск сборщика на Linux-сервере (Ubuntu/Debian)

Схема: вы один раз входите в huevo.su в Chrome на сервере, профиль сохраняется в
`.local-huevo-chrome-profile`, дальше cron раз в 6 часов собирает данные и пушит
`cloudflare-site/data.json`; push запускает деплой в Cloudflare (`cloudflare-static.yml`).

## 1. Установка (под обычным пользователем, не root)
```bash
sudo apt update && sudo apt install -y git python3 python3-venv xvfb x11vnc fluxbox wget
wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt install -y ./google-chrome-stable_current_amd64.deb
git clone https://github.com/monkeyzxcw/huevo-gift-analytics.git && cd huevo-gift-analytics
python3 -m venv .venv && .venv/bin/pip install selenium beautifulsoup4
```
Для `git push` настройте доступ: deploy key с правом записи (Settings → Deploy keys) или токен
только на этот репозиторий. Проверьте: `git push --dry-run origin HEAD`.

## 2. Один раз войти в huevo.su
```bash
Xvfb :99 -screen 0 1440x1000x24 &
export DISPLAY=:99
fluxbox &
x11vnc -display :99 -localhost -nopw -forever &      # слушает только localhost
```
С вашего компьютера: `ssh -L 5900:localhost:5900 user@сервер`, затем VNC-клиент на `localhost:5900`.
В консоли сервера (с `DISPLAY=:99`): `.venv/bin/python scripts/collect_snapshot.py --local-login`.
В окне Chrome войдите в Huevo, откройте каталог, вернитесь в консоль и нажмите Enter.
Остановите VNC и Xvfb (`pkill x11vnc Xvfb`).

## 3. Проверка и расписание
```bash
bash ./run_scheduled_collector.sh && tail -30 logs/scheduled-collector.log
crontab -e     # добавить:
17 */6 * * * /bin/bash /путь/до/huevo-gift-analytics/run_scheduled_collector.sh
```

## Если что-то пошло не так
- `login` в логе: сессия истекла, повторите шаг 2.
- `blocked` (403/418/429): сервер ограничен, сбор остановится и сохранит старые данные.
- Если сайт не признаёт вход и с IP сервера, остаётся ваш ПК (`install_auto_schedule.bat`).
- `push не удался`: коммит остался локально, исправьте доступ и запустите скрипт снова.
