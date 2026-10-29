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
