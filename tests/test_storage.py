import os, sqlite3, sys, tempfile, threading, unittest
from datetime import datetime, timedelta, timezone
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from analytics import market_summary
from storage import Store


def lot(i, title="Rose", price=100, **kw):
    return {"lot_id": str(i), "title": title, "price": price, "status": "В продаже", "rarity": "Редкий", "serial": f"#{i}",
            "lot_url": f"https://huevo.su/market/lot/{i}", **kw}


class StoreCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "t.sqlite3")
        self.s = Store(self.path)
        self.s.migrate()

    def tearDown(self):
        self.tmp.cleanup()


class MigrationTests(StoreCase):
    def test_idempotent_and_versioned(self):
        self.s.migrate(); self.s.migrate()
        with self.s.connect() as c:
            self.assertEqual(c.execute("PRAGMA user_version").fetchone()[0], 3)

    def test_legacy_database_is_upgraded_without_data_loss(self):
        legacy = os.path.join(self.tmp.name, "legacy.sqlite3")
        con = sqlite3.connect(legacy)
        con.executescript("""CREATE TABLE lots(lot_id TEXT PRIMARY KEY, title TEXT, serial TEXT, rarity TEXT, price INTEGER,
            status TEXT, image_url TEXT, lot_url TEXT, first_seen TEXT, last_seen TEXT, active INTEGER DEFAULT 1);
            CREATE TABLE price_history(id INTEGER PRIMARY KEY AUTOINCREMENT, lot_id TEXT, price INTEGER, status TEXT, observed_at TEXT);
            INSERT INTO lots(lot_id,title,price,status,first_seen,last_seen,active) VALUES('5','Old',50,'x','t','t',1);
            INSERT INTO price_history(lot_id,price,status,observed_at) VALUES('5',50,'x','t');""")
        con.commit(); con.close()
        st = Store(legacy); st.migrate()
        items, total = st.catalog()
        self.assertEqual((total, items[0]["lot_id"]), (1, "5"))
        st.kv_set("a", "b")
        self.assertEqual(st.kv_get("a"), "b")
        self.assertEqual(st.counts()["history_rows"], 1)


class WriteTests(StoreCase):
    def test_upsert_new_then_unchanged_then_changed(self):
        r = self.s.upsert_many([lot(1), lot(2)])
        self.assertEqual((r["new"], r["changed"]), (2, 2))
        r = self.s.upsert_many([lot(1), lot(2)])
        self.assertEqual((r["new"], r["changed"]), (0, 0))        # no duplicate history rows
        r = self.s.upsert_many([lot(1, price=80)])
        self.assertEqual((r["new"], r["changed"]), (0, 1))
        with self.s.connect() as c:
            self.assertEqual(c.execute("SELECT COUNT(*) FROM price_history WHERE lot_id='1'").fetchone()[0], 2)
            self.assertEqual(c.execute("SELECT COUNT(*) FROM lots").fetchone()[0], 2)

    def test_first_seen_preserved_last_seen_updated(self):
        self.s.upsert_many([lot(1)], now="2026-01-01T00:00:00+00:00")
        self.s.upsert_many([lot(1)], now="2026-01-02T00:00:00+00:00")
        with self.s.connect() as c:
            r = c.execute("SELECT first_seen,last_seen FROM lots").fetchone()
        self.assertEqual((r[0], r[1]), ("2026-01-01T00:00:00+00:00", "2026-01-02T00:00:00+00:00"))

    def test_price_lost_is_recorded_as_change(self):
        self.s.upsert_many([lot(1)])
        r = self.s.upsert_many([lot(1, price=None)])
        self.assertEqual(r["changed"], 1)

    def test_deactivate_only_unseen_and_reactivates(self):
        self.s.upsert_many([lot(1), lot(2)], now="2026-01-01T00:00:00+00:00")
        self.s.upsert_many([lot(1)], now="2026-01-02T00:00:00+00:00")
        self.assertEqual(self.s.deactivate_unseen("2026-01-02T00:00:00+00:00"), 1)
        self.assertEqual(self.s.counts()["active_total"], 1)
        self.s.upsert_many([lot(2)], now="2026-01-03T00:00:00+00:00")     # comes back
        self.assertEqual(self.s.counts()["active_total"], 2)

    def test_snapshot_empty_and_filled(self):
        self.s.record_snapshot("t", market_summary)
        self.s.upsert_many([lot(1, price=10), lot(2, price=30), lot(3, price=None)])
        self.s.record_snapshot("t", market_summary)
        with self.s.connect() as c:
            rows = c.execute("SELECT active_lots,priced,median_price FROM market_snapshots ORDER BY id").fetchall()
        self.assertEqual([tuple(r) for r in rows], [(0, 0, None), (3, 2, 20)])


