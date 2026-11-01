import sqlite3
import unittest
from pathlib import Path

from scripts.verify_d1_backup import verify_sql_dump

ROOT = Path(__file__).resolve().parents[1]


class D1BackupRestoreTests(unittest.TestCase):
    def build_export(self):
        connection = sqlite3.connect(":memory:")
        connection.execute("PRAGMA foreign_keys = ON")
        for migration in sorted((ROOT / "migrations").glob("*.sql")):
            connection.executescript(migration.read_text(encoding="utf-8"))

        connection.execute(
            "INSERT INTO user_accounts "
            "(user_id, hu_user_id, hu_username, display_name, avatar_url, app_id, mode, created_at, updated_at, last_login_at) "
            "VALUES ('internal-a', '1001', 'alice', 'Alice', '', 'app', 'live', '2026-11-01', '2026-11-01', '2026-11-01')"
        )
        connection.execute(
            "INSERT INTO user_accounts "
            "(user_id, hu_user_id, hu_username, display_name, avatar_url, app_id, mode, created_at, updated_at, last_login_at) "
            "VALUES ('internal-b', '1002', 'bob', 'Bob', '', 'app', 'live', '2026-11-01', '2026-11-01', '2026-11-01')"
        )
        connection.execute(
            "INSERT INTO user_profiles (user_id, profile_json, updated_at) VALUES ('internal-a', '{\"favorites\":[\"11\"]}', '2026-11-01')"
        )
        connection.execute(
            "INSERT INTO user_profiles (user_id, profile_json, updated_at) VALUES ('internal-b', '{\"favorites\":[\"22\"]}', '2026-11-01')"
        )
        connection.execute(
            "INSERT INTO community_messages (user_id, display_name, username, avatar_url, message, created_at) "
            "VALUES ('internal-a', 'Alice', 'alice', '', 'backup test', '2026-11-01')"
        )
        connection.commit()
        dump = "\n".join(connection.iterdump())
        connection.close()
        return dump

    def test_migrated_database_export_restores_with_user_data_and_integrity(self):
        result = verify_sql_dump(self.build_export())
        self.assertTrue(result["ok"])
        self.assertEqual(result["integrity"], "ok")
        self.assertEqual(result["row_counts"]["user_accounts"], 2)
        self.assertEqual(result["row_counts"]["user_profiles"], 2)
        self.assertEqual(result["row_counts"]["community_messages"], 1)

    def test_rejects_truncated_or_invalid_export(self):
        with self.assertRaisesRegex(ValueError, "could not be restored"):
            verify_sql_dump("CREATE TABLE broken (id INTEGER;")

    def test_rejects_export_missing_required_tables(self):
        with self.assertRaisesRegex(ValueError, "missing required tables"):
            verify_sql_dump("CREATE TABLE full_snapshot (id INTEGER);")

    def test_rejects_retired_push_tables(self):
        sql = self.build_export() + "\nCREATE TABLE push_subscriptions (endpoint TEXT);"
        with self.assertRaisesRegex(ValueError, "retired Push tables"):
            verify_sql_dump(sql)


if __name__ == "__main__":
    unittest.main()
