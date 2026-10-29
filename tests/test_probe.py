import json, os, sys, unittest
from datetime import datetime, timedelta, timezone
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from huevo_probe import (access_block_status, classify_network_error, classify_page, looks_like_login_page,
                         main_response, next_page_is_new, parse_perf_log, parse_retry_after)

HOSTS = {"huevo.su", "www.huevo.su", "huevo.departament.site"}


def perf(method, **params):
    return {"message": json.dumps({"message": {"method": method, "params": params}})}


def doc(url, status, **headers):
    return perf("Network.responseReceived", type="Document", response={"url": url, "status": status, "headers": headers})


class ClassifyPageTests(unittest.TestCase):
    def page(self, url="https://huevo.su/market/gifts?page=1", title="Маркет", body="Подарки каталог", cards=0, **kw):
        return classify_page(url, title, body, cards, expected_hosts=HOSTS, **kw)

    def test_ok_no_cards_empty(self):
        self.assertEqual(self.page(cards=24)["verdict"], "ok")
        self.assertEqual(self.page(cards=0)["verdict"], "no_cards")
        self.assertEqual(self.page(body="  ")["verdict"], "empty")

    def test_text_inferred_block_is_flagged_as_inferred(self):
        r = self.page(title="HTTP Error 418", body="I'm a teapot")
        self.assertEqual((r["verdict"], r["status_class_inferred"], r["status_source"]), ("blocked", 418, "inferred"))

    def test_real_status_is_authoritative(self):
        r = self.page(http_status=418, body="обычный текст без маркеров")
        self.assertEqual((r["verdict"], r["http_status"], r["status_source"]), ("blocked", 418, "network"))
        self.assertEqual(self.page(http_status=429, retry_after=120)["retry_after"], 120)
        self.assertEqual(self.page(http_status=503)["verdict"], "server_error")
        self.assertEqual(self.page(http_status=404)["verdict"], "not_found")
        self.assertEqual(self.page(http_status=200, cards=3)["verdict"], "ok")

    def test_login_wrong_host_and_alt_domain(self):
        self.assertEqual(self.page(url="https://huevo.su/login")["verdict"], "login")
        self.assertEqual(self.page(password_visible=True)["verdict"], "login")
        self.assertEqual(self.page(body="Войти Каталог", cards=5)["verdict"], "ok")
        self.assertEqual(self.page(url="https://example.com/x")["verdict"], "wrong_host")
        self.assertEqual(self.page(url="https://huevo.departament.site/market/gifts", cards=3)["verdict"], "ok")

    def test_result_never_contains_body(self):
        r = self.page(body="секрет-текст " * 50, cards=1)
        self.assertNotIn("секрет", str(r))


class PerfLogTests(unittest.TestCase):
    def test_extracts_status_and_retry_after_only(self):
        log = [perf("Network.requestWillBeSent", request={"headers": {"Cookie": "SECRET"}}),
               doc("https://huevo.su/market/gifts?page=1", 429, **{"Retry-After": "120", "Set-Cookie": "SECRET"}),
               perf("Network.responseReceived", type="Image", response={"url": "https://huevo.su/a.png", "status": 200})]
        parsed = parse_perf_log(log)
        self.assertEqual(len(parsed["documents"]), 1)
        self.assertEqual(main_response(parsed, "/market/gifts?page=1"), {"url": "https://huevo.su/market/gifts?page=1", "status": 429, "retry_after": 120})
        self.assertNotIn("SECRET", json.dumps(parsed))

    def test_redirect_chain_uses_final_matching_document(self):
        parsed = parse_perf_log([doc("https://huevo.su/market/gifts", 302), doc("https://huevo.su/login", 200)])
        self.assertEqual(main_response(parsed, "/market/gifts")["status"], 302)
        self.assertEqual(main_response(parsed, "/nothing")["status"], 200)   # falls back to the last document

    def test_failures_and_garbage_entries(self):
        parsed = parse_perf_log([perf("Network.loadingFailed", errorText="net::ERR_NAME_NOT_RESOLVED"), {"message": "not json"}, {}, None and {}])
        self.assertEqual(classify_network_error(parsed["failures"][0]), "dns")
        self.assertIsNone(main_response(parse_perf_log([]), "/"))
        self.assertIsNone(main_response(parse_perf_log(None), "/"))


class RetryAfterTests(unittest.TestCase):
    def test_values(self):
        now = datetime(2026, 1, 1, tzinfo=timezone.utc)
        self.assertEqual(parse_retry_after("120"), 120)
        self.assertEqual(parse_retry_after("999999999"), 86400)                       # capped
        when = (now + timedelta(seconds=90)).strftime("%a, %d %b %Y %H:%M:%S GMT")
        self.assertEqual(parse_retry_after(when, now=now), 90)
        self.assertEqual(parse_retry_after("Wed, 01 Jan 2020 00:00:00 GMT", now=now), 0)   # past date
        for bad in (None, "", "soon", "-5"):
            self.assertIsNone(parse_retry_after(bad))


class HelpersTests(unittest.TestCase):
    def test_login_heading_exact_match_only(self):
        self.assertTrue(looks_like_login_page("https://huevo.su/", "Huevo", "  Вход   в аккаунт ", ""))
        self.assertFalse(looks_like_login_page("https://huevo.su/", "Huevo", "Вход в маркет подарков", ""))

    def test_block_status(self):
        self.assertEqual(access_block_status("Access denied"), 403)
        self.assertEqual(access_block_status("Too many requests"), 429)
        self.assertIsNone(access_block_status("Обычная страница"))

    def test_network_error_causes(self):
        for text, want in [("net::ERR_NAME_NOT_RESOLVED", "dns"), ("net::ERR_SSL_PROTOCOL_ERROR", "tls"),
                           ("net::ERR_CONNECTION_TIMED_OUT", "timeout"), ("net::ERR_CONNECTION_REFUSED", "connect"), ("boom", "other")]:
            self.assertEqual(classify_network_error(text), want)

    def test_pagination_guard(self):
        self.assertTrue(next_page_is_new([], ["1", "2"]))
        self.assertTrue(next_page_is_new(["1", "2"], ["2", "3"]))
        self.assertFalse(next_page_is_new(["1", "2"], ["1", "2"]))
        self.assertFalse(next_page_is_new(["1"], []))


if __name__ == "__main__":
    unittest.main()
