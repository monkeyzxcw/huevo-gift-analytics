import os, sys, unittest
from datetime import datetime, timedelta, timezone
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from scripts import collect_snapshot as cs


def ago(hours):
    return (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()


class RetentionTests(unittest.TestCase):
    def setUp(self): os.environ.pop("HUEVO_RETENTION_HOURS", None)
    def tearDown(self): os.environ.pop("HUEVO_RETENTION_HOURS", None)

    def test_default_is_30_days_and_env_is_clamped(self):
        self.assertEqual(cs.retention_hours(), 720)
        os.environ["HUEVO_RETENTION_HOURS"] = "0"; self.assertEqual(cs.retention_hours(), 1)
        os.environ["HUEVO_RETENTION_HOURS"] = "99999"; self.assertEqual(cs.retention_hours(), 720)
        os.environ["HUEVO_RETENTION_HOURS"] = "abc"; self.assertEqual(cs.retention_hours(), 720)

    def test_is_recent_drops_old_and_unparseable(self):
        cutoff = datetime.now(timezone.utc) - timedelta(hours=720)
        self.assertTrue(cs.is_recent(ago(1), cutoff))
        self.assertFalse(cs.is_recent(ago(800), cutoff))
        self.assertFalse(cs.is_recent("garbage", cutoff))
        self.assertFalse(cs.is_recent(None, cutoff))

    def test_price_history_is_trimmed_to_window_but_current_price_is_kept(self):
        row = {"lot_id": 1, "title": "t", "price": 500}
        old = {"1": {"history": [{"observed_at": ago(800), "price": 900}, {"observed_at": ago(5), "price": 700}]}}
        item = cs.snapshot_lot(row, old, ago(0))
        self.assertEqual([p["price"] for p in item["history"]], [700, 500])


if __name__ == "__main__":
    unittest.main()
