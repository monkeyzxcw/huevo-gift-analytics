import unittest
from huevo_probe import access_block_status, classify_page, next_page_is_new

class ProbeTests(unittest.TestCase):
    def test_block_code(self):
        self.assertEqual(access_block_status("HTTP Error 418"), 418)

    def test_classification(self):
        result = classify_page(
            "https://huevo.su/market/gifts", "Маркет", "Каталог", 2,
            expected_hosts={"huevo.su"},
        )
        self.assertEqual(result["verdict"], "ok")

    def test_page_guard(self):
        self.assertFalse(next_page_is_new(["1", "2"], ["1", "2"]))

if __name__ == "__main__":
    unittest.main()
