import json, os, sys, tempfile, unittest, logging
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from crawler import CrawlConfig, run_crawl
from storage import Store

log = logging.getLogger("t")


def page_html(ids):
    cards = "".join(f'<a class="mk-gcard" href="/market/lot/{i}"><div class="mk-gtitle">Лот {i}</div><div class="mk-price">{100 + i}</div></a>' for i in ids)
    return f"<html><head><title>Маркет</title></head><body><div>{cards or 'Каталог пуст'}</div></body></html>"


def perf(url, status, retry_after=None):
    headers = {"Retry-After": retry_after} if retry_after else {}
    msg = {"message": {"method": "Network.responseReceived", "params": {"type": "Document", "response": {"url": url, "status": status, "headers": headers}}}}
    return {"message": json.dumps(msg)}


class FakeElement:
    def __init__(self, text=""): self.text = text
    def is_displayed(self): return False


class FakeBrowser:
    """Serves scripted pages: {page_number: (status, html, retry_after)} for /market/gifts?page=N."""
    def __init__(self, pages, base="https://huevo.su", fail_on=None):
        self.pages, self.base, self.fail_on = pages, base, fail_on
        self.current_url, self.title, self.page_source, self._log, self.gets = base, "", "", [], []
        self.cookies = []
    def get(self, url):
        self.gets.append(url)
        if self.fail_on and self.fail_on(url):
            raise RuntimeError("net::ERR_NAME_NOT_RESOLVED")
        # Page 1 now uses the canonical /market/gifts URL without ?page=1.\n        # Treat that URL as page 1 in the fake browser just like the real catalog.\n        n = int(url.split("page=")[1]) if "page=" in url else 1
        status, html, ra = self.pages.get(n, (200, page_html([]), None))
        self.current_url, self.page_source, self.title = url, html, "Маркет"
        self._log = [perf(url, status, ra)]
    def execute_script(self, _): return "complete"
    def get_log(self, _):
        out, self._log = self._log, []
        return out
    def find_element(self, *_): return FakeElement(self.page_source.replace("<", " ").replace(">", " ")[:300])
    def find_elements(self, *_): return []
    def add_cookie(self, c): self.cookies.append(c)


def cfg(**kw):
    return CrawlConfig(delay=0, settle=0, sleep=lambda s: None, **kw)


class CrawlerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(os.path.join(self.tmp.name, "c.db"))
        self.store.migrate()
    def tearDown(self): self.tmp.cleanup()

    def test_full_pass_reaches_end_when_page_has_no_new_lots(self):
        b = FakeBrowser({1: (200, page_html([1, 2, 3]), None), 2: (200, page_html([4, 5]), None), 3: (200, page_html([4, 5]), None)})
        res = run_crawl(b, self.store, cfg(), log)
        self.assertEqual((res.status, res.reached_end, res.unique_lots, res.new_lots, res.pages), ("ok", True, 5, 5, 2))
        self.assertEqual(self.store.counts()["active_total"], 5)

    def test_empty_normal_page_after_first_is_end_of_catalog(self):
        b = FakeBrowser({1: (200, page_html([1, 2]), None), 2: (200, page_html([]), None)})
        res = run_crawl(b, self.store, cfg(), log)
        self.assertEqual((res.status, res.reached_end, res.unique_lots), ("ok", True, 2))

    def test_418_on_page_two_stops_without_retry_and_is_not_complete(self):
        b = FakeBrowser({1: (200, page_html([1, 2]), None), 2: (418, "<html><body>HTTP ERROR 418</body></html>", "120")})
        res = run_crawl(b, self.store, cfg(), log)
        self.assertEqual((res.status, res.http_status, res.status_source, res.retry_after), ("blocked", 418, "network", 120))
        self.assertFalse(res.reached_end)
        self.assertEqual(len(b.gets), 2, "no page may be requested again after a block")
        self.assertEqual(self.store.counts()["active_total"], 2, "data from the partial pass is kept, not deleted")

    def test_429_and_403_are_blocks(self):
        for code in (403, 429):
            b = FakeBrowser({1: (code, page_html([]), None)})
            res = run_crawl(b, self.store, cfg(), log)
            self.assertEqual((res.status, res.http_status), ("blocked", code))
            self.assertEqual(len(b.gets), 1)

    def test_500_is_server_error_not_empty_catalog(self):
        res = run_crawl(FakeBrowser({1: (503, "<html><body>oops</body></html>", None)}), self.store, cfg(), log)
        self.assertEqual(res.status, "server_error")
        self.assertFalse(res.reached_end)

    def test_dns_failure_is_reported_as_network_error(self):
        res = run_crawl(FakeBrowser({}, fail_on=lambda u: True), self.store, cfg(), log)
        self.assertEqual((res.status, res.cause), ("network_error", "dns"))

    def test_no_cards_on_first_page_is_not_success(self):
        res = run_crawl(FakeBrowser({1: (200, page_html([]), None)}), self.store, cfg(), log)
        self.assertIn(res.status, ("no_cards", "error"))
        self.assertEqual(self.store.counts()["active_total"], 0)

    def test_max_pages_does_not_claim_end(self):
        pages = {n: (200, page_html([n * 10, n * 10 + 1]), None) for n in range(1, 10)}
        res = run_crawl(FakeBrowser(pages), self.store, cfg(max_pages=3), log)
        self.assertEqual((res.status, res.reached_end, res.pages), ("ok", False, 3))

    def test_should_stop_aborts_incomplete(self):
        res = run_crawl(FakeBrowser({1: (200, page_html([1]), None)}), self.store, cfg(), log, should_stop=lambda: True)
        self.assertFalse(res.reached_end)

    def test_cookies_for_other_hosts_are_not_installed(self):
        raw = json.dumps([{"name": "a", "value": "1", "domain": ".huevo.su"}, {"name": "b", "value": "2", "domain": "evil.example"}])
        b = FakeBrowser({1: (200, page_html([1]), None), 2: (200, page_html([]), None)})
        run_crawl(b, self.store, cfg(cookies_raw=raw), log)
        self.assertEqual([c["name"] for c in b.cookies], ["a"])

    def test_cookies_all_foreign_means_login_status(self):
        raw = json.dumps([{"name": "b", "value": "2", "domain": "evil.example"}])
        res = run_crawl(FakeBrowser({}), self.store, cfg(cookies_raw=raw), log)
        self.assertEqual(res.status, "login")

    def test_logs_never_contain_cookie_values(self):
        raw = json.dumps([{"name": "sid", "value": "SECRET-COOKIE-VALUE", "domain": "huevo.su"}])
        with self.assertLogs("t", level="INFO") as cap:
            run_crawl(FakeBrowser({1: (200, page_html([1]), None), 2: (200, page_html([]), None)}), self.store, cfg(cookies_raw=raw), log)
        self.assertNotIn("SECRET-COOKIE-VALUE", "\n".join(cap.output))


if __name__ == "__main__":
    unittest.main()
