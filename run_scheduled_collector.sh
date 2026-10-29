#!/usr/bin/env bash
# Linux analogue of run_scheduled_collector.bat: pull -> saved-profile collection -> commit/push data.json.
# Run under an unprivileged user from cron. Logs: logs/scheduled-collector.log
set -u
cd "$(dirname "$(readlink -f "$0")")"
mkdir -p logs
exec 9>logs/.collector.lock
flock -n 9 || { echo "$(date -Is) already running, skip" >> logs/scheduled-collector.log; exit 0; }
exec >> logs/scheduled-collector.log 2>&1
echo; echo "=== $(date -Is) start ==="

[ -x .venv/bin/python ] || { echo "Missing .venv: see LINUX_SERVER_RU.md"; exit 2; }

git restore -- cloudflare-site/data.json || exit 1
git pull --rebase --autostash origin main || { echo "pull failed"; exit 1; }

.venv/bin/python scripts/collect_snapshot.py --local-profile
code=$?
if [ "$code" -eq 3 ]; then
  echo "Huevo cooldown active: no request sent"
  exit 3
fi
if [ "$code" -ne 0 ]; then
  echo "collection failed (code $code); previous data retained"
  git restore -- cloudflare-site/data.json
  exit "$code"
fi

git add cloudflare-site/data.json
if git diff --cached --quiet -- cloudflare-site/data.json; then
  echo "data unchanged"
else
  git -c user.name="Local Huevo Collector" -c user.email="huevo-local-collector@users.noreply.github.com" \
    commit --only cloudflare-site/data.json -m "Update Huevo market snapshot (server collector)" || exit 1
  git push origin HEAD || { echo "push failed; commit remains local"; exit 1; }
  echo "pushed; Cloudflare will deploy from push"
fi
echo "=== $(date -Is) done ==="
