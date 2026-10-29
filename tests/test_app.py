import json
import os
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime, timedelta, timezone

_TEST_DIR = tempfile.TemporaryDirectory(prefix="huevo-tests-")
os.environ["HUEVO_DB"] = os.path.join(_TEST_DIR.name, "test.sqlite3")
os.environ["INGEST_TOKEN"] = "test-token-not-for-production"
os.environ["HUEVO_COOKIES_JSON"] = ""
os.environ["HUEVO_COOKIES"] = ""
os.environ["HUEVO_CLIENT_ID"] = "123"
os.environ["HUEVO_CLIENT_SECRET"] = "unit-test-secret-not-real"

from fastapi.testclient import TestClient
import app as app_module
import support

AUTH = {"Authorization": "Bearer test-token-not-for-production"}


def lot(i, price, title="Роза", rarity="Редкий", **kw):
    return {"lot_id": str(i), "title": title, "rarity": rarity, "price": price, "status": "В продаже", **kw}


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app_module.app)

    def setUp(self):
        with app_module.store.connect() as c:
            for table in ("lots", "price_history", "market_snapshots", "support_payments", "kv", "sales"):
                c.execute(f"DELETE FROM {table}")
        app_module._fails.clear()
        app_module._diag_last["at"] = 0.0

    def ingest(self, lots):
        return self.client.post("/api/ingest", headers=AUTH, json={"lots": lots})

    # ---- basics / security
    def test_health_and_index(self):
        self.assertTrue(self.client.get("/health").json()["ok"])
        page = self.client.get("/")
        self.assertEqual(page.status_code, 200)
        self.assertIn("frame-ancestors", page.headers["content-security-policy"])
        self.assertEqual(page.headers["x-content-type-options"], "nosniff")
        self.assertEqual(self.client.get("/api/status").headers["cache-control"], "no-store")

    def test_ingest_requires_bearer_and_ignores_query_token(self):
        self.assertEqual(self.client.post("/api/ingest", json={"lots": []}).status_code, 403)
        r = self.client.post("/api/ingest?token=test-token-not-for-production", json={"lots": []})
        self.assertEqual(r.status_code, 403, "token in query string must not be accepted")
        self.assertEqual(self.client.post("/api/ingest", headers={"Authorization": "Bearer wrong"}, json={"lots": []}).status_code, 403)

    def test_failed_tokens_are_rate_limited(self):
        for _ in range(app_module.FAIL_LIMIT):
            self.client.post("/api/ingest", headers={"Authorization": "Bearer wrong"}, json={"lots": []})
        r = self.client.post("/api/ingest", headers=AUTH, json={"lots": []})
        self.assertEqual(r.status_code, 429)
        self.assertIn("retry-after", r.headers)

    def test_ingest_limits_and_validation(self):
        self.assertEqual(self.ingest([lot(i, i) for i in range(1001)]).status_code, 400)
        self.assertEqual(self.client.post("/api/ingest", headers=AUTH, content=b"{not json").status_code, 400)
        self.assertEqual(self.client.post("/api/ingest", headers=AUTH, content=b"x" * 2_100_000).status_code, 413)
        r = self.ingest([lot(1, 10), {"lot_id": "abc"}, "junk", lot("2; DROP TABLE lots", 5)])
        self.assertEqual((r.json()["saved"], r.json()["rejected"]), (1, 3))

    def test_ingest_saves_history_and_sanitizes_urls(self):
        r = self.ingest([lot(900001, 12345, image_url="javascript:alert(1)", lot_url="https://example.com/fake")])
        self.assertEqual(r.status_code, 200, r.text)
        item = self.client.get("/api/catalog?q=900001").json()["items"][0]
        self.assertEqual((item["price"], item["image_url"], item["lot_url"]), (12345, "", "https://huevo.su/market/lot/900001"))
        self.ingest([lot(900001, 12345)])            # same data again: no new history row
        self.assertEqual(len(self.client.get("/api/history/900001").json()), 1)
        self.ingest([lot(900001, 10000)])
        self.assertEqual(len(self.client.get("/api/history/900001").json()), 2)
        self.assertEqual(self.client.get("/api/history/abc").status_code, 400)

    # ---- pass completion
    def test_incomplete_pass_never_deactivates_or_snapshots(self):
        self.ingest([lot(i, 100 + i) for i in range(1, 6)])
        self.client.post("/api/ingest/complete", headers=AUTH, json={"reached_end": True})
        self.ingest([lot(1, 101)])
        r = self.client.post("/api/ingest/complete", headers=AUTH, json={"reached_end": False}).json()
        self.assertFalse(r["complete"])
        self.assertEqual(self.client.get("/api/catalog").json()["total"], 5)
        self.assertEqual(len(self.client.get("/api/analytics/snapshots").json()["points"]), 1)

    def test_complete_pass_deactivates_missing_lots_and_snapshots(self):
        self.ingest([lot(i, 100 + i) for i in range(1, 6)])
        self.client.post("/api/ingest/complete", headers=AUTH, json={"reached_end": True})
        self.ingest([lot(i, 100 + i) for i in range(1, 5)])
        r = self.client.post("/api/ingest/complete", headers=AUTH, json={"reached_end": True}).json()
        self.assertEqual((r["deactivated"], r["complete"]), (1, True))
        self.assertEqual(self.client.get("/api/catalog").json()["total"], 4)

    def test_suspiciously_small_pass_is_not_trusted(self):
        self.ingest([lot(i, 100 + i) for i in range(1, 41)])
        self.client.post("/api/ingest/complete", headers=AUTH, json={"reached_end": True})
        self.ingest([lot(1, 101)])
        r = self.client.post("/api/ingest/complete", headers=AUTH, json={"reached_end": True}).json()
        self.assertEqual(r["deactivated"], 0)
        self.assertIsNotNone(r["warning"])
        self.assertEqual(self.client.get("/api/catalog").json()["total"], 40)

    # ---- catalog / analytics
    def test_catalog_pagination_filters_and_search_escaping(self):
        self.ingest([lot(i, i * 10, title="Звезда_%" if i == 1 else "Роза", rarity="Мифический" if i % 2 else "Редкий") for i in range(1, 31)])
        page = self.client.get("/api/catalog?limit=10&offset=10&sort=price").json()
        self.assertEqual((page["total"], len(page["items"]), page["items"][0]["price"]), (30, 10, 110))
        self.assertEqual(self.client.get("/api/catalog?q=%25").json()["total"], 1)        # '%' is literal
        self.assertEqual(self.client.get("/api/catalog?rarity=Мифический").json()["total"], 15)
        self.assertEqual(self.client.get("/api/catalog?min_price=100&max_price=150").json()["total"], 6)
        self.assertEqual(self.client.get("/api/catalog?q=' OR 1=1 --").json()["total"], 0)
        self.assertEqual(self.client.get("/api/catalog?sort=price;drop").status_code, 400)
        self.assertEqual(self.client.get("/api/catalog?limit=100000").status_code, 200)
        self.assertEqual(self.client.get("/api/catalog?limit=abc").status_code, 422)
        self.assertIn("Мифический", self.client.get("/api/facets").json()["rarities"])

    def test_sales_summary_uses_only_confirmed_sales_and_hides_people(self):
        empty = self.client.get("/api/sales/summary").json()
        self.assertEqual((empty["summary"]["count"], empty["summary"]["median"]), (0, None))
        app_module.store.upsert_sales([{"sale_key": f"k{i}", "lot_id": str(i), "title": "Звезда #%d" % i, "price": p, "time_raw": "01:00", "sold_at": None}
                                       for i, p in enumerate([10, 20, 30, None, 0])])
        r = self.client.get("/api/sales/summary").json()
        self.assertEqual((r["summary"]["count"], r["summary"]["median"], r["summary"]["unknown"]), (3, 20, 2))
        self.assertEqual(r["by_title"][0]["title"], "звезда")
        self.assertEqual(r["with_confirmed_date"], 0)
        self.assertNotIn("seller", json.dumps(r))

    def test_lots_by_ids_validates_input(self):
        self.ingest([lot(5, 50)])
        self.assertEqual(len(self.client.get("/api/lots/by-ids?ids=5,6").json()["items"]), 1)
        self.assertEqual(self.client.get("/api/lots/by-ids?ids=5;drop").status_code, 400)
        self.assertEqual(self.client.get("/api/lots/by-ids").json()["items"], [])

    def test_empty_database_responses_are_honest(self):
        self.assertEqual(self.client.get("/api/catalog").json()["total"], 0)
        h = self.client.get("/api/highlights").json()
        self.assertEqual((h["latest"], h["best"], h["data_state"]), (None, None, "empty"))
        a = self.client.get("/api/analytics/summary").json()
        self.assertFalse(a["enough_data"])
        self.assertEqual(a["bins"], [])
        self.assertIsNone(a["changes"][0]["change_pct"])
        self.assertEqual(self.client.get("/api/deals").json()["deals"], [])

    def test_deals_and_best_value_are_labelled_as_offers(self):
        self.ingest([lot(1, 50), lot(2, 100), lot(3, 110), lot(4, 120), lot(5, 130)])
        d = self.client.get("/api/deals").json()
        self.assertEqual(d["deals"][0]["lot_id"], "1")
        self.assertIn("не цены завершённых продаж", d["note"])
        b = self.client.get("/api/highlights").json()
        self.assertEqual((b["best"]["lot_id"], b["best"]["basis"]), ("1", "active"))
        self.assertGreaterEqual(b["best"]["sample_size"], 3)

    def test_highlights_prefers_gone_lots_as_reference(self):
        self.ingest([lot(i, 200) for i in range(10, 14)])
        self.client.post("/api/ingest/complete", headers=AUTH, json={"reached_end": True})
        self.ingest([lot(20, 120)])
        self.client.post("/api/ingest/complete", headers=AUTH, json={"reached_end": True})
        # lots 10-13 are gone now (4 of 5 previously active: guard needs >=20 so deactivation applies)
        best = self.client.get("/api/highlights").json()["best"]
        self.assertEqual((best["lot_id"], best["basis"], best["reference"]), ("20", "gone", 200))

    def test_diagnostics_never_expose_secrets(self):
        body = json.dumps(self.client.get("/api/diagnostics").json())
        for secret in ("test-token-not-for-production", "unit-test-secret-not-real"):
            self.assertNotIn(secret, body)

    # ---- crawl / block cooldown
    def test_crawl_and_diagnose_require_token(self):
        self.assertEqual(self.client.post("/api/crawl").status_code, 403)
        self.assertEqual(self.client.post("/api/diagnose-huevo").status_code, 403)
        self.assertEqual(self.client.get("/api/backup").status_code, 403)

    def test_crawl_without_server_session_is_actionable(self):
        r = self.client.post("/api/crawl", headers=AUTH)
        self.assertEqual(r.status_code, 503)
        self.assertIn("HUEVO_COOKIES_JSON", r.json()["detail"])

    def test_cooldown_is_persisted_and_blocks_crawl_and_diagnose(self):
        app_module.start_block(418, 7200)
        for path in ("/api/crawl", "/api/diagnose-huevo"):
            r = self.client.post(path, headers=AUTH)
            self.assertEqual(r.status_code, 429, path)
            self.assertGreater(int(r.headers["retry-after"]), 3600)
        self.assertIsNotNone(self.client.get("/api/status").json()["blocked_until"])
        app_module.store.kv_set("blocked_until", (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat())
        self.assertIsNone(self.client.get("/api/status").json()["blocked_until"])

    def test_retry_after_longer_than_default_is_respected(self):
        until = app_module.start_block(429, 10 * 3600)
        self.assertGreater((until - datetime.now(timezone.utc)).total_seconds(), 9.9 * 3600)

    def test_backup_is_a_valid_sqlite_file(self):
        self.ingest([lot(1, 10)])
        r = self.client.get("/api/backup", headers=AUTH)
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.content.startswith(b"SQLite format 3"))

    # ---- support payments
    def launch_query(self, mode="live", user="1001"):
        import time
        from urllib.parse import urlencode
        p = {"hu_app_id": "123", "hu_user_id": user, "hu_mode": mode, "hu_ts": str(int(time.time()))}
        p["hu_hash"] = support.sign_launch(p, "unit-test-secret-not-real")
        return "?" + urlencode(p)

    def test_support_intent_rejects_unsigned_launch_and_bad_amount(self):
        r = self.client.post("/api/support/intent", json={"amount": 5, "launch_query": "?hu_user_id=1"})
        self.assertEqual(r.status_code, 401)
        r = self.client.post("/api/support/intent", json={"amount": 0, "launch_query": self.launch_query()})
        self.assertEqual(r.status_code, 400)

    def test_support_intent_uses_verified_user_and_test_flag(self):
        captured = {}

        def fake(method, path, body=None):
            captured.update(method=method, path=path, body=body)
            return 200, {"ok": True, "intent_id": "pi_unit1", "status": "pending"}
        with patch("app.huevo_api", fake):
            r = self.client.post("/api/support/intent", json={"amount": 10, "launch_query": self.launch_query(mode="test")})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((captured["body"]["user_id"], captured["body"]["test"], captured["path"]), (1001, True, "/payments"))

    def test_support_callback_requires_valid_signature_and_final_status_never_changes(self):
        import hashlib
        import hmac
        now = "2026-01-01T00:00:00+00:00"
        with app_module.store.connect() as c:
            c.execute("INSERT INTO support_payments(intent_id,user_id,amount,test,status,created_at,updated_at) VALUES('pi_x',1,10,0,'pending',?,?)", (now, now))
        key = hashlib.sha256(b"unit-test-secret-not-real").digest()

        def post(payload, sig=None):
            body = json.dumps(payload).encode()
            sig = sig or hmac.new(key, body, hashlib.sha256).hexdigest()
            return self.client.post("/api/support/callback", content=body, headers={"X-Huevo-Signature": sig})
        self.assertEqual(post({"intent_id": "pi_x", "status": "succeeded"}, sig="0" * 64).status_code, 401)
        self.assertEqual(post({"intent_id": "pi_x", "status": "succeeded"}).status_code, 204)
        self.assertEqual(post({"intent_id": "pi_x", "status": "succeeded"}).status_code, 204)     # duplicate delivery
        self.assertEqual(post({"intent_id": "pi_x", "status": "failed"}).status_code, 204)
        with patch("app.huevo_api", lambda *a, **k: (0, {})):
            self.assertEqual(self.client.get("/api/support/status/pi_x").json()["status"], "succeeded")
        self.assertEqual(self.client.get("/api/support/stats").json(), {"supporters": 1, "total": 10})

    def test_support_status_validates_id_and_stats_hide_test_payments(self):
        self.assertEqual(self.client.get("/api/support/status/pi_missing").status_code, 404)
        self.assertEqual(self.client.get("/api/support/status/bad id").status_code, 400)
        now = "2026-01-01T00:00:00+00:00"
        with app_module.store.connect() as c:
            c.execute("INSERT INTO support_payments VALUES('pi_t',1,50,1,'succeeded',NULL,?,?)", (now, now))
        self.assertEqual(self.client.get("/api/support/stats").json(), {"supporters": 0, "total": 0})


if __name__ == "__main__":
    unittest.main()