class ReadTests(StoreCase):
    def setUp(self):
        super().setUp()
        rows = [lot(i, title=["Rose", "Star", "100%_Gift"][i % 3], price=10 * (i + 1), rarity=["Редкий", "Обычный"][i % 2],
                    status=["В продаже", "Скоро"][i % 2]) for i in range(30)]
        self.s.upsert_many(rows, now="2026-01-01T00:00:00+00:00")

    def test_pagination_total_and_stable_order(self):
        a, total = self.s.catalog(limit=10, offset=0)
        b, _ = self.s.catalog(limit=10, offset=10)
        self.assertEqual(total, 30)
        self.assertEqual(len({x["lot_id"] for x in a + b}), 20)
        self.assertEqual([x["price"] for x in a], sorted(x["price"] for x in a))
        self.assertEqual(len(self.s.catalog(limit=9999)[0]), 30)         # capped at 200, not unbounded
        self.assertEqual(len(self.s.catalog(limit=0)[0]), 1)

    def test_filters(self):
        items, total = self.s.catalog(rarity="Редкий", status="В продаже", min_price=50, max_price=200)
        self.assertTrue(all(x["rarity"] == "Редкий" and x["status"] == "В продаже" and 50 <= x["price"] <= 200 for x in items))
        self.assertEqual(total, len(items))

    def test_search_title_id_serial_and_wildcards_are_literal(self):
        self.assertEqual(self.s.catalog(q="star")[1], 10)
        self.assertEqual(self.s.catalog(q="#7")[1], 1)
        self.assertEqual(self.s.catalog(q="100%_")[1], 10)       # literal "100%_" matches only that title
        self.assertEqual(self.s.catalog(q="%")[1], 10)           # '%' is not "match everything"
        self.assertEqual(self.s.catalog(q="' OR 1=1 --")[1], 0)  # injection attempt is just text

    def test_unknown_sort_falls_back_and_all_sorts_work(self):
        for sort in ("price", "price_desc", "title", "recent", "new", "nonsense; DROP TABLE lots"):
            self.assertEqual(len(self.s.catalog(sort=sort, limit=5)[0]), 5)
        self.assertEqual(self.s.counts()["active_total"], 30)

    def test_empty_database(self):
        e = Store(os.path.join(self.tmp.name, "e.sqlite3")); e.migrate()
        self.assertEqual(e.catalog(), ([], 0))
        self.assertIsNone(e.latest_lot())
        self.assertEqual(e.drops(), [])
        self.assertEqual(e.active_prices(), [])
        self.assertEqual(e.period_change(7)["change_pct"], None)
        self.assertEqual(e.facets(), {"statuses": [], "rarities": []})

    def test_facets_and_latest(self):
        self.assertEqual(self.s.facets()["rarities"], ["Обычный", "Редкий"])
        self.assertEqual(self.s.latest_lot()["lot_id"], "29")           # same first_seen -> highest id


class HistoryTests(StoreCase):
    def test_drops_and_period_change(self):
        self.s.upsert_many([lot(1, price=100), lot(2, price=100)], now="2026-01-01T00:00:00+00:00")
        self.s.upsert_many([lot(1, price=70), lot(2, price=120)], now="2026-01-05T00:00:00+00:00")
        d = self.s.drops()
        self.assertEqual([x["lot_id"] for x in d], ["1"])
        self.assertEqual(d[0]["drop_pct"], 30.0)
        self.assertEqual(self.s.drops(days=100000)[0]["lot_id"], "1")
        self.assertEqual(self.s.drops(days=1), [])   # the change is older than the window

    def test_period_change_needs_two_snapshots(self):
        self.s.upsert_many([lot(1, price=100)])
        self.s.record_snapshot("t", market_summary)
        self.assertIsNone(self.s.period_change(7)["change_pct"])
        self.s.upsert_many([lot(1, price=150)])
        self.s.record_snapshot("t", market_summary)
        self.assertEqual(self.s.period_change(7)["change_pct"], 50.0)


