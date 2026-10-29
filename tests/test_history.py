import os, sys, tempfile, unittest, logging
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from history_parser import parse_history, parse_price
from analytics import sales_summary, sales_by_title
from crawler import CrawlConfig, run_history_crawl
from storage import Store
from tests.test_crawler import FakeBrowser, cfg

FIX = os.path.join(ROOT, "tests", "fixtures")
read = lambda n: open(os.path.join(FIX, n), encoding="utf-8").read()
log = logging.getLogger("h")


class ParserTests(unittest.TestCase):
    def setUp(self):
        self.r = parse_history(read("market_history_ok.html"))
        self.by = {x["lot_id"]: x for x in self.r["rows"]}

    def test_rows_pager_and_skips(self):
        self.assertEqual(self.r["total_pages"], 652)
        self.assertTrue(self.r["table_found"])
        self.assertEqual(sorted(self.by), ["9001", "9002", "9003", "9004", "9005", "9006"])
        self.assertEqual(self.r["skipped"], 1, "the row without a lot link is counted, not guessed")

    def test_exact_duplicate_rows_are_not_double_counted(self):
        self.assertEqual(sum(1 for x in self.r["rows"] if x["lot_id"] == "9004"), 1)

    def test_prices_unknown_is_none_not_zero(self):
        self.assertEqual((self.by["9001"]["price"], self.by["9002"]["price"], self.by["9003"]["price"]), (444444, 700000, 1))
        self.assertIsNone(self.by["9005"]["price"])

    def test_time_only_never_becomes_a_date(self):
        self.assertEqual(self.by["9001"]["time_raw"], "01:22")
        self.assertIsNone(self.by["9001"]["sold_at"])
        self.assertIsNone(self.by["9004"]["sold_at"])

    def test_explicit_timestamps_are_used_only_when_unambiguous(self):
        self.assertEqual(self.by["9002"]["sold_at"], "2026-10-28T21:19:00+00:00")
        self.assertTrue(self.by["9003"]["sold_at"].startswith("2026-10-"))          # unix seconds
        self.assertIsNone(self.by["9006"]["sold_at"], "a naive datetime has no known timezone")

    def test_no_person_names_in_output(self):
        text = repr(self.r)
        for name in ("seller_one", "buyer_one", "seller_three", "buyer_four"):
            self.assertNotIn(name, text)

    def test_keys_are_stable_and_distinguish_participants(self):
        again = parse_history(read("market_history_ok.html"))
        self.assertEqual([x["sale_key"] for x in again["rows"]], [x["sale_key"] for x in self.r["rows"]])
        a = parse_history('<table class="mk-table"><tr><td><a href="/market/lot/1">x</a></td><td>1</td><td>a</td><td>b</td><td>01:00</td></tr></table>')
        b = parse_history('<table class="mk-table"><tr><td><a href="/market/lot/1">x</a></td><td>1</td><td>a</td><td>c</td><td>01:00</td></tr></table>')
        self.assertNotEqual(a["rows"][0]["sale_key"], b["rows"][0]["sale_key"])

    def test_missing_table_empty_table_and_garbage(self):
        self.assertFalse(parse_history("<html><body>Вход</body></html>")["table_found"])
        e = parse_history(read("market_history_empty.html"))
        self.assertEqual((e["rows"], e["table_found"], e["total_pages"]), ([], True, 2))
        for junk in ("", None, "<table><tr><td>", "\x00<<>>"):
            self.assertEqual(parse_history(junk)["rows"], [])

    def test_headerless_table_uses_documented_column_order(self):
        r = parse_history('<table><tr><td><a href="/market/lot/7">x</a></td><td>50</td><td>s</td><td>b</td><td>02:00</td></tr></table>')
        self.assertEqual((r["rows"][0]["lot_id"], r["rows"][0]["price"]), ("7", 50))

    def test_reordered_columns_follow_header_names(self):
        r = parse_history('<table><thead><tr><th>Дата</th><th>Покупатель</th><th>Цена</th><th>Лот</th></tr></thead><tbody><tr><td>03:00</td><td>b</td><td>77</td><td><a href="/market/lot/8">x</a></td></tr></tbody></table>')
        self.assertEqual((r["rows"][0]["lot_id"], r["rows"][0]["price"], r["rows"][0]["time_raw"]), ("8", 77, "03:00"))

    def test_parse_price_edges(self):
        self.assertEqual(parse_price("1 250 ◉"), 1250)
        self.assertIsNone(parse_price("—"))
        self.assertIsNone(parse_price(None))
        self.assertIsNone(parse_price("9" * 30))


