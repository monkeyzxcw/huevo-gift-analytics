import json, os, sys, tempfile, unittest
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import snapshot as sn


def lot(i, price=100, **kw):
    d = {"lot_id": str(i), "title": f"Лот {i}", "price": price, "rarity": "Редкий", "lot_url": f"https://huevo.su/market/lot/{i}"}
    d.update(kw)
    return d


def payload(lots, **kw):
    d = {"schema_version": 2, "generated_at": "2026-10-29T10:00:00+00:00", "collector": {"status": "ok"},
         "stats": {"n_total": len(lots)}, "lots": lots}
    d.update(kw)
    return d


class ValidateTests(unittest.TestCase):
    def test_good_payload_passes(self):
        self.assertEqual(sn.validate(payload([lot(1), lot(2, None)])), [])

    def test_structural_problems_are_reported(self):
        self.assertTrue(sn.validate([]))
        self.assertTrue(sn.validate(payload([lot(1), lot(1)])), "duplicate ids")
        self.assertTrue(sn.validate(payload([lot(1, price=-5)])), "negative price")
        self.assertTrue(sn.validate(payload([lot(1, price="12")])), "price as string")
        self.assertTrue(sn.validate(payload([{"lot_id": "1"}])), "missing fields")
        self.assertTrue(sn.validate(payload([], schema_version=99)))
        bad = payload([lot(1)]); bad["stats"]["n_total"] = 7
        self.assertTrue(sn.validate(bad))
        self.assertTrue(sn.validate(payload([lot(1)], snapshots="x")))

    def test_migrate_v1_keeps_data_and_adds_new_keys(self):
        v1 = {"schema_version": 1, "generated_at": "t", "collector": {"status": "ok"}, "lots": [lot(1)], "stats": {"n_total": 1}}
        m = sn.migrate(v1)
        self.assertEqual(m["schema_version"], sn.SCHEMA_VERSION)
        self.assertEqual(m["lots"], v1["lots"])
        self.assertEqual((m["snapshots"], m["categories"], m["changes"], m["sales"]), ([], [], None, None))
        self.assertEqual(sn.validate(m), [])
        self.assertEqual(v1["schema_version"], 1, "input must not be mutated")


class CompareTests(unittest.TestCase):
    def test_new_gone_and_price_changes(self):
        old = [lot(1, 100), lot(2, 200), lot(3, 300)]
        new = [lot(2, 150), lot(3, 300), lot(4, 500)]
        c = sn.compare(old, new)
        self.assertEqual(c["counts"], {"new": 1, "gone": 1, "price_up": 0, "price_down": 1, "unchanged": 1})
        self.assertEqual([x["lot_id"] for x in c["new"]], ["4"])
        self.assertEqual([x["lot_id"] for x in c["gone"]], ["1"])
        self.assertEqual(c["price_changes"][0]["pct"], -25.0)

    def test_missing_prices_do_not_count_as_changes(self):
        c = sn.compare([lot(1, None)], [lot(1, 50)])
        self.assertEqual(c["counts"]["price_up"] + c["counts"]["price_down"], 0)

    def test_details_are_bounded(self):
        c = sn.compare([], [lot(i, i + 1) for i in range(200)])
        self.assertEqual(c["counts"]["new"], 200)
        self.assertEqual(len(c["new"]), sn.MAX_DETAIL)
        self.assertEqual(c["new"][0]["lot_id"], "199", "most expensive first")


class AnalyticsTests(unittest.TestCase):
    def test_categories_handle_missing_prices_and_names(self):
        rows = [lot(1, 10, rarity="A"), lot(2, 30, rarity="A"), lot(3, None, rarity="B"), lot(4, 5, rarity=None)]
        cats = {c["name"]: c for c in sn.category_distribution(rows)}
        self.assertEqual(cats["A"]["median"], 20)
        self.assertEqual((cats["B"]["count"], cats["B"]["median"]), (1, None))
        self.assertIn("Не указано", cats)

    def test_top_expensive_ignores_unpriced(self):
        top = sn.top_expensive([lot(1, None), lot(2, 5), lot(3, 9)], n=2)
        self.assertEqual([t["lot_id"] for t in top], ["3", "2"])

    def test_duplicate_snapshot_protection(self):
        lots = [lot(1), lot(2)]
        summary = {"priced": 2, "min": 100, "max": 100, "avg": 100, "median": 100}
        e = sn.snapshot_entry("2026-10-29T10:00:00+00:00", lots, summary)
        self.assertTrue(sn.is_duplicate_snapshot([e], lots, now_iso="2026-10-29T10:05:00+00:00"))
        self.assertFalse(sn.is_duplicate_snapshot([e], lots, now_iso="2026-10-29T10:20:00+00:00"))
        self.assertFalse(sn.is_duplicate_snapshot([e], lots + [lot(3)], now_iso="2026-10-29T10:01:00+00:00"))
        self.assertFalse(sn.is_duplicate_snapshot([], lots, now_iso="2026-10-29T10:01:00+00:00"))


class SafeWriteTests(unittest.TestCase):
    def test_atomic_write_and_invalid_payload_leaves_file_untouched(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "data.json"
            sn.safe_write(out, payload([lot(1)]))
            good = out.read_text(encoding="utf-8")
            self.assertEqual(json.loads(good)["lots"][0]["lot_id"], "1")
            with self.assertRaises(sn.SnapshotError):
                sn.safe_write(out, payload([lot(1), lot(1)]))
            self.assertEqual(out.read_text(encoding="utf-8"), good)
            self.assertEqual([p.name for p in Path(tmp).iterdir()], ["data.json"], "no temp file left behind")


if __name__ == "__main__":
    unittest.main()