class SystemTests(StoreCase):
    def test_backup_is_consistent_copy(self):
        self.s.upsert_many([lot(i) for i in range(5)])
        dest = os.path.join(self.tmp.name, "b.sqlite3")
        self.s.backup(dest)
        copy = Store(dest)
        self.assertEqual(copy.counts()["active_total"], 5)

    def test_kv_roundtrip_and_delete(self):
        self.assertIsNone(self.s.kv_get("x"))
        self.s.kv_set("x", "1"); self.s.kv_set("x", "2")
        self.assertEqual(self.s.kv_get("x"), "2")
        self.s.kv_set("x", None)
        self.assertEqual(self.s.kv_get("x", "d"), "d")

    def test_concurrent_writers_and_readers(self):
        errors = []
        def writer(n):
            try:
                for i in range(40):
                    self.s.upsert_many([lot(n * 1000 + i, price=i + 1)])
            except Exception as exc:
                errors.append(exc)
        def reader():
            try:
                for _ in range(40):
                    self.s.catalog(limit=20); self.s.counts()
            except Exception as exc:
                errors.append(exc)
        ts = [threading.Thread(target=writer, args=(n,)) for n in range(4)] + [threading.Thread(target=reader) for _ in range(2)]
        [t.start() for t in ts]; [t.join() for t in ts]
        self.assertEqual(errors, [])
        self.assertEqual(self.s.counts()["active_total"], 160)

    def test_failed_transaction_rolls_back(self):
        with self.assertRaises(RuntimeError):
            with self.s.connect() as c:
                self.s.upsert_lot(c, lot(1), "t")
                raise RuntimeError("boom")
        self.assertEqual(self.s.counts()["active_total"], 0)


    def test_lots_by_ids_includes_inactive_and_ignores_unknown(self):
        self.s.upsert_many([lot(1), lot(2)], now="2026-01-01T00:00:00+00:00")
        self.s.deactivate_unseen("2026-02-01T00:00:00+00:00")
        rows = self.s.lots_by_ids(["1", "999"])
        self.assertEqual([(r["lot_id"], r["active"]) for r in rows], [("1", 0)])
        self.assertEqual(self.s.lots_by_ids([]), [])


    def test_sales_are_idempotent_and_store_no_names(self):
        row = {"sale_key": "k1", "lot_id": "5", "title": "Жидкость #4", "price": 10, "time_raw": "01:22", "sold_at": None}
        self.assertEqual(self.s.upsert_sales([row, dict(row, sale_key="k2", price=None)]), 2)
        self.assertEqual(self.s.upsert_sales([row]), 0, "re-importing the same page must not double count")
        rows = self.s.sales()
        self.assertEqual(len(rows), 2)
        self.assertEqual({r["price"] for r in rows}, {10, None}, "unknown price stays NULL, not 0")
        with self.s.connect() as c:
            cols = [r[1] for r in c.execute("PRAGMA table_info(sales)")]
        self.assertFalse({"seller", "buyer", "username", "name"} & set(cols))

    def test_migration_from_v2_adds_sales_table(self):
        import sqlite3
        path = os.path.join(self.tmp.name, "old.db")
        con = sqlite3.connect(path); con.execute("CREATE TABLE lots(lot_id TEXT PRIMARY KEY, title TEXT, serial TEXT, rarity TEXT, price INTEGER, status TEXT, image_url TEXT, lot_url TEXT, first_seen TEXT, last_seen TEXT, active INTEGER)")
        con.execute("PRAGMA user_version=2"); con.commit(); con.close()
        st = Store(path); st.migrate()
        self.assertEqual(st.upsert_sales([{"sale_key": "a", "lot_id": "1"}]), 1)


if __name__ == "__main__":
    unittest.main()