class SalesAnalyticsTests(unittest.TestCase):
    def test_summary_only_counts_known_prices(self):
        s = sales_summary([10, None, 20, 30, 0, "x"])
        self.assertEqual((s["count"], s["median"], s["unknown"]), (3, 20, 3))
        self.assertTrue(s["note"])

    def test_summary_empty_is_not_zero(self):
        s = sales_summary([])
        self.assertEqual((s["count"], s["median"], s["enough_data"]), (0, None, False))

    def test_by_title_ignores_serial_and_needs_three_sales(self):
        rows = [{"title": f"Звезда #{i}", "price": p} for i, p in enumerate([10, 20, 30, 1000])] + [{"title": "Роза #1", "price": 5}]
        g = sales_by_title(rows)
        self.assertEqual([x["title"] for x in g], ["звезда"])
        self.assertEqual((g[0]["count"], g[0]["median"]), (4, 25))


def page(n):
    return {1: ("ok", 200), 2: ("ok", 200)}[n]


class HistoryCrawlTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(os.path.join(self.tmp.name, "h.db")); self.store.migrate()
    def tearDown(self): self.tmp.cleanup()

    def hist_html(self, ids, total=3):
        rows = "".join(f'<tr><td><a href="/market/lot/{i}">Лот {i}</a></td><td>{i}</td><td>s</td><td>b</td><td>01:{i % 60:02d}</td></tr>' for i in ids)
        return f'<html><head><title>История</title></head><body><table class="mk-table"><thead><tr><th>Лот</th><th>Цена</th><th>Продавец</th><th>Покупатель</th><th>Дата</th></tr></thead><tbody>{rows}</tbody></table><div>Страница 1 из {total}</div></body></html>'

    def fake(self, pages):
        class B(FakeBrowser):
            def get(s, url):
                s.gets.append(url)
                n = int(url.split("page=")[1]) if "page=" in url else 1
                status, html, ra = pages.get(n, (200, "<html><body>Пусто</body></html>", None))
                s.current_url, s.page_source, s.title = url, html, "История"
                from tests.test_crawler import perf
                s._log = [perf(url, status, ra)]
        return B({})

    def test_collects_requested_pages_and_is_idempotent(self):
        b = self.fake({1: (200, self.hist_html([1, 2, 3]), None), 2: (200, self.hist_html([4, 5]), None)})
        res = run_history_crawl(b, self.store, cfg(), log, max_pages=2)
        self.assertEqual((res.status, res.unique_lots, res.new_lots, res.pages), ("ok", 5, 5, 2))
        self.assertEqual(b.gets, ["https://huevo.su/market/history", "https://huevo.su/market/history?page=2"])
        self.assertFalse(res.reached_end, "stopped by the page limit, not by the end of history")
        res2 = run_history_crawl(self.fake({1: (200, self.hist_html([1, 2, 3]), None)}), self.store, cfg(), log, max_pages=1)
        self.assertEqual(res2.new_lots, 0)
        self.assertEqual(len(self.store.sales()), 5)

    def test_stops_on_block_and_keeps_what_was_saved(self):
        b = self.fake({1: (200, self.hist_html([1, 2]), None), 2: (429, "<html><body>Too Many Requests</body></html>", "90")})
        res = run_history_crawl(b, self.store, cfg(), log, max_pages=5)
        self.assertEqual((res.status, res.http_status, res.retry_after), ("blocked", 429, 90))
        self.assertEqual(len(b.gets), 2)
        self.assertEqual(len(self.store.sales()), 2)

    def test_login_page_or_missing_table_is_not_an_empty_history(self):
        res = run_history_crawl(self.fake({1: (200, "<html><body>Вход</body></html>", None)}), self.store, cfg(), log, max_pages=3)
        self.assertNotEqual(res.status, "ok")
        self.assertEqual(self.store.sales(), [])

    def test_last_page_reached_is_reported(self):
        b = self.fake({1: (200, self.hist_html([1]), None), 2: (200, self.hist_html([2], total=2), None)})
        res = run_history_crawl(b, self.store, cfg(), log, max_pages=10)
        self.assertEqual((res.status, res.reached_end, res.pages), ("ok", True, 2))


if __name__ == "__main__":
    unittest.main()
