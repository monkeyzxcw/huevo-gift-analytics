import unittest

from gift_history import classify_disappearance, delisted_event_record, merge_instance_record


class GiftHistoryTests(unittest.TestCase):
    def setUp(self):
        self.old = {"gift_id": "18336", "history_found": True,
                    "history": [{"event_id": "purchase-1", "type": "purchase"}]}

    def test_merge_is_append_only_and_returns_new_rows(self):
        fresh = {"gift_id": "18336", "history_found": True,
                 "history": [*self.old["history"], {"event_id": "sale-2", "type": "market_sale"}]}
        merged = merge_instance_record(self.old, fresh)
        self.assertEqual([e["event_id"] for e in merged["history"]], ["purchase-1", "sale-2"])
        self.assertEqual([e["event_id"] for e in merged["new_events"]], ["sale-2"])
        self.assertTrue(merged["history_delta_known"])

    def test_missing_history_does_not_erase_a_previous_history(self):
        merged = merge_instance_record(self.old, {"gift_id": "18336", "history_found": False, "history": []})
        self.assertTrue(merged["history_found"])
        self.assertEqual(merged["history"], self.old["history"])
        self.assertEqual(merged["new_events"], [])

    def test_classification_requires_a_previous_history_baseline(self):
        self.assertEqual(classify_disappearance({}, {"history_found": True, "history": []}), "history_baseline")
        self.assertEqual(classify_disappearance(self.old, {"history_found": False}), "pending_history")
        unchanged = merge_instance_record(self.old, {"history_found": True, "history": self.old["history"]})
        self.assertEqual(classify_disappearance(self.old, unchanged), "delisted")

    def test_sales_and_transfers_are_separate_from_delisting(self):
        sale = merge_instance_record(self.old, {"history_found": True,
            "history": [*self.old["history"], {"event_id": "sale-2", "type": "market_sale"}]})
        transfer = merge_instance_record(self.old, {"history_found": True,
            "history": [*self.old["history"], {"event_id": "transfer-2", "type": "transfer"}]})
        self.assertEqual(classify_disappearance(self.old, sale), "sold")
        self.assertEqual(classify_disappearance(self.old, transfer), "transferred")

    def test_later_non_sale_event_does_not_hide_a_new_sale(self):
        fresh = merge_instance_record(self.old, {"history_found": True, "history": [
            *self.old["history"],
            {"event_id": "sale-2", "type": "market_sale"},
            {"event_id": "other-3", "type": "unknown"},
        ]})
        self.assertEqual(classify_disappearance(self.old, fresh), "sold")

    def test_delisted_event_id_is_stable_for_one_disappearance(self):
        lot = {"lot_id": "101", "title": "Адидас-Тян Зеленая", "price": 500,
               "disappeared_at": "2026-10-31T12:00:00+00:00",
               "lot_url": "https://huevo.su/market/lot/101",
               "gift_instance": {"gift_id": "18336", "gift_url": "https://huevo.su/gift/18336",
                                 "serial": 4, "supply": 111}}
        first = delisted_event_record(lot, "2026-10-31T12:05:00+00:00")
        again = delisted_event_record(lot, "2026-10-31T12:15:00+00:00")
        self.assertEqual(first["event_id"], again["event_id"])
        self.assertEqual(first["label"], "Вероятно снят продавцом")
        self.assertEqual(first["serial"], "№ 4/111")


if __name__ == "__main__":
    unittest.main()
