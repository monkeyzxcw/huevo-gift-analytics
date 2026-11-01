#!/usr/bin/env python3
"""Safely validate a private Cloudflare D1 SQL export by restoring it in memory.

This is a local SQLite compatibility/integrity check. It does not replace a
restore drill against a separate Cloudflare D1 database.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

REQUIRED_TABLES = {
    "full_snapshot",
    "live_page_state",
    "live_price_history",
    "support_payments",
    "user_accounts",
    "user_sessions",
    "user_profiles",
    "auth_rate_limits",
    "owner_presence",
    "community_messages",
}
RETIRED_TABLES = {"push_vapid_keys", "push_subscriptions", "push_alert_state"}


def verify_sql_dump(sql_text: str) -> dict[str, object]:
    if not sql_text.strip():
        raise ValueError("SQL export is empty")

    connection = sqlite3.connect(":memory:")
    try:
        # D1 exports may insert rows before referenced tables; defer FK checks
        # during import, then enable and run an explicit check after restoration.
        connection.executescript("PRAGMA foreign_keys = OFF;\n" + sql_text)
        connection.execute("PRAGMA foreign_keys = ON")
        integrity = connection.execute("PRAGMA integrity_check").fetchone()
        if not integrity or integrity[0] != "ok":
            raise ValueError(f"SQLite integrity_check failed: {integrity!r}")

        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        missing = sorted(REQUIRED_TABLES - tables)
        if missing:
            raise ValueError("backup is missing required tables: " + ", ".join(missing))

        retired = sorted(RETIRED_TABLES & tables)
        if retired:
            raise ValueError("backup contains retired Push tables: " + ", ".join(retired))

        foreign_key_errors = connection.execute("PRAGMA foreign_key_check").fetchall()
        if foreign_key_errors:
            raise ValueError(
                f"backup has {len(foreign_key_errors)} foreign-key violation(s)"
            )

        row_counts = {
            table: int(connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])
            for table in sorted(REQUIRED_TABLES)
        }
        return {
            "ok": True,
            "integrity": "ok",
            "tables": len(tables),
            "row_counts": row_counts,
        }
    except sqlite3.Error as error:
        raise ValueError(f"SQL export could not be restored: {error}") from error
    finally:
        connection.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("sql_file", type=Path, help="Private Wrangler D1 SQL export")
    args = parser.parse_args()

    if not args.sql_file.is_file():
        print(f"Backup file not found: {args.sql_file}", file=sys.stderr)
        return 2
    try:
        result = verify_sql_dump(args.sql_file.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError) as error:
        print(f"BACKUP VERIFICATION FAILED: {error}", file=sys.stderr)
        return 1

    print(json.dumps(result, ensure_ascii=False, indent=2))
    print("Local SQL restore check passed. A separate Cloudflare D1 restore drill is still required.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
