"""Run the existing authorised Selenium crawler and export a public static snapshot.

Cookie values are read only from the environment and are never printed. A partial crawl or
Huevo access block fails closed: it does not replace the last good lot snapshot.
"""
import argparse
import json
import logging
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from analytics import best_value, find_deals, market_summary, price_bins, sales_by_title, sales_summary
from cookies import ALLOWED_HUEVO_HOSTS
from crawler import CrawlConfig, run_crawl
from snapshot import (SnapshotError, category_distribution, compare, is_duplicate_snapshot, migrate,
                      safe_write, snapshot_entry, top_expensive, validate, SCHEMA_VERSION)
from storage import Store, utcnow

OUT = ROOT / "cloudflare-site" / "data.json"
# Local-only cooldown memory (gitignored). data.json is restored by the scheduled .bat after a
# failed run, so the block time must not live only there.
STATE = ROOT / ".collector-state.json"
HISTORY_DB = ROOT / "history.db"
MIN_PUBLISHED_SALES = 20      # below this the sample is not confirmed enough to publish anything
LOG = logging.getLogger("huevo-static-collector")


def now_utc():
    return datetime.now(timezone.utc)


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat()


def load_previous():
    """Previous published snapshot, migrated to the current schema; {} if missing/corrupt/invalid."""
    try:
        data = json.loads(OUT.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict) or validate(migrate(data)):
        return {}
    return migrate(data)


