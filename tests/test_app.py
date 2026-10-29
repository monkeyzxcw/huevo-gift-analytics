import json
import os
import tempfile
import unittest
from unittest.mock import patch

_TEST_DIR = tempfile.TemporaryDirectory(prefix="huevo-tests-")
os.environ["HUEVO_DB"] = os.path.join(_TEST_DIR.name, "test.sqlite3")
os.environ["INGEST_TOKEN"] = "test-token-not-for-production"
os.environ["HUEVO_COOKIES_JSON"] = ""
os.environ["HUEVO_CLIENT_ID"] = "123"
os.environ["HUEVO_CLIENT_SECRET"] = "unit-test-secret-not-real"

from fastapi.testclient import TestClient
import app as app_module


AUTH = {"Authorization": "Bearer test-token-not-for-production"}


class IngestApiTests(unittest.TestCase):
    def setUp(self):
        # The test module shares one temporary SQLite file. Clear rows between
        # cases so a full-crawl test never deactivates fixtures from another test.
        with app_module.db() as c:
            c.execute("DELETE FROM lots")
            c.execute("DELETE FROM price_history")
            c.execute("DELETE FROM market_snapshots")
            c.execute("DELETE FROM support_payments")

    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app_module.app)

    def test_health_endpoint(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["ok"])

    def test_parser_handles_card_without_mk_gcard_and_data_price(self):
        html = '''
        <a class="gift-card" href="/market/lot/900002" aria-label="Fallback Gift">
          <img data-src="/images/gift.webp" alt="Fallback Gift">
          <span class="serial">#2</span>
          <span class="price" data-price="456"></span>
          <span class="status">В продаже</span>
        </a>
        '''
        rows, card_count = app_module.parse_cards(html)
        self.assertEqual(card_count, 1)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["lot_id"], "900002")
        self.assertEqual(rows[0]["title"], "Fallback Gift")
        self.assertEqual(rows[0]["price"], 456)
        self.assertEqual(rows[0]["image_url"], "https://huevo.su/images/gift.webp")
        self.assertEqual(rows[0]["lot_url"], "https://huevo.su/market/lot/900002")

    def test_ingest_saves_history_and_sanitizes_urls(self):
        response = self.client.post(
            "/api/ingest",
            headers={"Authorization": "Bearer test-token-not-for-production"},
            json={"lots": [{
                "lot_id": "900001",
                "title": "Тестовый подарок",
                "serial": "#1",
                "rarity": "Редкий",
                "price": 12345,
                "status": "В продаже",
                "image_url": "javascript:alert(1)",
                "lot_url": "https://example.com/fake-lot"
            }]}
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["saved"], 1)
        lot = self.client.get("/api/lots?q=900001").json()[0]
        self.assertEqual(lot["price"], 12345)
        self.assertEqual(lot["lot_url"], "https://huevo.su/market/lot/900001")
        self.assertEqual(lot["image_url"], "")
        history = self.client.get("/api/history/900001").json()
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0]["price"], 12345)
        daily = self.client.get("/api/analytics/price-history?days=7&lot_id=900001")
        self.assertEqual(daily.status_code, 200, daily.text)
        self.assertEqual(len(daily.json()["points"]), 1)
        self.assertEqual(daily.json()["points"][0]["avg_price"], 12345)

    def test_cookie_json_export_supports_common_extension_fields(self):
        cookies = app_module.load_cookie_export(
            '[{"name":"session","value":"example-only","domain":".huevo.su","expirationDate":1800000000,"httpOnly":true}]'
        )
        self.assertEqual(len(cookies), 1)
        self.assertEqual(cookies[0]["expiry"], 1800000000)
        self.assertTrue(cookies[0]["httpOnly"])

    def test_cookie_netscape_export(self):
        raw = "# Netscape HTTP Cookie File\n#HttpOnly_.huevo.departament.site\tTRUE\t/\tTRUE\t1800000000\tsession\texample-only\n"
        cookies = app_module.load_cookie_export(raw)
        self.assertEqual(len(cookies), 1)
        self.assertEqual(cookies[0]["domain"], ".huevo.departament.site")
        self.assertTrue(cookies[0]["httpOnly"])
        self.assertEqual(cookies[0]["value"], "example-only")

    def test_alternate_huevo_host_is_allowed_but_unrelated_host_is_not(self):
        self.assertTrue(app_module.is_huevo_host("huevo.su"))
        self.assertTrue(app_module.is_huevo_host("huevo.departament.site"))
        self.assertTrue(app_module.is_huevo_host("cdn.huevo.departament.site"))
        self.assertFalse(app_module.is_huevo_host("not-huevo.departament.site"))
        self.assertFalse(app_module.is_huevo_host("example.com"))

    def test_crawl_returns_actionable_error_without_server_session(self):
        response = self.client.post("/api/crawl", headers=AUTH)
        self.assertEqual(response.status_code, 503)
        detail = response.json()["detail"].lower()
        self.assertIn("huevo_cookies_json", detail)
        self.assertIn("huevo_cookies", detail)

    def test_ingest_rejects_bad_token(self):
        response = self.client.post(
            "/api/ingest",
            headers={"Authorization": "Bearer wrong-token"},
            json={"lots": []}
        )
        self.assertEqual(response.status_code, 403)

    def test_ingest_rejects_more_than_one_thousand_lots(self):
        response = self.client.post(
            "/api/ingest",
            headers={"Authorization": "Bearer test-token-not-for-production"},
            json={"lots": [{"lot_id": str(i), "price": i} for i in range(1001)]}
        )
        self.assertEqual(response.status_code, 400)

    def test_analytics_price_history_rejects_invalid_lot_id(self):
        response = self.client.get("/api/analytics/price-history?days=30&lot_id=not-a-number")
        self.assertEqual(response.status_code, 400)

    def test_analytics_price_history_limits_requested_period(self):
        response = self.client.get("/api/analytics/price-history?days=999")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["days"], 90)
        self.assertEqual(response.json()["points"], [])

    def test_login_detection_uses_root_or_real_login_markers_not_nav_words(self):
        self.assertTrue(app_module.looks_like_login_page(
            "https://huevo.su/login", "Huevo", "", "Войдите в аккаунт",
            password_visible=False, has_market_cards=False
        ))
        self.assertTrue(app_module.looks_like_login_page(
            "https://huevo.su/", "Huevo", "Вход в аккаунт", "Добро пожаловать",
            password_visible=False, has_market_cards=False
        ))
        self.assertTrue(app_module.looks_like_login_page(
            "https://huevo.su/", "Huevo", "Главная", "Please log in to continue",
            password_visible=False, has_market_cards=False
        ))
        self.assertFalse(app_module.looks_like_login_page(
            "https://huevo.su/", "Huevo", "Маркет подарков", "Войти Подарки Каталог",
            password_visible=False, has_market_cards=True
        ))

    def test_access_block_status_recognizes_huevo_restrictions(self):
        self.assertEqual(app_module.access_block_status("HTTP Error 418: I'm a teapot"), 418)
        self.assertEqual(app_module.access_block_status("Access denied"), 403)
        self.assertEqual(app_module.access_block_status("Too many requests"), 429)
        self.assertEqual(app_module.access_block_status("Обычная страница каталога"), None)

    def test_crawl_returns_retry_after_during_block_cooldown(self):
        previous = app_module.state.get("blocked_until")
        until = (app_module.datetime.now(app_module.timezone.utc) +
                 app_module.timedelta(minutes=10)).isoformat()
        app_module.state["blocked_until"] = until
        try:
            response = self.client.post("/api/crawl", headers=AUTH)
            self.assertEqual(response.status_code, 429)
            self.assertTrue(int(response.headers["Retry-After"]) > 0)
        finally:
            app_module.state["blocked_until"] = previous

    def test_diagnose_huevo_requires_token(self):
        self.assertEqual(self.client.post("/api/diagnose-huevo").status_code, 403)
        response = self.client.post("/api/diagnose-huevo", headers={"Authorization": "Bearer wrong"})
        self.assertEqual(response.status_code, 403)

    def test_diagnose_huevo_respects_block_cooldown(self):
        previous = app_module.state.get("blocked_until")
        app_module.state["blocked_until"] = (app_module.datetime.now(app_module.timezone.utc) +
                                             app_module.timedelta(minutes=10)).isoformat()
        try:
            response = self.client.post("/api/diagnose-huevo",
                                        headers={"Authorization": "Bearer test-token-not-for-production"})
            self.assertEqual(response.status_code, 429)
        finally:
            app_module.state["blocked_until"] = previous

    def test_parser_dedupes_nothing_but_extracts_ids_in_order(self):
        html = "".join(f'<a class="mk-gcard" href="/market/lot/{i}"><div class="mk-gtitle">G{i}</div><div class="mk-price">{i}00</div></a>' for i in (5, 6, 7))
        rows, count = app_module.parse_cards(html)
        self.assertEqual([r["lot_id"] for r in rows], ["5", "6", "7"])
        self.assertEqual([r["price"] for r in rows], [500, 600, 700])

    def test_crawl_requires_token(self):
        self.assertEqual(self.client.post("/api/crawl").status_code, 403)

    def test_ingest_complete_deactivates_only_after_complete_pass(self):
        def post(lots):
            return self.client.post("/api/ingest", headers=AUTH, json={"lots": lots})
        app_module.state["ingest_run_started"] = None
        post([{"lot_id": "910001", "title": "Roses", "price": 100}, {"lot_id": "910002", "title": "Roses", "price": 120}])
        r = self.client.post("/api/ingest/complete", headers=AUTH, json={"reached_end": True})
        self.assertEqual(r.json()["deactivated"], 0)
        # next pass sees only one of them
        post([{"lot_id": "910001", "title": "Roses", "price": 100}])
        incomplete = self.client.post("/api/ingest/complete", headers=AUTH, json={"reached_end": False}).json()
        self.assertEqual(incomplete["deactivated"], 0)
        ids = {l["lot_id"] for l in self.client.get("/api/lots?q=91000").json()}
        self.assertEqual(ids, {"910001", "910002"})
        post([{"lot_id": "910001", "title": "Roses", "price": 100}])
        done = self.client.post("/api/ingest/complete", headers=AUTH, json={"reached_end": True}).json()
        self.assertGreaterEqual(done["deactivated"], 1)
        ids = {l["lot_id"] for l in self.client.get("/api/lots?q=91000").json()}
        self.assertEqual(ids, {"910001"})
        snaps = self.client.get("/api/analytics/snapshots?days=1").json()["points"]
        self.assertGreaterEqual(len(snaps), 2)
        self.assertEqual(snaps[-1]["source"], "browser")

    def test_deals_endpoint_finds_cheap_lot(self):
        self.client.post("/api/ingest", headers=AUTH, json={"lots": [
            {"lot_id": "920001", "title": "DealGift", "price": 50},
            {"lot_id": "920002", "title": "DealGift", "price": 100},
            {"lot_id": "920003", "title": "DealGift", "price": 100},
            {"lot_id": "920004", "title": "DealGift", "price": 110}]})
        body = self.client.get("/api/deals").json()
        self.assertIn("920001", [d["lot_id"] for d in body["deals"]])
        self.assertIn("не цены завершённых продаж", body["note"])

    # ---- support the author (huEVO Apps payments)
    def _launch_query(self, mode="live", user="1001"):
        import time, support
        from urllib.parse import urlencode
        p = {"hu_app_id": "123", "hu_user_id": user, "hu_mode": mode, "hu_ts": str(int(time.time()))}
        p["hu_hash"] = support.sign_launch(p, "unit-test-secret-not-real")
        return "?" + urlencode(p)

    def test_support_intent_rejects_unsigned_launch_and_bad_amount(self):
        r = self.client.post("/api/support/intent", json={"amount": 5, "launch_query": "?hu_user_id=1"})
        self.assertEqual(r.status_code, 401)
        r = self.client.post("/api/support/intent", json={"amount": 0, "launch_query": self._launch_query()})
        self.assertEqual(r.status_code, 400)

    def test_support_intent_uses_verified_user_and_test_flag(self):
        captured = {}
        def fake(method, path, body=None):
            captured.update(method=method, path=path, body=body)
            return 200, {"ok": True, "intent_id": "pi_unit1", "status": "pending"}
        with patch("app.huevo_api", fake):
            r = self.client.post("/api/support/intent", json={"amount": 10, "launch_query": self._launch_query(mode="test")})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(captured["body"]["user_id"], 1001)
        self.assertIs(captured["body"]["test"], True)
        self.assertEqual(captured["path"], "/payments")
        self.assertEqual(r.json()["intent_id"], "pi_unit1")

    def test_support_callback_requires_valid_signature_and_is_idempotent(self):
        import hashlib, hmac, json as _json
        with patch("app.huevo_api", lambda *a, **k: (200, {"ok": True, "intent_id": "pi_unit2", "status": "pending"})):
            self.client.post("/api/support/intent", json={"amount": 5, "launch_query": self._launch_query()})
        body = _json.dumps({"event": "payment", "intent_id": "pi_unit2", "status": "succeeded", "test": False}).encode()
        key = hashlib.sha256(b"unit-test-secret-not-real").digest()
        sig = hmac.new(key, body, hashlib.sha256).hexdigest()
        self.assertEqual(self.client.post("/api/support/callback", content=body, headers={"X-Huevo-Signature": "0" * 64}).status_code, 401)
        self.assertEqual(self.client.post("/api/support/callback", content=body, headers={"X-Huevo-Signature": sig}).status_code, 204)
        failed = _json.dumps({"event": "payment", "intent_id": "pi_unit2", "status": "failed"}).encode()
        sig2 = hmac.new(key, failed, hashlib.sha256).hexdigest()
        self.assertEqual(self.client.post("/api/support/callback", content=failed, headers={"X-Huevo-Signature": sig2}).status_code, 204)
        st = self.client.get("/api/support/status/pi_unit2").json()
        self.assertEqual(st["status"], "succeeded")  # a final status never changes
        self.assertGreaterEqual(self.client.get("/api/support/stats").json()["supporters"], 1)

    def test_support_status_validates_id(self):
        self.assertEqual(self.client.get("/api/support/status/not-an-intent").status_code, 400)
        self.assertEqual(self.client.get("/api/support/status/pi_missing").status_code, 404)

    def test_highlights_and_drops_work_on_data(self):
        self.client.post("/api/ingest", headers=AUTH, json={"lots": [{"lot_id": "930001", "title": "HiGift", "price": 100}]})
        self.client.post("/api/ingest", headers=AUTH, json={"lots": [{"lot_id": "930001", "title": "HiGift", "price": 80}]})
        h = self.client.get("/api/highlights").json()
        self.assertIsNotNone(h["latest"])
        self.assertIn("не цены завершённых", h["best_note"])
        drops = self.client.get("/api/drops").json()
        self.assertIn("930001", [d["lot_id"] for d in drops])

    def test_diagnostics_never_exposes_ingest_token(self):
        response = self.client.get("/api/diagnostics")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["ingest_token_configured"])
        self.assertNotIn("test-token-not-for-production", response.text)


if __name__ == "__main__":
    unittest.main()
