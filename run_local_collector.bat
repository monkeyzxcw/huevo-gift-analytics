@echo off
setlocal
cd /d "%~dp0"

echo ==========================================
echo Huevo Gift Analytics - local PC collector
echo ==========================================
echo This opens Chrome on THIS PC. Sign in to Huevo manually.
echo Your browser profile stays local and is excluded from Git.
echo.

where py >nul 2>nul
if errorlevel 1 (
  echo Python launcher "py" was not found. Install Python 3.11+ and enable PATH.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo Creating Python virtual environment...
  py -3 -m venv .venv
  if errorlevel 1 goto failed
)

echo Installing/updating required Python packages...
".venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 goto failed
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto failed

echo.
echo Launching visible Chrome. Log in when prompted, then return here and press Enter.
".venv\Scripts\python.exe" scripts\collect_snapshot.py --local-login
if errorlevel 1 (
  echo.
  echo Collection failed. Existing valid market data has been preserved.
  pause
  exit /b 1
)

echo.
echo Snapshot updated locally: cloudflare-site\data.json
echo Publishing this snapshot to GitHub so Cloudflare can deploy it...
git add cloudflare-site/data.json
if errorlevel 1 goto failed
git diff --cached --quiet -- cloudflare-site/data.json
if errorlevel 1 (
  git -c user.name="Local Huevo Collector" -c user.email="huevo-local-collector@users.noreply.github.com" commit --only cloudflare-site/data.json -m "Update Huevo market snapshot (local collector)"
  if errorlevel 1 goto failed
  git push origin HEAD
  if errorlevel 1 (
    echo Push failed. Your new data remains committed locally; run git push origin HEAD later.
    pause
    exit /b 1
  )
  echo Snapshot pushed. GitHub Actions will publish the static dashboard to Cloudflare.
) else (
  echo No changes to cloudflare-site\data.json; nothing to push.
)
echo.
echo Finished. You can close this window.
pause
exit /b 0

:failed
echo.
echo Setup or Git operation failed. Read the error above.
pause
exit /b 1
