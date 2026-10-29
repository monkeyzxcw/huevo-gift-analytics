import json
import os
import tempfile
import unittest

_TEST_DIR = tempfile.TemporaryDirectory(prefix="huevo-tests-")
os.environ["HUEVO_DB"] = os.path.join(_TEST_DIR.name, "test.sqlite3")
os.environ["INGEST_TOKEN"] = "test-token-not-for-production"
os.environ["HUEVO_COOKIES_JSON"] = ""

from fastapi.testclient import TestClient
import app as app_module


class IngestApiTests(unittest.TestCase):
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

    def test_crawl_returns_actionable_error_without_server_session(self):
        response = self.client.post("/api/crawl")
        self.assertEqual(response.status_code, 503)
        self.assertIn("browser collector", response.json()["detail"].lower())

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
            response = self.client.post("/api/crawl")
            self.assertEqual(response.status_code, 429)
            self.assertTrue(int(response.headers["Retry-After"]) > 0)
        finally:
            app_module.state["blocked_until"] = previous

    def test_diagnostics_never_exposes_ingest_token(self):
        response = self.client.get("/api/diagnostics")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["ingest_token_configured"])
        self.assertNotIn("test-token-not-for-production", response.text)


if __name__ == "__main__":
    unittest.main()
