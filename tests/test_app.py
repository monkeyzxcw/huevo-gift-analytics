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

    def test_diagnostics_never_exposes_ingest_token(self):
        response = self.client.get("/api/diagnostics")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["ingest_token_configured"])
        self.assertNotIn("test-token-not-for-production", response.text)


if __name__ == "__main__":
    unittest.main()
