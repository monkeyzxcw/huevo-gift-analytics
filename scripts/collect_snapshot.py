"""Run the existing authorised Selenium crawler and export a public static snapshot.

Cookie values are read only from the environment and are never printed. A partial crawl or
Huevo access block fails closed: it does not replace the last good lot snapshot.
"""
import json
import logging
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from analytics import best_value, find_deals, market_summary, price_bins
from cookies import ALLOWED_HUEVO_HOSTS
from crawler import CrawlConfig, run_crawl
from storage import Store, utcnow

OUT = ROOT / "cloudflare-site" / "data.json"
LOG = logging.getLogger("huevo-static-collector")


def now_utc():
    return datetime.now(timezone.utc)


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat()


def load_previous():
    try:
        data = json.loads(OUT.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def write_json(data):
    OUT.parent.mkdir(parents=True, exist_ok=True)
    temp = OUT.with_suffix(".json.tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    temp.replace(OUT)


def write_action_output(name, value):
    path = os.getenv("GITHUB_OUTPUT")
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(f"{name}={value}\n")


def make_browser():
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options

    options = Options()
    for arg in ("--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
                "--disable-gpu", "--window-size=1440,1000"):
        options.add_argument(arg)
    options.set_capability("goog:loggingPrefs", {"performance": "ALL"})
    options.add_experimental_option("perfLoggingPrefs", {"enableNetwork": True})
    binary = os.getenv("CHROME_BIN")
    if binary:
        options.binary_location = binary
    browser = webdriver.Chrome(options=options)
    browser.set_page_load_timeout(30)
    return browser


def snapshot_lot(row, old_by_id, observed_at):
    item = {key: row.get(key) for key in (
        "lot_id", "title", "serial", "rarity", "price", "status", "image_url",
        "lot_url", "first_seen", "last_seen"
    )}
    item["active"] = True
    old = old_by_id.get(str(item["lot_id"]), {})
    history = list(old.get("history") or [])
    price = item.get("price")
    if price is not None and (not history or history[-1].get("price") != price):
        history.append({"observed_at": observed_at, "price": price})
    cutoff = now_utc() - timedelta(days=180)
    kept = []
    for point in history[-100:]:
        try:
            date = datetime.fromisoformat(str(point.get("observed_at", "")).replace("Z", "+00:00"))
            if date.tzinfo is None:
                date = date.replace(tzinfo=timezone.utc)
            if date >= cutoff:
                kept.append(point)
        except (ValueError, TypeError):
            continue
    item["history"] = kept
    return item


def main():
    previous = load_previous()
    cookies = (os.getenv("HUEVO_COOKIES_JSON", "").strip()
               or os.getenv("HUEVO_COOKIES", "").strip())
    if not cookies:
        print("Missing GitHub secret HUEVO_COOKIES_JSON (or HUEVO_COOKIES).", file=sys.stderr)
        return 2

    old_collector = previous.get("collector") or {}
    if old_collector.get("status") == "blocked" and old_collector.get("blocked_until"):
        try:
            until = datetime.fromisoformat(old_collector["blocked_until"].replace("Z", "+00:00"))
            if until > now_utc():
                print("Collector cooldown is still active; no request sent to Huevo.")
                return 3
        except (ValueError, TypeError):
            pass

    base_url = os.getenv("HUEVO_BASE_URL", "https://huevo.su").strip().rstrip("/")
    if base_url not in ("https://huevo.su", "https://huevo.departament.site"):
        print("HUEVO_BASE_URL must be an approved Huevo HTTPS host.", file=sys.stderr)
        return 2
    delay = max(2.0, min(float(os.getenv("CRAWL_DELAY", "2.0")), 30.0))
    max_pages = max(1, min(int(os.getenv("MAX_PAGES", "500")), 500))
    cooldown_hours = max(1, min(int(os.getenv("CRAWL_BLOCK_COOLDOWN_HOURS", "6")), 168))

    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    logging.getLogger("selenium").setLevel(logging.WARNING)

    with tempfile.TemporaryDirectory(prefix="huevo-collector-") as workdir:
        store = Store(str(Path(workdir) / "huevo.db"))
        store.migrate()
        browser = None
        try:
            browser = make_browser()
            config = CrawlConfig(
                base_url=base_url, allowed_hosts=ALLOWED_HUEVO_HOSTS,
                delay=delay, max_pages=max_pages, cookies_raw=cookies,
            )
            result = run_crawl(browser, store, config, LOG)
        except Exception as exc:
            LOG.error("collector failed: %s", type(exc).__name__)
            result = None
            error = type(exc).__name__
        else:
            error = None
        finally:
            if browser is not None:
                try:
                    browser.quit()
                except Exception:
                    pass

        if result is None or result.status != "ok" or not result.reached_end:
            now = now_utc()
            blocked_until = None
            status = result.status if result is not None else "error"
            message = result.message if result is not None else f"Ошибка запуска: {error}"
            if result is not None and result.status == "blocked":
                wait_seconds = max(cooldown_hours * 3600, int(result.retry_after or 0))
                blocked_until = iso(now + timedelta(seconds=wait_seconds))
            previous["collector"] = {
                "status": status, "message": message, "blocked_until": blocked_until,
                "checked_at": iso(now), "pages": result.pages if result else 0,
                "lots": result.unique_lots if result else 0,
                "http_status": result.http_status if result else None,
            }
            # Keep the last good market payload while recording the failure/cooldown.
            write_json(previous)
            print(f"Snapshot not updated: {status}: {message}", file=sys.stderr)
            return 2

        observed_at = utcnow()
        current_rows = store.active_lots(priced_only=False)
        current_prices = [r["price"] for r in current_rows
                          if isinstance(r.get("price"), (int, float)) and r["price"] > 0]
        summary = market_summary(current_prices)
        old_lots = previous.get("lots") or []
        old_by_id = {str(row.get("lot_id")): row for row in old_lots if row.get("lot_id") is not None}
        lots = [snapshot_lot(row, old_by_id, observed_at) for row in current_rows]
        current_ids = {str(row["lot_id"]) for row in lots}

        gone_by_id = {}
        for row in previous.get("gone_lots") or []:
            if row.get("lot_id") is not None:
                gone_by_id[str(row["lot_id"])] = row
        for row in old_lots:
            lot_id = str(row.get("lot_id", ""))
            if lot_id and lot_id not in current_ids and row.get("active", True):
                gone = dict(row)
                gone["active"] = False
                gone["status"] = "Не найден в последнем полном проходе"
                gone_by_id[lot_id] = gone
        gone_lots = list(gone_by_id.values())[-5000:]

        snapshots = list(previous.get("snapshots") or [])
        snapshots.append({
            "observed_at": observed_at,
            "active_lots": len(lots),
            "priced": summary["priced"],
            "min_price": summary["min"],
            "max_price": summary["max"],
            "avg_price": summary["avg"],
            "median_price": summary["median"],
        })
        snapshots = snapshots[-180:]

        drops = []
        for lot in lots:
            hist = lot.get("history") or []
            if len(hist) >= 2:
                old_price, new_price = hist[-2].get("price"), hist[-1].get("price")
                if isinstance(old_price, (int, float)) and old_price > 0 and isinstance(new_price, (int, float)) and new_price < old_price:
                    drops.append({
                        "lot_id": lot["lot_id"], "title": lot["title"], "price": new_price,
                        "previous_price": old_price,
                        "drop_pct": round((1 - new_price / old_price) * 100, 1),
                        "lot_url": lot["lot_url"], "image_url": lot["image_url"],
                        "changed_at": hist[-1]["observed_at"],
                    })
        drops.sort(key=lambda row: row["drop_pct"], reverse=True)

        deals = find_deals(lots, limit=60)
        best = best_value(lots, gone_lots, limit=5)
        facets = {
            "statuses": sorted({str(r.get("status") or "") for r in lots if r.get("status")}),
            "rarities": sorted({str(r.get("rarity") or "") for r in lots if r.get("rarity")}),
        }
        data = {
            "schema_version": 1,
            "generated_at": observed_at,
            "source": base_url,
            "collector": {
                "status": "ok",
                "message": result.message,
                "blocked_until": None,
                "checked_at": observed_at,
                "pages": result.pages,
                "lots": len(lots),
                "http_status": result.http_status,
            },
            "stats": {"n_total": len(lots), **summary},
            "lots": lots,
            "gone_lots": gone_lots,
            "snapshots": snapshots,
            "price_bins": price_bins(current_prices),
            "facets": facets,
            "deals": deals,
            "best": best[0] if best else None,
            "runner_up": best[1:],
            "drops": drops[:100],
        }
        write_json(data)
        write_action_output("deploy", "true")
        print(f"Snapshot created: {len(lots)} lots; pages={result.pages}; reached_end={result.reached_end}.")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
