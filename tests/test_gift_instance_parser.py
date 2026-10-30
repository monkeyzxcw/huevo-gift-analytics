import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from gift_instance_parser import parse_gift_instance

FIX = os.path.join(ROOT, "tests", "fixtures")


class GiftInstanceParserTests(unittest.TestCase):
    def read(self, name):
        with open(os.path.join(FIX, name), encoding="utf-8") as handle:
            return handle.read()

    def test_parses_edition_drop_price_owner_and_history_events(self):
        result = parse_gift_instance(self.read("gift_instance_ok.html"), gift_id="18336",
                                     observed_at="2026-10-31T12:00:00+00:00")
        self.assertEqual(result["gift_id"], "18336")
        self.assertEqual(result["gift_url"], "https://huevo.su/gift/18336")
        self.assertEqual(result["title"], "Адидас-Тян Зеленая")
        self.assertEqual((result["serial"], result["supply"]), (4, 111))
        self.assertEqual(result["rarity"], "Лимитированный")
        self.assertEqual(result["author"], "hhiૐvi buritania XVII")
        self.assertEqual(result["drop_price"], 5555)
        self.assertTrue(result["edition_sold_out"])
        self.assertEqual(result["current_owner"], "monkeyzxcw")
        self.assertTrue(result["history_found"])
        self.assertEqual([e["type"] for e in result["history"]], ["purchase", "market_sale", "transfer"])
        self.assertEqual(result["history"][1]["from_user"], "monkeyzxcw")
        self.assertEqual(result["history"][1]["to_user"], "teeth")
        self.assertEqual(result["history"][2]["time_raw"], "вчера в 00:18")
        self.assertTrue(all("price" not in event for event in result["history"]))

    def test_event_ids_do_not_change_when_relative_day_labels_roll_over(self):
        html = self.read("gift_instance_ok.html")
        first = parse_gift_instance(html, gift_id="18336")
        second = parse_gift_instance(html.replace("вчера в 00:18", "сегодня в 00:18"), gift_id="18336")
        self.assertEqual(
            [event["event_id"] for event in first["history"]],
            [event["event_id"] for event in second["history"]],
        )

    def test_empty_history_card_is_a_valid_empty_history(self):
        html = '<div class="vk-card"><div class="vk-card-title">История <span>кто кому</span></div></div><h1 class="mg-gname">Подарок #7 из 20</h1>'
        result = parse_gift_instance(html, gift_id="7")
        self.assertTrue(result["history_found"])
        self.assertEqual(result["history"], [])

    def test_missing_history_is_not_reported_as_empty(self):
        result = parse_gift_instance("<h1 class='mg-gname'>Подарок #7 из 20</h1>", gift_id="7")
        self.assertFalse(result["history_found"])

    def test_rejects_invalid_gift_id_and_external_profile_hosts(self):
        self.assertIsNone(parse_gift_instance("<html></html>", gift_id="../7"))
        html = '<div class="vk-card"><div class="vk-card-title">История</div><div class="mg-hist"><span class="mg-hist-text">Продан в Маркете: <a href="https://evil.example/user">bad</a> → <a href="/safe">safe</a></span><span class="mg-hist-date">10:00</span></div></div>'
        result = parse_gift_instance(html, gift_id="8")
        self.assertEqual(result["history"][0]["from_user"], "bad")
        self.assertEqual(result["history"][0]["to_user"], "safe")


if __name__ == "__main__":
    unittest.main()
