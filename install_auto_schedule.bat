@echo off
setlocal
echo Creating a Windows Task Scheduler job for the current Windows user.
echo The task runs every 6 hours and only while you are signed in.
echo Huevo cookies stay in the local Chrome profile; they are not copied to GitHub.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
 "$ErrorActionPreference = 'Stop'; $script = Join-Path '%~dp0' 'run_scheduled_collector.bat'; $start = (Get-Date).AddMinutes(5); $trigger = New-ScheduledTaskTrigger -Once -At $start -RepetitionInterval (New-TimeSpan -Hours 6) -RepetitionDuration (New-TimeSpan -Days 3650); $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c ""' + $script + '""'); $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited; $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2); Register-ScheduledTask -TaskName 'Huevo Gift Analytics Collector' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Collect Huevo market data using the local Chrome profile; session remains on this PC.' -Force | Out-Null; Write-Host 'Task created. First run is scheduled in about 5 minutes, then every 6 hours.'"

if errorlevel 1 (
  echo.
  echo Task creation failed. You can still use run_scheduled_collector.bat manually.
  pause
  exit /b 1
)
echo.
echo Done. Keep the PC on and stay signed in to Windows for scheduled runs.
echo Log file: logs\scheduled-collector.log
pause
exit /b 0
