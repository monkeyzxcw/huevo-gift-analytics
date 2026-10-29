@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo Python environment is missing. Run run_local_collector.bat once first.
  exit /b 2
)
if not exist "logs" mkdir "logs"

call :run >> "logs\scheduled-collector.log" 2>&1
exit /b %ERRORLEVEL%

:run
echo.
echo ============================================================
echo Huevo scheduled collector started: %DATE% %TIME%
echo ============================================================

REM Discard only an uncommitted status/error snapshot from a failed previous run.
REM Successful snapshots are committed before pushing.
git restore -- cloudflare-site/data.json
if errorlevel 1 goto failed

REM Sync source and any previous local commit before collecting.
git pull --rebase origin main
if errorlevel 1 goto failed

REM Reuse the dedicated local Chrome profile; cookies never leave this PC.
".venv\Scripts\python.exe" scripts\collect_snapshot.py --local-profile
if errorlevel 1 goto failed

git add cloudflare-site/data.json
if errorlevel 1 goto failed

git diff --cached --quiet -- cloudflare-site/data.json
if errorlevel 1 (
  git -c user.name="Local Huevo Collector" -c user.email="huevo-local-collector@users.noreply.github.com" commit --only cloudflare-site/data.json -m "Update Huevo market snapshot (scheduled local collector)"
  if errorlevel 1 goto failed
  git push origin HEAD
  if errorlevel 1 goto failed
  echo Snapshot pushed. GitHub Actions will deploy it to Cloudflare.
) else (
  echo Snapshot is unchanged; nothing to push.
)

echo Scheduled collection finished successfully: %DATE% %TIME%
exit /b 0

:failed
echo Scheduled collection FAILED: %DATE% %TIME% (see messages above)
exit /b 1
