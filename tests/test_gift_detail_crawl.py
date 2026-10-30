import logging
import os
import sys
import unittest
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from crawler import run_gift_detail_crawl
from tests.test_crawler import FakeBrowser, cfg


DETAIL_HTML = """<!doctype html><html><body><main class="mk-lot">
<h1>Золотая роза</h1><dl><dt>Модель</dt><dd>Royal</dd><dt>Фон</dt><dd>Emerald</dd></dl>
</main></body></html>"""


class GiftDetailCrawlTests(unittest.TestCase):
    def test_inspects_uncached_lot_and_returns_only_whitelisted_attributes(self):
        browser = FakeBrowser({1: (200, DETAIL_HTML, None)})
        lot = {"lot_id": "101", "title": "Золотая роза", "lot_url": "https://huevo.su/market/lot/101",
               "image_url": "https://huevo.su/rose.webp", "active": True}
        result = run_gift_detail_crawl(browser, cfg(), [lot], {}, logging.getLogger("detail-test"), limit=1)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["pages"], 1)
        self.assertEqual(result["details"]["101"]["attributes"], {"model": "Royal", "backdrop": "Emerald"})
        self.assertEqual(browser.gets, ["https://huevo.su/market/lot/101"])

    def test_recently_checked_detail_is_not_requested_again(self):
        browser = FakeBrowser({})
        checked = datetime.now(timezone.utc).isoformat()
        lot = {"lot_id": "101", "title": "Золотая роза", "lot_url": "https://huevo.su/market/lot/101"}
        old = {"101": {"gift_details": {"checked_at": checked, "attributes": {}}}}
        result = run_gift_detail_crawl(browser, cfg(), [lot], old, logging.getLogger("detail-test"), limit=1)
        self.assertEqual(result["pages"], 0)
        self.assertEqual(browser.gets, [])

    def test_empty_metadata_is_cached_without_guessing(self):
        browser = FakeBrowser({1: (200, "<html><body><main>Карточка подарка</main></body></html>", None)})
        lot = {"lot_id": "102", "title": "Звезда", "lot_url": "https://huevo.su/market/lot/102"}
        result = run_gift_detail_crawl(browser, cfg(), [lot], {}, logging.getLogger("detail-test"), limit=1)
        detail = result["details"]["102"]
        self.assertEqual(detail["attributes"], {})
        self.assertEqual(detail["status"], "no_recognised_attributes")
        self.assertEqual(detail["title"], "Звезда")

    def test_access_block_stops_pass_and_reports_retry_data(self):
        browser = FakeBrowser({1: (429, "<html><body>Too many requests</body></html>", "3600")})
        lots = [
            {"lot_id": str(i), "title": "Gift", "lot_url": f"https://huevo.su/market/lot/{i}"}
            for i in (101, 102, 103)
        ]
        result = run_gift_detail_crawl(browser, cfg(), lots, {}, logging.getLogger("detail-test"), limit=3)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["http_status"], 429)
        self.assertEqual(result["retry_after"], "3600")
        self.assertEqual(result["pages"], 1)
        self.assertEqual(len(browser.gets), 1)


if __name__ == "__main__":
    unittest.main()