def load_state():
    try:
        data = json.loads(STATE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(state):
    temp = STATE.with_suffix(".json.tmp")
    temp.write_text(json.dumps(state, ensure_ascii=False) + "\n", encoding="utf-8")
    temp.replace(STATE)


def active_cooldown(*sources):
    """Latest future `blocked_until` among the given dicts, as an aware datetime, else None."""
    latest = None
    for src in sources:
        value = (src or {}).get("blocked_until")
        if not value:
            continue
        try:
            until = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError:
            continue
        if until.tzinfo is None:
            until = until.replace(tzinfo=timezone.utc)
        if until > now_utc() and (latest is None or until > latest):
            latest = until
    return latest


def write_json(data):
    """Validated atomic write. Returns False (and leaves the published file untouched) if the
    payload is not publishable, e.g. an empty or structurally broken previous snapshot."""
    try:
        safe_write(OUT, data)
        return True
    except SnapshotError as exc:
        print(f"data.json не обновлён: проверка структуры не пройдена: {exc}", file=sys.stderr)
        return False


def sales_block():
    """Aggregate-only sales statistics from the local history.db, or None.

    Published only when `--with-sales` is given AND the local database holds at least
    MIN_PUBLISHED_SALES rows with a known price. No names, no per-sale rows, no invented dates.
    """
    if not HISTORY_DB.exists():
        return None
    store = Store(str(HISTORY_DB))
    rows = store.sales(limit=50000)
    summary = sales_summary([r.get("price") for r in rows])
    if summary["count"] < MIN_PUBLISHED_SALES:
        return None
    return {"summary": summary, "by_title": sales_by_title(rows), "generated_at": utcnow()}


def write_action_output(name, value):
    path = os.getenv("GITHUB_OUTPUT")
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(f"{name}={value}\n")


def make_browser(local_login=False, local_profile=False):
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options

    options = Options()
    if not local_login:
        for arg in ("--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
                    "--disable-gpu"):
            options.add_argument(arg)
    options.add_argument("--window-size=1440,1000")

    # Use the same browser User-Agent for cookie-based and manual-login runs.
    # Can be overridden through HUEVO_USER_AGENT; cookie values are never logged.
    user_agent = os.getenv(
        "HUEVO_USER_AGENT",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
    ).strip()
    if user_agent:
        options.add_argument(f"--user-agent={user_agent}")

    if local_login or local_profile:
        # Dedicated local-only Chrome profile: the Huevo session stays on this PC.
        # This directory is gitignored and is never uploaded or committed.
        profile = ROOT / ".local-huevo-chrome-profile"
        profile.mkdir(parents=True, exist_ok=True)
        options.add_argument(f"--user-data-dir={profile}")
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
    # The crawl runs against a fresh temporary database, so its first_seen is just "this run".
    # The real first observation is the one already published in the previous snapshot.
    if old.get("first_seen"):
        item["first_seen"] = old["first_seen"]
    history = list(old.get("history") or [])
    price = item.get("price")
    if price is not None and (not history or history[-1].get("price") != price):
        history.append({"observed_at": observed_at, "price": price})
    cutoff = now_utc() - timedelta(days=180)
    kept = []
    for point in history[-30:]:
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


def main(argv=None):
    parser = argparse.ArgumentParser(description="Collect Huevo market data into the public static snapshot.")
    parser.add_argument(
        "--local-login", action="store_true",
        help="Open visible Chrome on this PC and let the operator sign in manually; no cookie export required.",
    )
    parser.add_argument(
        "--local-profile", action="store_true",
        help="Use the saved local Chrome profile headlessly for scheduled runs; no cookie export required.",
    )
    parser.add_argument(
        "--with-sales", action="store_true",
        help="Also publish aggregate sales statistics from the local history.db (only if it has enough confirmed rows).",
    )
    args = parser.parse_args(argv)
    local_login = args.local_login
    local_profile = args.local_profile
    if local_login and local_profile:
        parser.error("Use either --local-login or --local-profile, not both.")
    local_session = local_login or local_profile

    previous = load_previous()
    cookies = "" if local_session else (
        os.getenv("HUEVO_COOKIES_JSON", "").strip()
        or os.getenv("HUEVO_COOKIES", "").strip()
    )
    if not local_session and not cookies:
        print("Missing GitHub secret HUEVO_COOKIES_JSON (or HUEVO_COOKIES). Use --local-login on your own PC instead.", file=sys.stderr)
        return 2

    old_collector = previous.get("collector") or {}
    until = active_cooldown(load_state(), old_collector if old_collector.get("status") == "blocked" else None)
    if until and not local_login:
        print(f"Huevo ограничил доступ ранее; пауза до {until.isoformat()}. Запрос к Huevo не отправляется.", file=sys.stderr)
        return 3
    if until and local_login:
        print(f"Внимание: пауза после ограничения Huevo действует до {until.isoformat()}. "
              "Вы запускаете сбор вручную и осознанно; при повторном ограничении пауза продлится.", file=sys.stderr)

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
            browser = make_browser(local_login=local_login, local_profile=local_profile)
            if local_login:
                print(f"Открываю отдельный Chrome-профиль на этом ПК: {base_url}")
                browser.get(base_url + "/")
                print("\nВ окне Chrome вручную войдите в Huevo. Не отправляйте cookies никому.")
                input("Когда каталог Huevo доступен в этом окне, вернитесь сюда и нажмите Enter для запуска сбора...")
                from urllib.parse import urlsplit
                current_host = (urlsplit(browser.current_url).hostname or "").lower()
                if current_host not in set(ALLOWED_HUEVO_HOSTS) | {"www." + h for h in ALLOWED_HUEVO_HOSTS}:
                    print("Chrome сейчас не на разрешённом домене Huevo; сбор отменён.", file=sys.stderr)
                    return 2
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
                save_state({"blocked_until": blocked_until, "http_status": result.http_status, "checked_at": iso(now)})
            previous["collector"] = {
                "status": status, "message": message, "blocked_until": blocked_until,
                "checked_at": iso(now), "pages": result.pages if result else 0,
                "lots": result.unique_lots if result else 0,
                "http_status": result.http_status if result else None,
            }
            # Keep the last good market payload while recording the failure/cooldown.
            if previous:
                write_json(previous)
            print(f"Snapshot not updated: {status}: {message}", file=sys.stderr)
            return 2

        save_state({})      # a complete pass clears any earlier cooldown
        observed_at = utcnow()
        current_rows = store.active_lots(priced_only=False)
        current_prices = [r["price"] for r in current_rows
                          if isinstance(r.get("price"), (int, float)) and r["price"] > 0]
        summary = market_summary(current_prices)
        old_lots = previous.get("lots") or []
        old_by_id = {str(row.get("lot_id")): row for row in old_lots if row.get("lot_id") is not None}
        lots = [snapshot_lot(row, old_by_id, observed_at) for row in current_rows]
        current_ids = {str(row["lot_id"]) for row in lots}

        # Match the production app's completeness guard before declaring older lots gone.
        previous_active_ids = {
            str(row["lot_id"]) for row in old_lots
            if row.get("lot_id") is not None and row.get("active", True)
        }
        missing_previous = previous_active_ids - current_ids
        seen_previous = len(previous_active_ids & current_ids)
        if len(missing_previous) >= 20 and seen_previous < (seen_previous + len(missing_previous)) * 0.5:
            previous["collector"] = {
                "status": "incomplete",
                "message": (f"Неполный проход: найдено только {seen_previous} из "
                            f"{len(previous_active_ids)} прежних активных лотов; старый снимок сохранён."),
                "blocked_until": None,
                "checked_at": observed_at,
                "pages": result.pages,
                "lots": len(lots),
                "http_status": result.http_status,
            }
            if previous:
                write_json(previous)
            print(previous.get("collector", {}).get("message", "incomplete"), file=sys.stderr)
            return 2

        gone_by_id = {}
        gone_fields = ("lot_id", "title", "serial", "rarity", "price", "status", "image_url", "lot_url", "first_seen", "last_seen", "active")
        for row in previous.get("gone_lots") or []:
            if row.get("lot_id") is not None:
                gone_by_id[str(row["lot_id"])] = {key: row.get(key) for key in gone_fields}
        for row in old_lots:
            lot_id = str(row.get("lot_id", ""))
            if lot_id and lot_id not in current_ids and row.get("active", True):
                gone = {key: row.get(key) for key in gone_fields}
                gone["active"] = False
                gone["status"] = "Не найден в последнем полном проходе"
                gone_by_id[lot_id] = gone
        gone_lots = list(gone_by_id.values())[-5000:]

        changes = compare([l for l in old_lots if l.get("active", True)], lots) if old_lots else None
        if changes:
            changes["since"] = (previous.get("generated_at") or None)
            changes["observed_at"] = observed_at
        snapshots = list(previous.get("snapshots") or [])
        if is_duplicate_snapshot(snapshots, lots, now_iso=observed_at):
            print("Состав лотов не изменился с прошлого снимка (<10 мин): новая точка истории не добавлена.")
        else:
            snapshots.append(snapshot_entry(observed_at, lots, summary, changes))
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
            "schema_version": SCHEMA_VERSION,
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
            "categories": category_distribution(lots),
            "top_expensive": top_expensive(lots),
            "changes": changes,
            "sales": (sales_block() if args.with_sales else None) or previous.get("sales"),
        }
        if not write_json(data):
            return 2
        write_action_output("deploy", "true")
        print(f"Snapshot created: {len(lots)} lots; pages={result.pages}; reached_end={result.reached_end}.")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
