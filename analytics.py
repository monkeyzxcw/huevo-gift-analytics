"""Pure analytics over lots. Stdlib only.

All figures describe *current offers* and the app's own observations, never completed sales.
"""
from statistics import median

MIN_GROUP = 3           # need at least this many comparable offers
DEAL_DISCOUNT = 0.15    # at least 15% below the group's median
SUSPICIOUS_DISCOUNT = 0.80   # >80% below the median is more likely a pricing mistake than a deal


def _norm(value):
    return " ".join(str(value or "").lower().split())


def _key(lot):
    """Comparable = same normalized title and same normalized rarity (empty rarity matches empty)."""
    return (_norm(lot.get("title")), _norm(lot.get("rarity")))


def _valid_price(p):
    return isinstance(p, (int, float)) and not isinstance(p, bool) and p > 0


def percentile(sorted_values, q):
    """Linear-interpolated percentile (q in 0..1) of an already sorted list."""
    if not sorted_values:
        return None
    pos = (len(sorted_values) - 1) * q
    lo = int(pos)
    hi = min(lo + 1, len(sorted_values) - 1)
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (pos - lo)


def market_summary(prices):
    """Summary of offer prices (None/negative/non-numeric ignored)."""
    values = sorted(p for p in prices if isinstance(p, (int, float)) and not isinstance(p, bool) and p >= 0)
    if not values:
        return {"priced": 0, "min": None, "max": None, "avg": None, "median": None, "p25": None, "p75": None}
    return {"priced": len(values), "min": values[0], "max": values[-1],
            "avg": round(sum(values) / len(values), 2), "median": median(values),
            "p25": percentile(values, .25), "p75": percentile(values, .75)}


def price_bins(prices, bins=5):
    """Histogram that is not dominated by outliers.

    Bin edges span the 5th..95th percentile; cheaper/dearer outliers fall into the first/last bin,
    which are labelled open-ended. Returns [] when there are no prices.
    """
    values = sorted(p for p in prices if isinstance(p, (int, float)) and not isinstance(p, bool) and p >= 0)
    if not values:
        return []
    lo, hi = percentile(values, .05), percentile(values, .95)
    if hi <= lo:
        return [{"label": f"{values[0]:g}", "from": values[0], "to": values[-1], "count": len(values)}]
    step = (hi - lo) / bins
    edges = [lo + step * i for i in range(bins + 1)]
    out = [{"from": edges[i], "to": edges[i + 1], "count": 0} for i in range(bins)]
    for v in values:
        i = min(bins - 1, max(0, int((v - lo) // step))) if step else 0
        out[i]["count"] += 1
    for i, b in enumerate(out):
        a, z = f"{b['from']:.0f}", f"{b['to']:.0f}"
        b["label"] = f"≤ {z}" if i == 0 else f"> {a}" if i == bins - 1 else f"{a}–{z}"
    return out


def find_deals(lots, min_group=MIN_GROUP, discount=DEAL_DISCOUNT, limit=20):
    """Offers well below the median of comparable (title + rarity) active offers.

    A hint, not a valuation. Offers more than 80% below the median are flagged `suspicious`
    (likely a pricing mistake or a different item) and sorted after normal deals.
    """
    groups = {}
    for lot in lots:
        if _key(lot)[0] and _valid_price(lot.get("price")):
            groups.setdefault(_key(lot), []).append(lot)
    deals = []
    for group in groups.values():
        if len(group) < min_group:
            continue
        mid = median(l["price"] for l in group)
        for lot in group:
            if lot["price"] <= mid * (1 - discount):
                pct = round((1 - lot["price"] / mid) * 100, 1)
                deals.append({
                    "lot_id": lot.get("lot_id"), "title": lot.get("title"), "price": lot["price"], "median": mid,
                    "group_size": len(group), "discount_pct": pct, "suspicious": pct > SUSPICIOUS_DISCOUNT * 100,
                    "lot_url": lot.get("lot_url"), "image_url": lot.get("image_url"),
                    "serial": lot.get("serial"), "rarity": lot.get("rarity"),
                })
    deals.sort(key=lambda d: (d["suspicious"], -d["discount_pct"], d["price"]))
    return deals[:limit]


def best_value(active, gone, min_group=MIN_GROUP, limit=5):
    """Rank active offers by discount against a reference price.

    Reference, in order of preference:
      1. "gone": median of last known prices of comparable lots that left the market
         (probably sold, possibly delisted - the site does not say which), needs >= min_group;
      2. "active": median of comparable active offers, needs >= min_group.
    The basis is returned with every result so the UI never presents it as a confirmed sale price.
    """
    gone_prices, active_prices = {}, {}
    for lot in gone:
        if _key(lot)[0] and _valid_price(lot.get("price")):
            gone_prices.setdefault(_key(lot), []).append(lot["price"])
    for lot in active:
        if _key(lot)[0] and _valid_price(lot.get("price")):
            active_prices.setdefault(_key(lot), []).append(lot["price"])
    ranked = []
    for lot in active:
        k, price = _key(lot), lot.get("price")
        if not k[0] or not _valid_price(price):
            continue
        if len(gone_prices.get(k, [])) >= min_group:
            basis, ref, n = "gone", median(gone_prices[k]), len(gone_prices[k])
        elif len(active_prices.get(k, [])) >= min_group:
            basis, ref, n = "active", median(active_prices[k]), len(active_prices[k])
        else:
            continue
        if price >= ref:
            continue
        pct = round((1 - price / ref) * 100, 1)
        ranked.append({**{f: lot.get(f) for f in ("lot_id", "title", "price", "serial", "rarity", "lot_url", "image_url", "first_seen")},
                       "reference": ref, "basis": basis, "sample_size": n, "discount_pct": pct,
                       "suspicious": pct > SUSPICIOUS_DISCOUNT * 100})
    ranked.sort(key=lambda d: (d["suspicious"], d["basis"] != "gone", -d["discount_pct"], d["price"]))
    return ranked[:limit]
