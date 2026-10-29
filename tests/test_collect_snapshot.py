import json, os, sys, tempfile, unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import collect_snapshot as cs
from crawler import CrawlResult


def lot(i, price=100, title="Роза"):
    return {"lot_id": str(i), "title": title, "rarity": "Редкий", "price": price, "status": "В продаже",
            "image_url": "", "lot_url": f"https://huevo.su/market/lot/{i}"}


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.patches = [patch.object(cs, "OUT", base / "data.json"), patch.object(cs, "STATE", base / "state.json"),
                        patch.object(cs, "make_browser", lambda **k: type("B", (), {"quit": lambda s: None})()),
                        patch.dict(os.environ, {"CRAWL_DELAY": "2"}, clear=False)]
        for p in self.patches: p.start()
        self.calls = 0

    def tearDown(self):
        for p in self.patches: p.stop()
        self.tmp.cleanup()

    def crawl_with(self, rows, status="ok", reached_end=True, **kw):
        def fake(browser, store, cfg, log, **_):
            self.calls += 1
            store.upsert_many(rows)
            return CrawlResult(status, "msg", pages=2, unique_lots=len(rows), reached_end=reached_end, **kw)
        return patch.object(cs, "run_crawl", fake)

    def run_main(self, rows, **kw):
        with self.crawl_with(rows, **kw):
            return cs.main(["--local-profile"])

    def data(self):
        return json.loads(cs.OUT.read_text(encoding="utf-8"))

    def test_successful_run_writes_snapshot_and_carries_first_seen(self):
        self.assertEqual(self.run_main([lot(1), lot(2, 120)]), 0)
        first = {l["lot_id"]: l["first_seen"] for l in self.data()["lots"]}
        self.assertEqual(self.run_main([lot(1), lot(2, 120), lot(3, 90)]), 0)
        second = {l["lot_id"]: l["first_seen"] for l in self.data()["lots"]}
        self.assertEqual(second["1"], first["1"], "first_seen must survive across runs")
        self.assertGreater(second["3"], first["1"], "a new lot is first seen later than the old ones")

    def test_blocked_run_keeps_last_good_data_and_sets_persistent_cooldown(self):
        self.run_main([lot(1), lot(2)])
        good = self.data()["lots"]
        self.assertEqual(self.run_main([], status="blocked", reached_end=False, http_status=418, retry_after=10 * 3600), 2)
        d = self.data()
        self.assertEqual(d["lots"], good, "a block must not replace the last good lots")
        self.assertEqual(d["collector"]["status"], "blocked")
        until = datetime.fromisoformat(json.loads(cs.STATE.read_text())["blocked_until"])
        self.assertGreater((until - datetime.now(timezone.utc)).total_seconds(), 9.9 * 3600, "Retry-After longer than the default is respected")

    def test_cooldown_survives_git_restore_of_data_json_and_blocks_next_run(self):
        self.run_main([lot(1)])
        self.run_main([], status="blocked", reached_end=False, http_status=429)
        cs.OUT.write_text(json.dumps({}), encoding="utf-8")        # what `git restore` of a failed status can do
        before = self.calls
        self.assertEqual(self.run_main([lot(5)]), 3)
        self.assertEqual(self.calls, before, "no request to Huevo while the cooldown is active")

    def test_successful_complete_pass_clears_cooldown(self):
        cs.save_state({"blocked_until": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()})
        self.assertEqual(self.run_main([lot(1)]), 0)
        self.assertEqual(json.loads(cs.STATE.read_text()), {})

    def test_empty_or_partial_results_never_overwrite_good_snapshot(self):
        self.run_main([lot(i) for i in range(1, 41)])
        good = self.data()["lots"]
        self.assertEqual(self.run_main([], status="no_cards", reached_end=False), 2)
        self.assertEqual(self.run_main([lot(1)], reached_end=False), 2)
        self.assertEqual(self.data()["lots"], good)
        # a "complete" pass that sees under half of the previous active lots is distrusted too
        self.assertEqual(self.run_main([lot(1), lot(2)]), 2)
        d = self.data()
        self.assertEqual((d["lots"], d["collector"]["status"]), (good, "incomplete"))

    def test_disappeared_lots_are_labelled_not_sold(self):
        self.run_main([lot(1), lot(2)])
        self.run_main([lot(1)])
        gone = self.data()["gone_lots"]
        self.assertEqual([g["lot_id"] for g in gone], ["2"])
        self.assertNotIn("продан", gone[0]["status"].lower())

    def test_output_has_no_cookie_like_or_secret_fields(self):
        self.run_main([lot(1)])
        text = cs.OUT.read_text(encoding="utf-8").lower()
        for word in ("cookie", "authorization", "token", "hchk", "session"):
            self.assertNotIn(word, text)


if __name__ == "__main__":
    unittest.main()
