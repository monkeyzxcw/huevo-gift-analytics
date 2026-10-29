import os, sys, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT); sys.path.insert(0, os.path.join(ROOT, "scripts"))
import collect_history as ch
import collect_snapshot as snap
from crawler import CrawlResult


class HistoryScriptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); base = Path(self.tmp.name)
        self.ps = [patch.object(ch, "DB", base / "h.db"), patch.object(snap, "STATE", base / "s.json"),
                   patch.object(snap, "make_browser", lambda **k: type("B", (), {"quit": lambda s: None})())]
        [p.start() for p in self.ps]
    def tearDown(self):
        [p.stop() for p in self.ps]; self.tmp.cleanup()

    def test_requires_local_profile_flag(self):
        with self.assertRaises(SystemExit):
            ch.main([])

    def test_block_sets_shared_cooldown_and_next_run_sends_nothing(self):
        calls = []
        def blocked(*a, **k):
            calls.append(1); return CrawlResult("blocked", "x", http_status=418, retry_after=9 * 3600)
        with patch.object(ch, "run_history_crawl", blocked):
            self.assertEqual(ch.main(["--local-profile"]), 2)
            self.assertEqual(ch.main(["--local-profile"]), 3)
        self.assertEqual(len(calls), 1)
        self.assertIsNotNone(snap.active_cooldown(snap.load_state()))

    def test_page_count_is_capped(self):
        seen = {}
        def ok(browser, store, cfg, log, max_pages=0, **k):
            seen["pages"] = max_pages; return CrawlResult("ok", "ok", pages=1)
        with patch.object(ch, "run_history_crawl", ok):
            ch.main(["--local-profile", "--pages", "9999"])
        self.assertEqual(seen["pages"], 20)


if __name__ == "__main__":
    unittest.main()
