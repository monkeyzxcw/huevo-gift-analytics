import os, sys, time, unittest, hashlib, hmac
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import support

SECRET = "unit-test-secret-not-real"


def signed_query(extra=None, ts=None, secret=SECRET):
    p = {"hu_app_id": "7", "hu_user_id": "1001", "hu_mode": "live", "hu_display_name": "Тест Тестов",
         "hu_ts": str(int(ts if ts is not None else time.time()))}
    p.update(extra or {})
    p["hu_hash"] = support.sign_launch(p, secret)
    from urllib.parse import urlencode
    return "?" + urlencode(p)


class LaunchTests(unittest.TestCase):
    def test_valid_signature(self):
        got = support.verify_launch(signed_query(), SECRET)
        self.assertEqual(got["hu_user_id"], "1001")

    def test_matches_documented_reference_algorithm(self):
        # Independent re-implementation of the docs example.
        params = {"hu_app_id": "7", "hu_user_id": "1001", "hu_ts": "1800000000"}
        data = "\n".join(f"{k}={v}" for k, v in sorted(params.items()))
        key = hashlib.sha256(SECRET.encode()).digest()
        h = hmac.new(key, data.encode(), hashlib.sha256).hexdigest()
        q = f"hu_app_id=7&hu_user_id=1001&hu_ts=1800000000&hu_hash={h}"
        self.assertIsNotNone(support.verify_launch(q, SECRET, now=1800000100))

    def test_tampered_user_rejected(self):
        q = signed_query().replace("hu_user_id=1001", "hu_user_id=1")
        self.assertIsNone(support.verify_launch(q, SECRET))

    def test_wrong_secret_and_missing_hash(self):
        self.assertIsNone(support.verify_launch(signed_query(), "other"))
        self.assertIsNone(support.verify_launch("?hu_user_id=1&hu_ts=1", SECRET))
        self.assertIsNone(support.verify_launch(signed_query(), ""))

    def test_stale_and_future_rejected(self):
        self.assertIsNone(support.verify_launch(signed_query(ts=time.time() - 90000), SECRET))
        self.assertIsNone(support.verify_launch(signed_query(ts=time.time() + 600), SECRET))

    def test_non_hu_params_do_not_affect_signature(self):
        q = signed_query() + "&utm=anything"
        self.assertIsNotNone(support.verify_launch(q, SECRET))

    def test_test_flag_from_verified_mode(self):
        self.assertFalse(support.is_test_session({"hu_mode": "live"}))
        self.assertTrue(support.is_test_session({"hu_mode": "test"}))
        self.assertTrue(support.is_test_session({}))


class CallbackTests(unittest.TestCase):
    def test_signature_over_raw_body(self):
        body = b'{"event":"payment","intent_id":"pi_1","status":"succeeded"}'
        sig = hmac.new(hashlib.sha256(SECRET.encode()).digest(), body, hashlib.sha256).hexdigest()
        self.assertTrue(support.verify_callback(body, sig, SECRET))
        self.assertTrue(support.verify_callback(body, sig.upper(), SECRET))
        self.assertFalse(support.verify_callback(body + b" ", sig, SECRET))
        self.assertFalse(support.verify_callback(body, "", SECRET))
        self.assertFalse(support.verify_callback(body, sig, ""))


class BodyTests(unittest.TestCase):
    def test_amount_limits(self):
        self.assertEqual(support.clean_amount(5), 5)
        for bad in (0, -1, 100001, 1.5, "5", True, None):
            self.assertIsNone(support.clean_amount(bad))

    def test_payment_body_shape(self):
        b = support.payment_body(1001, 5, True)
        self.assertEqual(set(b), {"user_id", "amount", "description", "idempotency_key", "test"})
        self.assertIs(b["test"], True)
        self.assertLessEqual(len(b["idempotency_key"]), 64)
        self.assertNotEqual(b["idempotency_key"], support.payment_body(1001, 5, True)["idempotency_key"])
        self.assertLessEqual(len(support.payment_body(1, 1, False, "x" * 500)["description"]), 200)

    def test_basic_header(self):
        self.assertEqual(support.basic_auth_header("a", "b"), "Basic YTpi")


if __name__ == "__main__":
    unittest.main()
