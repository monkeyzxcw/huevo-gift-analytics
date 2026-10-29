import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from analytics import find_deals, market_summary


def lot(i, title, price):
    return {"lot_id": str(i), "title": title, "price": price}


class SummaryTests(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(market_summary([])["priced"], 0)
        self.assertIsNone(market_summary([None, -5])["avg"])

    def test_values(self):
        s = market_summary([10, 30, None, 20])
        self.assertEqual((s["priced"], s["min"], s["max"], s["avg"], s["median"]), (3, 10, 30, 20.0, 20))


class DealsTests(unittest.TestCase):
    def test_cheap_lot_found_with_discount(self):
        deals = find_deals([lot(1, "Rose", 60), lot(2, "Rose", 100), lot(3, "Rose", 110), lot(4, "Rose", 120)])
        self.assertEqual([d["lot_id"] for d in deals], ["1"])
        self.assertEqual(deals[0]["median"], 105)
        self.assertAlmostEqual(deals[0]["discount_pct"], 42.9, places=1)

    def test_small_group_is_not_a_deal(self):
        self.assertEqual(find_deals([lot(1, "Rose", 10), lot(2, "Rose", 100)]), [])

    def test_titles_are_normalized_and_unpriced_ignored(self):
        deals = find_deals([lot(1, " rose ", 50), lot(2, "ROSE", 100), lot(3, "Rose", 100), lot(4, "Rose", None)])
        self.assertEqual([d["lot_id"] for d in deals], ["1"])

    def test_no_deal_when_prices_equal(self):
        self.assertEqual(find_deals([lot(i, "A", 100) for i in range(5)]), [])


if __name__ == "__main__":
    unittest.main()


class BestValueTests(unittest.TestCase):
    def test_uses_gone_lots_as_reference_when_available(self):
        from analytics import best_value
        active = [lot(1, "Rose", 70), lot(2, "Rose", 95)]
        gone = [lot(10, "Rose", 100), lot(11, "Rose", 110), lot(12, "Rose", 120)]
        res = best_value(active, gone)
        self.assertEqual([r["lot_id"] for r in res], ["1", "2"])
        self.assertEqual(res[0]["basis"], "gone")
        self.assertEqual(res[0]["reference"], 110)
        self.assertEqual(res[0]["sample_size"], 3)

    def test_falls_back_to_active_median_and_labels_it(self):
        from analytics import best_value
        res = best_value([lot(1, "Star", 50), lot(2, "Star", 100), lot(3, "Star", 100)], [])
        self.assertEqual(res[0]["basis"], "active")
        self.assertEqual(res[0]["lot_id"], "1")

    def test_needs_enough_evidence_and_skips_expensive(self):
        from analytics import best_value
        self.assertEqual(best_value([lot(1, "X", 10)], [lot(2, "X", 100)]), [])
        self.assertEqual(best_value([lot(1, "R", 500)], [lot(i, "R", 100) for i in range(3)]), [])

    def test_gone_basis_ranks_before_bigger_active_discount(self):
        from analytics import best_value
        active = [lot(1, "A", 80), lot(2, "B", 10), lot(3, "B", 100), lot(4, "B", 100)]
        gone = [lot(i + 20, "A", 100) for i in range(3)]
        res = best_value(active, gone)
        self.assertEqual(res[0]["lot_id"], "1")
        self.assertEqual(res[0]["basis"], "gone")


class RobustnessTests(unittest.TestCase):
    def test_rarity_separates_groups(self):
        from analytics import find_deals
        lots = [{"lot_id": str(i), "title": "Rose", "rarity": "Редкий", "price": 100} for i in range(3)]
        lots += [{"lot_id": "9", "title": "Rose", "rarity": "Обычный", "price": 10}]
        self.assertEqual(find_deals(lots), [])   # the cheap "Обычный" one has no comparable group

    def test_suspicious_flag_and_ordering(self):
        from analytics import find_deals
        lots = [lot(1, "A", 1), lot(2, "A", 100), lot(3, "A", 100), lot(4, "A", 110),
                lot(5, "B", 70), lot(6, "B", 100), lot(7, "B", 100)]
        deals = find_deals(lots)
        self.assertEqual([d["lot_id"] for d in deals], ["5", "1"])
        self.assertTrue(deals[1]["suspicious"] and not deals[0]["suspicious"])

    def test_bbooleans_zero_and_strings_ignored(self):
        from analytics import market_summary, find_deals
        self.assertEqual(market_summary([True, "5", None, 0, 10])["priced"], 2)
        self.assertEqual(find_deals([lot(1, "A", 0), lot(2, "A", True), lot(3, "A", "9")]), [])

    def test_price_bins_outlier_resistant(self):
        from analytics import price_bins
        bins = price_bins([10] * 20 + [11, 12, 13, 14, 15, 16, 17, 18, 100000])
        self.assertEqual(sum(b["count"] for b in bins), 29)
        self.assertTrue(bins[0]["label"].startswith("≤") and bins[-1]["label"].startswith(">"))
        self.assertEqual(price_bins([]), [])
        self.assertEqual(len(price_bins([5, 5, 5])), 1)

    def test_percentiles(self):
        from analytics import market_summary
        s = market_summary([1, 2, 3, 4, 5])
        self.assertEqual((s["median"], s["p25"], s["p75"]), (3, 2, 4))
