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

# Prefer live D1 storage when configured; keep the repository snapshot as a fallback.
WORKER_URL="${HUEVO_WORKER_URL:-https://huevo-gift-analytics.monkeyzxc1437.workers.dev}"
SNAPSHOT_URL="${HUEVO_SNAPSHOT_INGEST_URL:-$WORKER_URL/api/snapshot}"
if [ -n "${HUEVO_LIVE_INGEST_TOKEN:-}" ] && [ -f cloudflare-site/data.json ]; then
  HEALTH="$(curl -fsS --max-time 10 "$WORKER_URL/api/health" || true)"
  if printf '%s' "$HEALTH" | .venv/bin/python -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("storage_configured") and d.get("schema_ready") and d.get("ingest_enabled") else 1)' 2>/dev/null; then
    curl --fail --silent --show-error --max-time 30 \
      -X POST "$SNAPSHOT_URL" \
      -H "Authorization: Bearer $HUEVO_LIVE_INGEST_TOKEN" \
      -H "Content-Type: application/json" \
      --data-binary @cloudflare-site/data.json || exit 1
    echo "snapshot stored in Cloudflare D1; no data.json commit created"
    echo "=== $(date -Is) done ==="
    exit 0
  fi
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
