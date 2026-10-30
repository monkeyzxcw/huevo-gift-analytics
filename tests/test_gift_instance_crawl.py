import logging
import os
import sys
import unittest
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from crawler import run_gift_instance_crawl
from tests.test_crawler import FakeBrowser, cfg

FIXTURE = os.path.join(ROOT, "tests", "fixtures", "gift_instance_ok.html")


class GiftInstanceCrawlTests(unittest.TestCase):
    def html(self):
        with open(FIXTURE, encoding="utf-8") as handle:
            return handle.read()

    def candidate(self, lot_id="101", gift_id="18336", **extra):
        return {"lot_id": lot_id, "title": "Адидас-Тян Зеленая",
                "lot_url": f"https://huevo.su/market/lot/{lot_id}",
                "gift_details": {"gift_id": gift_id, "gift_url": f"https://huevo.su/gift/{gift_id}"},
                **extra}

    def test_duplicate_market_rows_fetch_one_unique_instance_page(self):
        browser = FakeBrowser({1: (200, self.html(), None)})
        result = run_gift_instance_crawl(browser, cfg(),
            [self.candidate("101"), self.candidate("102")],
            logging.getLogger("instance-test"), limit=4)
        self.assertEqual((result["status"], result["pages"]), ("ok", 1))
        self.assertEqual(browser.gets, ["https://huevo.su/gift/18336"])
        self.assertEqual(result["instances"]["18336"]["drop_price"], 5555)

    def test_fresh_history_is_cached_unless_force_check_is_set(self):
        cached = {"history_found": True, "checked_at": datetime.now(timezone.utc).isoformat(), "history": []}
        browser = FakeBrowser({})
        result = run_gift_instance_crawl(browser, cfg(),
            [self.candidate(gift_instance=cached)], logging.getLogger("instance-test"), limit=2)
        self.assertEqual((result["pages"], browser.gets), (0, []))
        browser = FakeBrowser({1: (200, self.html(), None)})
        result = run_gift_instance_crawl(browser, cfg(),
            [self.candidate(gift_instance=cached, _force_history_check=True)],
            logging.getLogger("instance-test"), limit=2)
        self.assertEqual((result["pages"], len(browser.gets)), (1, 1))

    def test_missing_instance_page_is_not_cached_as_empty_history(self):
        browser = FakeBrowser({1: (404, "<html><body>Not found</body></html>", None)})
        result = run_gift_instance_crawl(
            browser, cfg(), [self.candidate()],
            logging.getLogger("instance-test"), limit=1)
        self.assertEqual(result["status"], "not_found")
        self.assertEqual(result["pages"], 1)
        self.assertEqual(len(browser.gets), 1)
        self.assertEqual(result["instances"], {})

    def test_block_stops_the_queue(self):
        browser = FakeBrowser({1: (429, "<html><body>Too many requests</body></html>", "120")})
        result = run_gift_instance_crawl(browser, cfg(),
            [self.candidate(str(i), "18336") for i in (101, 102, 103)],
            logging.getLogger("instance-test"), limit=3)
        self.assertEqual((result["status"], result["http_status"], result["pages"]), ("blocked", 429, 1))
        self.assertEqual(len(browser.gets), 1)


if __name__ == "__main__":
    unittest.main()
