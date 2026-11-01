# D1 backup and recovery runbook

This runbook is for the production database configured in `wrangler.jsonc` as `huevo-live-data`. It does not replace Cloudflare's built-in Time Travel; it adds an operator-held SQL export for recovery and inspection.

## Safety rules

- Never commit SQL exports or database dumps to Git. They can contain user profiles, preferences, payment intents, and market state.
- Do not run restore commands as a routine troubleshooting step. A Time Travel restore overwrites the live database in place.
- Before any destructive restore, export the current database and record the current bookmark. Confirm the target timestamp/bookmark and get a second human review if other users rely on the app.
- Do not restore an old schema snapshot across newer migrations without checking the deployed Worker and migration history together.
- A SQL export is an offline backup, not proof that restore works. Test restoration against a separate non-production D1 database before relying on it.

## 1. Create an operator-held SQL export (Windows PowerShell)

Run from the repository root with Wrangler authenticated to the correct Cloudflare account:

```powershell
New-Item -ItemType Directory -Force .\backups | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
npx wrangler@4 d1 export huevo-live-data --remote --output ".\backups\huevo-live-data-$stamp.sql"
if ($LASTEXITCODE -ne 0) { throw "D1 export failed; do not proceed with maintenance." }
Get-Item ".\backups\huevo-live-data-$stamp.sql" | Select-Object FullName, Length, LastWriteTime
```

Keep the file in a private, access-controlled location. Confirm the export command completed successfully and the file is non-empty. Do not upload it to a public issue, paste its contents into chat, or add it to a commit.\n\nImmediately verify that the export can be restored locally into an isolated in-memory SQLite database:\n\n```powershell\npython .\scripts\verify_d1_backup.py ".\backups\huevo-live-data-$stamp.sql"\nif ($LASTEXITCODE -ne 0) { throw "Backup failed local restore verification; do not rely on it." }\n```\n\nThe verifier checks SQLite integrity, foreign keys, required current tables, and absence of retired Push tables, and prints row counts without exposing row contents. This is a local SQL restore check, not a Cloudflare D1 restore drill. For a full rehearsal, create a separate temporary D1 database, import a sanitized copy of the export, verify it there, and delete the temporary database only after recording the result.

Cloudflare reference: https://developers.cloudflare.com/d1/best-practices/import-export-data/

## 2. Record a recovery point before a risky change

```powershell
npx wrangler@4 d1 time-travel info huevo-live-data
```

Save the returned current bookmark and timestamp in the incident notes. For a specific earlier timestamp, query its bookmark before restoring:

```powershell
npx wrangler@4 d1 time-travel info huevo-live-data --timestamp "2026-11-01T12:00:00Z"
```

Use the actual incident timestamp, in UTC, rather than copying the example.

## 3. Restore only after confirming the target

A Time Travel restore is destructive and replaces the live database state. First create a fresh SQL export as in step 1. Then confirm the exact target bookmark or timestamp and run the command only during an intentional recovery window:

```powershell
# Prefer a recorded bookmark from the incident notes:
npx wrangler@4 d1 time-travel restore huevo-live-data --bookmark "<CONFIRMED_BOOKMARK>"
# Alternative when the exact UTC timestamp is known:
# npx wrangler@4 d1 time-travel restore huevo-live-data --timestamp "2026-11-01T12:00:00Z"
```

Do not execute both alternatives. Review Wrangler's confirmation prompt carefully. Preserve the bookmark returned by the restore operation so the action can be undone if needed. Cloudflare's current Time Travel documentation describes retention limits and restore behavior: https://developers.cloudflare.com/d1/reference/time-travel/

## 4. Post-restore verification

1. Check `/api/health` and confirm storage/schema readiness.
2. Check `/api/live/status` and record whether Live is enabled, fresh, and how old the last poll is.
3. Open `/data.json`; confirm the snapshot parses, `generated_at` is plausible, and the lot count is sensible.
4. Check the AMNYAM dashboard and signed huEVO profile flow.
5. Start HuevoDualScan and sign in manually in both visible Chrome windows. Never use exported Huevo cookies as a recovery workaround.
6. Confirm new data is written only after the operator's manual Huevo session is working.

If any check fails, stop further writes and preserve the incident logs and export for diagnosis. Do not repeatedly restore different timestamps against production as trial and error.
