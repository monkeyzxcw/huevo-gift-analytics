import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from huevo_probe import (access_block_status, classify_network_error, classify_page,
                         looks_like_login_page, next_page_is_new)

HOSTS = {"huevo.su", "www.huevo.su", "huevo.departament.site"}


class ClassifyPageTests(unittest.TestCase):
    def page(self, url="https://huevo.su/market/gifts?page=1", title="Маркет", body="Подарки каталог", cards=0, **kw):
        return classify_page(url, title, body, cards, expected_hosts=HOSTS, **kw)

    def test_ok_when_cards_present(self):
        r = self.page(cards=24)
        self.assertEqual(r["verdict"], "ok")
        self.assertEqual(r["cards"], 24)

    def test_no_cards_on_normal_page(self):
        self.assertEqual(self.page(cards=0)["verdict"], "no_cards")

    def test_empty_body(self):
        self.assertEqual(self.page(body="  ", cards=0)["verdict"], "empty")

    def test_blocked_418_and_429(self):
        r = self.page(title="HTTP Error 418", body="I'm a teapot")
        self.assertEqual((r["verdict"], r["status_class_inferred"]), ("blocked", 418))
        r = self.page(body="Too many requests")
        self.assertEqual((r["verdict"], r["status_class_inferred"]), ("blocked", 429))

    def test_login_by_path_password_and_prompt(self):
        self.assertEqual(self.page(url="https://huevo.su/login")["verdict"], "login")
        self.assertEqual(self.page(password_visible=True)["verdict"], "login")
        self.assertEqual(self.page(body="Войдите в аккаунт")["verdict"], "login")

    def test_nav_word_login_with_cards_is_not_login(self):
        self.assertEqual(self.page(body="Войти Каталог", cards=5)["verdict"], "ok")

    def test_redirect_to_foreign_host(self):
        self.assertEqual(self.page(url="https://example.com/x")["verdict"], "wrong_host")

    def test_alternate_domain_is_accepted(self):
        self.assertEqual(self.page(url="https://huevo.departament.site/market/gifts", cards=3)["verdict"], "ok")

    def test_result_never_contains_body(self):
        r = self.page(body="секрет-текст " * 50, cards=1)
        self.assertNotIn("секрет", str(r))
        self.assertEqual(r["body_length"], len("секрет-текст " * 50))


class HelpersTests(unittest.TestCase):
    def test_login_heading_exact_match_only(self):
        self.assertTrue(looks_like_login_page("https://huevo.su/", "Huevo", "  Вход   в аккаунт ", ""))
        self.assertFalse(looks_like_login_page("https://huevo.su/", "Huevo", "Вход в маркет подарков", ""))

    def test_block_status(self):
        self.assertEqual(access_block_status("Access denied"), 403)
        self.assertIsNone(access_block_status("Обычная страница"))

    def test_network_error_causes(self):
        self.assertEqual(classify_network_error("net::ERR_NAME_NOT_RESOLVED"), "dns")
        self.assertEqual(classify_network_error("net::ERR_SSL_PROTOCOL_ERROR"), "tls")
        self.assertEqual(classify_network_error("net::ERR_CONNECTION_TIMED_OUT"), "timeout")
        self.assertEqual(classify_network_error("net::ERR_CONNECTION_REFUSED"), "connect")
        self.assertEqual(classify_network_error(ValueError("boom")), "other")

    def test_pagination_guard(self):
        self.assertTrue(next_page_is_new([], ["1", "2"]))
        self.assertTrue(next_page_is_new(["1", "2"], ["2", "3"]))
        self.assertFalse(next_page_is_new(["1", "2"], ["1", "2"]))   # site ignores ?page=
        self.assertFalse(next_page_is_new(["1", "2"], ["2"]))
        self.assertFalse(next_page_is_new(["1"], []))


if __name__ == "__main__":
    unittest.main()
