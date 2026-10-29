import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from lot_parser import parse_cards, parse_price

FX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def fixture(name):
    with open(os.path.join(FX, name), encoding="utf-8") as f:
        return f.read()


class PriceTests(unittest.TestCase):
    def test_formats(self):
        for text, want in [("1 250 ◉", 1250), ("1 250", 1250), ("340", 340), ("12,5", 12.5), ("1.250.000", 1250000),
                           ("1,250", 1250), ("от 100 до 200", 100), ("", None), (None, None), ("нет цены", None), ("0", 0)]:
            self.assertEqual(parse_price(text), want, text)


class ParseFixtureTests(unittest.TestCase):
    def setUp(self):
        self.rows, self.links = parse_cards(fixture("market_page_ok.html"))
        self.by = {r["lot_id"]: r for r in self.rows}

    def test_valid_card_fields(self):
        r = self.by["101"]
        self.assertEqual((r["title"], r["rarity"], r["serial"], r["price"], r["status"]),
                         ("Золотая роза", "Редкий", "№ 17 / 500", 1250, "В продаже"))
        self.assertEqual(r["image_url"], "https://huevo.su/img/rose.webp")
        self.assertEqual(r["lot_url"], "https://huevo.su/market/lot/101")

    def test_mk_cards_preferred_over_nav_links(self):
        self.assertNotIn("999999", self.by)

    def test_missing_price_and_unknown_status(self):
        self.assertIsNone(self.by["103"]["price"])
        self.assertEqual(self.by["103"]["status"], "Скоро")
        self.assertEqual(self.by["102"]["status"], "Неизвестно")

    def test_duplicates_collapsed_first_wins(self):
        self.assertEqual(sum(1 for r in self.rows if r["lot_id"] == "101"), 1)
        self.assertEqual(self.by["101"]["title"], "Золотая роза")

    def test_foreign_host_link_rewritten_and_script_text_kept_as_text(self):
        r = self.by["104"]
        self.assertEqual(r["lot_url"], "https://huevo.su/market/lot/104")
        self.assertEqual(r["title"], "<script>alert(1)</script>")  # stored as text; the UI escapes it
        self.assertEqual(r["price"], 12.5)
        self.assertEqual(r["image_url"], "https://cdn.huevo.su/i/4.png")

    def test_non_https_image_dropped_and_price_not_glued(self):
        r = self.by["105"]
        self.assertEqual(r["image_url"], "")
        self.assertEqual(r["price"], 100)

    def test_ids_in_page_order(self):
        self.assertEqual([r["lot_id"] for r in self.rows], ["101", "102", "103", "104", "105"])


class ChangedMarkupTests(unittest.TestCase):
    def test_generic_fallback_when_mk_classes_disappear(self):
        rows, n = parse_cards(fixture("market_page_new_markup.html"))
        self.assertEqual(n, 1)
        self.assertEqual((rows[0]["lot_id"], rows[0]["price"], rows[0]["title"], rows[0]["status"]),
                         ("201", 456, "Fallback gift", "Продаётся"))

    def test_empty_page_and_garbage(self):
        self.assertEqual(parse_cards(fixture("market_page_empty.html")), ([], 0))
        self.assertEqual(parse_cards(""), ([], 0))
        self.assertEqual(parse_cards(None), ([], 0))

    def test_alternate_domain_base(self):
        rows, _ = parse_cards('<a class="mk-gcard" href="/market/lot/7"><div class="mk-price">5</div></a>', base_url="https://huevo.departament.site")
        self.assertEqual(rows[0]["lot_url"], "https://huevo.departament.site/market/lot/7")


if __name__ == "__main__":
    unittest.main()


class SanitizeLotTests(unittest.TestCase):
    def test_rejects_bad_ids_and_non_dicts(self):
        from lot_parser import sanitize_lot
        for bad in (None, "x", {"lot_id": "abc"}, {"lot_id": "1; DROP TABLE lots"}, {"lot_id": ""}, {"lot_id": "1" * 21}):
            self.assertIsNone(sanitize_lot(bad))

    def test_sanitizes_urls_price_and_lengths(self):
        from lot_parser import sanitize_lot
        row = sanitize_lot({"lot_id": 77, "title": "<script>alert(1)</script>" + "x" * 900, "price": "1 250 ⭐",
                            "image_url": "javascript:alert(1)", "lot_url": "https://evil.example/market/lot/77"})
        self.assertEqual(row["lot_id"], "77")
        self.assertEqual(len(row["title"]), 500)       # stored as text; the UI escapes it
        self.assertEqual(row["price"], 1250)
        self.assertEqual(row["image_url"], "")
        self.assertEqual(row["lot_url"], "https://huevo.su/market/lot/77")

    def test_price_edge_cases(self):
        from lot_parser import sanitize_lot
        self.assertIsNone(sanitize_lot({"lot_id": "1", "price": -5})["price"])
        self.assertIsNone(sanitize_lot({"lot_id": "1", "price": True})["price"])
        self.assertIsNone(sanitize_lot({"lot_id": "1", "price": float("nan")})["price"])
        self.assertEqual(sanitize_lot({"lot_id": "1", "price": 12.9})["price"], 12)
        self.assertEqual(sanitize_lot({"lot_id": "1", "lot_url": "https://huevo.departament.site/market/lot/1"})["lot_url"],
                         "https://huevo.departament.site/market/lot/1")
