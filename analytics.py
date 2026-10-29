"""Pure analytics over lots. Stdlib only.

All figures describe *current offers*, never completed sales.
"""
from statistics import median

MIN_GROUP = 3          # need at least this many same-title offers to call something a deal
DEAL_DISCOUNT = 0.15   # at least 15% below the group's median


def market_summary(prices):
    """Summary of a list of offer prices (None/negative values ignored)."""
    values = sorted(p for p in prices if isinstance(p, (int, float)) and p >= 0)
    if not values:
        return {"priced": 0, "min": None, "max": None, "avg": None, "median": None}
    return {"priced": len(values), "min": values[0], "max": values[-1],
            "avg": round(sum(values) / len(values), 2), "median": median(values)}


def find_deals(lots, min_group=MIN_GROUP, discount=DEAL_DISCOUNT, limit=20):
    """Offers priced well below the median of same-title active offers.

    Grouping is by normalized title only, so it ignores serial/rarity differences;
    callers must present the result as a hint, not as a valuation.
    """
    groups = {}
    for lot in lots:
        price = lot.get("price")
        title = " ".join(str(lot.get("title") or "").lower().split())
        if not title or not isinstance(price, (int, float)) or price <= 0:
            continue
        groups.setdefault(title, []).append(lot)
    deals = []
    for group in groups.values():
        if len(group) < min_group:
            continue
        mid = median(l["price"] for l in group)
        for lot in group:
            if lot["price"] <= mid * (1 - discount):
                deals.append({
                    "lot_id": lot.get("lot_id"), "title": lot.get("title"),
                    "price": lot["price"], "median": mid, "group_size": len(group),
                    "discount_pct": round((1 - lot["price"] / mid) * 100, 1),
                    "lot_url": lot.get("lot_url"), "image_url": lot.get("image_url"),
                    "serial": lot.get("serial"), "rarity": lot.get("rarity"),
                })
    deals.sort(key=lambda d: (-d["discount_pct"], d["price"]))
    return deals[:limit]
