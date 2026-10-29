import json, os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from cookies import is_huevo_host, load_cookie_export, selenium_cookie


class CookieTests(unittest.TestCase):
    def test_json_array_and_wrapped_object(self):
        arr = [{"name": "a", "value": "1", "expirationDate": 1900000000.5}]
        self.assertEqual(load_cookie_export(json.dumps(arr))[0]["expiry"], 1900000000.5)
        self.assertEqual(len(load_cookie_export(json.dumps({"cookies": arr}))), 1)

    def test_netscape_with_httponly(self):
        raw = "# Netscape\n#HttpOnly_.huevo.su\tTRUE\t/\tTRUE\t1900000000\tsid\tabc\n.huevo.su\tTRUE\t/\tFALSE\t0\tx\ty\n"
        out = load_cookie_export(raw)
        self.assertEqual([(c["name"], c["httpOnly"]) for c in out], [("sid", True), ("x", False)])

    def test_garbage_raises_and_empty_is_empty(self):
        with self.assertRaises(ValueError):
            load_cookie_export("not cookies at all")
        self.assertEqual(load_cookie_export("  "), [])

    def test_host_allowlist(self):
        self.assertTrue(is_huevo_host("sub.huevo.su"))
        self.assertTrue(is_huevo_host("HUEVO.SU."))
        self.assertFalse(is_huevo_host("evilhuevo.su"))
        self.assertFalse(is_huevo_host("huevo.su.evil.com"))

    def test_selenium_cookie_filters_and_normalizes(self):
        c = selenium_cookie({"name": "a", "value": "1", "domain": ".huevo.su", "expiry": "1900000000.7", "sameSite": "no_restriction", "junk": 1}, "huevo.su")
        self.assertEqual(c["expiry"], 1900000000)
        self.assertNotIn("sameSite", c)
        self.assertNotIn("junk", c)
        self.assertIsNone(selenium_cookie({"name": "a", "value": "1", "domain": "evil.com"}, "huevo.su"))


if __name__ == "__main__":
    unittest.main()
