import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from gift_detail_parser import parse_gift_detail

FIX = os.path.join(ROOT, "tests", "fixtures")


class GiftDetailParserTests(unittest.TestCase):
    def read(self, name):
        with open(os.path.join(FIX, name), encoding="utf-8") as handle:
            return handle.read()

    def test_extracts_whitelisted_gift_attributes(self):
        result = parse_gift_detail(self.read("gift_detail_ok.html"), lot_id="101",
                                   observed_at="2026-10-30T00:00:00+00:00")
        self.assertEqual(result["title"], "Золотая роза")
        self.assertEqual(result["attributes"], {
            "model": "Королевская", "backdrop": "Изумрудный", "symbol": "Корона",
            "pattern": "Волны", "rarity": "Редкий", "serial": "№ 17", "supply": "500"
        })
        self.assertEqual(result["image_url"], "https://huevo.su/static/rose.webp")
        self.assertEqual(result["checked_at"], "2026-10-30T00:00:00+00:00")
        self.assertNotIn("private_user_name", repr(result))

    def test_data_attribute_fallback_and_no_personal_fields(self):
        html = '<main data-model="Classic" data-backdrop="Blue" data-symbol="Star"><h1>Gift</h1><p>Owner: somebody</p></main>'
        result = parse_gift_detail(html, lot_id="77")
        self.assertEqual(result["attributes"], {"model": "Classic", "backdrop": "Blue", "symbol": "Star"})
        self.assertNotIn("somebody", repr(result))

    def test_discovers_the_current_instance_not_the_author_badge(self):
        html = """<h1>Адидас-Тян Зеленая</h1>
        <div class="ga-line"><a class="hue-gbadge" href="/gift/13678"
          data-tip="Это коллекционный подарок «BLOOD BAG», №1 из 100.">badge</a></div>
        <div class="mg-r"><span>Владелец</span><span>
          <a class="hue-gbadge" href="/gift/18336"
          data-tip="Это коллекционный подарок «Адидас-Тян Зеленая», №4 из 111.">badge</a>
        </span></div>"""
        result = parse_gift_detail(html, lot_id="101")
        self.assertEqual(result["gift_id"], "18336")
        self.assertEqual(result["gift_url"], "https://huevo.su/gift/18336")

    def test_invalid_id_and_empty_markup_are_rejected(self):
        self.assertIsNone(parse_gift_detail("<html><body>Вход</body></html>", lot_id="not-an-id"))
        self.assertIsNone(parse_gift_detail("<html><body></body></html>", lot_id="123"))

    def test_rejects_untrusted_image_urls(self):
        html = '<meta property="og:title" content="Gift"><meta property="og:image" content="https://evil.example/gift.png">'
        result = parse_gift_detail(html, lot_id="88")
        self.assertEqual(result["image_url"], "")


if __name__ == "__main__":
    unittest.main()
