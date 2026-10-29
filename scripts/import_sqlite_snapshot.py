"""Import public catalog/history from a Render SQLite backup into the static snapshot.

Only reads lots, price_history, and market_snapshots. It deliberately does not export
support_payments, key/value runtime state, cookies, or any other internal tables.
"""
import argparse
import json
import sqlite3
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from analytics import best_value, find_deals, market_summary, price_bins
from storage import utcnow


PUBLIC_FIELDS = (
    "lot_id", "title", "serial", "rarity", "price", "status", "image_url",
    "lot_url", "first_seen", "last_seen", "active",
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", help="Path to a downloaded huevo.db backup (not committed to Git)")
    parser.add_argument("--output", default=str(ROOT / "cloudflare-site" / "data.json"),
                        help="Output JSON snapshot path")
    args = parser.parse_args()
    db_path = Path(args.database).expanduser().resolve()
    if not db_path.is_file():
        parser.error("SQLite backup file was not found: " + str(db_path))

    with sqlite3.connect(str(db_path)) as con:
        con.row_factory = sqlite3.Row
        tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        required = {"lots", "price_history", "market_snapshots"}
        missing = required - tables
        if missing:
            parser.error("Database is missing expected tables: " + ", ".join(sorted(missing)))

        lot_rows = [dict(r) for r in con.execute("SELECT * FROM lots ORDER BY lot_id")]
        history_rows = [dict(r) for r in con.execute(
            "SELECT lot_id, price, status, observed_at FROM price_history ORDER BY observed_at, id"
        )]
        snapshot_rows = [dict(r) for r in con.execute(
            "SELECT observed_at, source, active_lots, priced, min_price, max_price, avg_price, median_price "
            "FROM market_snapshots ORDER BY observed_at"
        )]

    history_by_id = defaultdict(list)
    for row in history_rows:
        history_by_id[str(row["lot_id"])].append({
            "observed_at": row.get("observed_at"),
            "price": row.get("price"),
            "status": row.get("status"),
        })

    lots, gone_lots = [], []
    for row in lot_rows:
        item = {key: row.get(key) for key in PUBLIC_FIELDS}
        item["lot_id"] = str(item["lot_id"])
        item["active"] = bool(item.get("active"))
        hist = history_by_id.get(item["lot_id"], [])
        item["history"] = hist[-30:]
        if item["active"]:
            lots.append(item)
        else:
            # Keep inactive comparison records small; they are not included in the live catalog.
            gone_lots.append({key: item.get(key) for key in PUBLIC_FIELDS})

    prices = [row["price"] for row in lots
              if isinstance(row.get("price"), (int, float)) and row["price"] > 0]
    summary = market_summary(prices)
    snapshots = []
    for row in snapshot_rows[-180:]:
        snapshots.append({
            "observed_at": row.get("observed_at"),
            "active_lots": row.get("active_lots"),
            "priced": row.get("priced"),
            "min_price": row.get("min_price"),
            "max_price": row.get("max_price"),
            "avg_price": row.get("avg_price"),
            "median_price": row.get("median_price"),
        })

    drops = []
    for lot in lots:
        hist = [p for p in (lot.get("history") or []) if isinstance(p.get("price"), (int, float))]
        if len(hist) >= 2:
            previous, latest = hist[-2], hist[-1]
            if previous["price"] > 0 and latest["price"] < previous["price"]:
                drops.append({
                    "lot_id": lot["lot_id"], "title": lot.get("title"), "price": latest["price"],
                    "previous_price": previous["price"],
                    "drop_pct": round((1 - latest["price"] / previous["price"]) * 100, 1),
                    "lot_url": lot.get("lot_url"), "image_url": lot.get("image_url"),
                    "changed_at": latest.get("observed_at"),
                })
    drops.sort(key=lambda row: row["drop_pct"], reverse=True)
    best = best_value(lots, gone_lots, limit=5)
    last_snapshot = snapshots[-1]["observed_at"] if snapshots else None
    generated_at = last_snapshot or utcnow()
    data = {
        "schema_version": 1,
        "generated_at": generated_at,
        "source": "https://huevo.su",
        "collector": {
            "status": "imported-db",
            "message": "Импортирована история из huevo.db. Для актуальных данных запустите GitHub Actions.",
            "blocked_until": None,
            "checked_at": generated_at,
            "pages": 0,
            "lots": len(lots),
            "http_status": None,
        },
        "stats": {"n_total": len(lots), **summary},
        "lots": lots,
        "gone_lots": gone_lots[-5000:],
        "snapshots": snapshots,
        "price_bins": price_bins(prices),
        "facets": {
            "statuses": sorted({str(x.get("status")) for x in lots if x.get("status")}),
            "rarities": sorted({str(x.get("rarity")) for x in lots if x.get("rarity")}),
        },
        "deals": find_deals(lots, limit=60),
        "best": best[0] if best else None,
        "runner_up": best[1:],
        "drops": drops[:100],
    }
    output = Path(args.output).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temp = output.with_suffix(output.suffix + ".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    temp.replace(output)
    print(f"Imported {len(lots)} active lots, {len(gone_lots)} inactive lots, and {len(snapshots)} market snapshots.")
    print("Only public catalog and price history were exported; payment records were not read.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
