import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from scripts.poll_first_page import poll_interval


class LivePollerConfigTests(unittest.TestCase):
    def setUp(self):
        self.previous = os.environ.get("HUEVO_LIVE_POLL_SECONDS")
        os.environ.pop("HUEVO_LIVE_POLL_SECONDS", None)

    def tearDown(self):
        if self.previous is None:
            os.environ.pop("HUEVO_LIVE_POLL_SECONDS", None)
        else:
            os.environ["HUEVO_LIVE_POLL_SECONDS"] = self.previous

    def test_default_is_three_seconds(self):
        self.assertEqual(poll_interval(), 3.0)

    def test_interval_is_clamped_to_at_least_three_seconds(self):
        os.environ["HUEVO_LIVE_POLL_SECONDS"] = "0.5"
        self.assertEqual(poll_interval(), 3.0)

    def test_interval_has_a_safe_upper_bound(self):
        os.environ["HUEVO_LIVE_POLL_SECONDS"] = "999"
        self.assertEqual(poll_interval(), 60.0)

    def test_invalid_interval_uses_default(self):
        os.environ["HUEVO_LIVE_POLL_SECONDS"] = "bad"
        self.assertEqual(poll_interval(), 3.0)


if __name__ == "__main__":
    unittest.main()
