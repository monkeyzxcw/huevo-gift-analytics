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
from crawler import CrawlConfig, run_crawl, run_gift_detail_crawl, run_gift_instance_crawl
from gift_history import (classify_disappearance, delisted_event_record, history_event_record,
                          merge_instance_record)
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


def retention_hours():
    """How long to remember gone lots and price/market history (default 30 days, 1..720)."""
    try:
        return max(1, min(int(os.getenv("HUEVO_RETENTION_HOURS", "720")), 720))
    except ValueError:
        return 720


def parse_ts(value):
    try:
        dt = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def is_recent(value, cutoff):
    """True only for a parseable timestamp not older than cutoff; unknown dates are dropped."""
    dt = parse_ts(value)
    return dt is not None and dt >= cutoff


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
    default_user_agent = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"
    )
    configured_user_agent = os.getenv("HUEVO_USER_AGENT", "").strip()
    # A copied Chrome profile is bound to the real browser/OS; do not force a synthetic
    # User-Agent over it unless explicitly configured.
    cloned_profile = bool(os.getenv("HUEVO_CHROME_PROFILE", "").strip())
    user_agent = configured_user_agent or ("" if cloned_profile else default_user_agent)
    LOG.info("browser user-agent source=%s", "HUEVO_USER_AGENT secret" if configured_user_agent else
             ("cloned Chrome profile" if cloned_profile else "built-in fallback"))
    if user_agent:
        options.add_argument(f"--user-agent={user_agent}")

    if local_login or local_profile:
        # Dedicated local-only Chrome profile: never upload/commit this directory.
        profile = ROOT / ".local-huevo-chrome-profile"
        profile.mkdir(parents=True, exist_ok=True)
        options.add_argument(f"--user-data-dir={profile}")
        profile_name = os.getenv("HUEVO_CHROME_PROFILE", "").strip()
        if profile_name:
            options.add_argument(f"--profile-directory={profile_name}")
    options.set_capability("goog:loggingPrefs", {"performance": "ALL"})
    options.add_experimental_option("perfLoggingPrefs", {"enableNetwork": True})
    binary = os.getenv("CHROME_BIN")
    if binary:
        options.binary_location = binary
    browser = webdriver.Chrome(options=options)
    browser.set_page_load_timeout(30)
    return browser


def snapshot_lot(row, old_by_id, observed_at, gift_details=None):
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
    cutoff = now_utc() - timedelta(hours=retention_hours())
    item["history"] = [point for point in history[-200:]
                       if is_recent(point.get("observed_at"), cutoff)]
    cached_details = gift_details or old.get("gift_details")
    if isinstance(cached_details, dict):
        item["gift_details"] = cached_details
    if isinstance(old.get("gift_instance"), dict):
        item["gift_instance"] = old["gift_instance"]
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
    parser.add_argument("--detail-limit", type=int,
                        default=max(0, min(int(os.getenv("HUEVO_DETAIL_LIMIT", "8")), 50)),
                        help="Maximum /market/lot pages inspected after a complete pass (0 disables).")
    parser.add_argument("--instance-limit", type=int,
                        default=max(0, min(int(os.getenv("HUEVO_INSTANCE_LIMIT", "8")), 30)),
                        help="Maximum unique /gift/<id> instance-history pages inspected per pass (0 disables).")
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
            details_result = {"details": {}, "status": "skipped", "pages": 0,
                              "message": "Каталог не прошёл полный сбор; карточки не запрашивались."}
            instance_result = {"instances": {}, "status": "skipped", "pages": 0,
                               "message": "Истории экземпляров не запрашивались."}
            if result.status == "ok" and result.reached_end:
                old_detail_index = {
                    str(row.get("lot_id")): row for row in
                    [*(previous.get("lots") or []), *(previous.get("gone_lots") or [])]
                    if row.get("lot_id") is not None
                }
                active_rows_for_enrichment = store.active_lots(priced_only=False)
                active_ids_for_enrichment = {str(row.get("lot_id")) for row in active_rows_for_enrichment}
                missing_rows_for_enrichment = []
                for old_row in previous.get("lots") or []:
                    old_id = str(old_row.get("lot_id") or "")
                    if not old_id or old_id in active_ids_for_enrichment or not old_row.get("active", True):
                        continue
                    missing = dict(old_row)
                    missing["active"] = True
                    old_detail = old_row.get("gift_details") if isinstance(old_row.get("gift_details"), dict) else {}
                    checked = parse_ts(old_detail.get("checked_at"))
                    missing["_force_detail_check"] = not old_detail.get("gift_id") and (
                        checked is None or (now_utc() - checked) >= timedelta(days=7))
                    missing_rows_for_enrichment.append(missing)

                # Older disappeared lots without a discovered gift page are retried weekly,
                # not on every poll. All disappeared rows are prioritised before active ones.
                pending_gone_details = []
                for old_row in previous.get("gone_lots") or []:
                    old_detail = old_row.get("gift_details") if isinstance(old_row.get("gift_details"), dict) else {}
                    checked = parse_ts(old_detail.get("checked_at"))
                    if (not old_detail.get("gift_id")
                            and (checked is None or (now_utc() - checked) >= timedelta(days=7))):
                        pending = dict(old_row)
                        pending["active"] = True
                        pending["_force_detail_check"] = True
                        pending_gone_details.append(pending)

                detail_candidates = missing_rows_for_enrichment + pending_gone_details + active_rows_for_enrichment
                try:
                    details_result = run_gift_detail_crawl(
                        browser, config, detail_candidates, old_detail_index,
                        LOG, limit=args.detail_limit, max_age_days=60,
                    )
                except Exception as detail_error:
                    LOG.warning("gift detail pass skipped: %s", type(detail_error).__name__)
                    details_result = {"details": {}, "status": "error", "pages": 0,
                                      "message": "Дополнительный анализ карточек не удался; основной каталог сохранён."}

                # Build a small queue of unique gift pages. A vanished market lot forces a
                # history check; otherwise recently checked instances stay cached.
                detail_updates = details_result.get("details") or {}
                instance_candidates = []
                for row in active_rows_for_enrichment:
                    lot_id = str(row.get("lot_id") or "")
                    old_row = old_detail_index.get(lot_id) or {}
                    details = detail_updates.get(lot_id) or old_row.get("gift_details") or {}
                    if details.get("gift_id"):
                        instance_candidates.append({
                            **row, "gift_details": details,
                            "gift_instance": old_row.get("gift_instance") or {},
                        })
                for row in missing_rows_for_enrichment:
                    lot_id = str(row.get("lot_id") or "")
                    old_row = old_detail_index.get(lot_id) or row
                    details = detail_updates.get(lot_id) or old_row.get("gift_details") or {}
                    if details.get("gift_id"):
                        instance_candidates.append({
                            **row, "gift_details": details,
                            "gift_instance": old_row.get("gift_instance") or {},
                            "_force_history_check": True,
                        })
                for row in previous.get("gone_lots") or []:
                    lot_id = str(row.get("lot_id") or "")
                    details = detail_updates.get(lot_id) or row.get("gift_details") or {}
                    if details.get("gift_id"):
                        instance_candidates.append({
                            **row, "gift_details": details,
                            "gift_instance": row.get("gift_instance") or {},
                            "_force_history_check": row.get("disappearance_status") in
                                (None, "", "pending_history", "history_baseline"),
                        })
                try:
                    instance_result = run_gift_instance_crawl(
                        browser, config, instance_candidates, LOG,
                        limit=args.instance_limit, max_age_days=30,
                    )
                except Exception as instance_error:
                    LOG.warning("gift instance history pass skipped: %s", type(instance_error).__name__)
                    instance_result = {"instances": {}, "status": "error", "pages": 0,
                                       "message": "Проверка истории экземпляров не удалась; рыночный снимок сохранён."}
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

        # A complete catalog pass clears prior cooldown, unless the optional detail crawl itself hit a block.
        if details_result.get("status") == "blocked":
            detail_pause = max(cooldown_hours * 3600, int(details_result.get("retry_after") or 0))
            save_state({"blocked_until": iso(now_utc() + timedelta(seconds=detail_pause)),
                        "http_status": details_result.get("http_status"), "checked_at": iso(now_utc()),
                        "source": "gift_detail"})
        else:
            save_state({})
        observed_at = utcnow()
        current_rows = store.active_lots(priced_only=False)
        current_prices = [r["price"] for r in current_rows
                          if isinstance(r.get("price"), (int, float)) and r["price"] > 0]
        summary = market_summary(current_prices)
        old_lots = previous.get("lots") or []
        old_by_id = {str(row.get("lot_id")): row for row in old_lots if row.get("lot_id") is not None}
        new_details = details_result.get("details") or {}
        lots = [snapshot_lot(row, old_by_id, observed_at, new_details.get(str(row.get("lot_id"))))
                for row in current_rows]
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
        gone_fields = (
            "lot_id", "title", "serial", "rarity", "price", "status", "image_url",
            "lot_url", "first_seen", "last_seen", "active", "gift_details", "gift_instance",
            "disappearance_status", "disappeared_at", "history_checked_at",
        )
        for row in previous.get("gone_lots") or []:
            if row.get("lot_id") is not None:
                gone_by_id[str(row["lot_id"])] = {key: row.get(key) for key in gone_fields}
        for row in old_lots:
            lot_id = str(row.get("lot_id", ""))
            if lot_id and lot_id not in current_ids and row.get("active", True):
                gone = {key: row.get(key) for key in gone_fields}
                gone["active"] = False
                gone["status"] = "Не найден в последнем полном проходе"
                gone["disappeared_at"] = observed_at
                gone["disappearance_status"] = "pending_history"
                gone["history_checked_at"] = None
                if new_details.get(lot_id):
                    gone["gift_details"] = new_details[lot_id]
                gone_by_id[lot_id] = gone

        # A just-disappeared item is checked even if other market pages remain cached.
        for lot_id, row in gone_by_id.items():
            if new_details.get(lot_id):
                row["gift_details"] = new_details[lot_id]
        keep_after = now_utc() - timedelta(hours=retention_hours())
        gone_lots = [row for row in gone_by_id.values()
                     if is_recent(row.get("last_seen"), keep_after)][-5000:]

        # Merge newly fetched /gift/<id> pages into both active and gone market rows.
        fetched_instances = instance_result.get("instances") or {}
        catalog_events = list(previous.get("catalog_events") or [])
        known_catalog_event_ids = {str(item.get("event_id")) for item in catalog_events if item.get("event_id")}
        newly_detected_events = []

        def apply_instance(row, is_gone=False):
            details = row.get("gift_details") if isinstance(row.get("gift_details"), dict) else {}
            gift_id = str(details.get("gift_id") or "")
            if not gift_id:
                return
            old_instance = row.get("gift_instance") if isinstance(row.get("gift_instance"), dict) else {}
            fresh_instance = fetched_instances.get(gift_id)
            merged = merge_instance_record(old_instance, fresh_instance) if fresh_instance else old_instance
            if merged:
                row["gift_instance"] = merged
            if fresh_instance and fresh_instance.get("history_found"):
                row["history_checked_at"] = fresh_instance.get("checked_at")
            if is_gone and fresh_instance:
                row["disappearance_status"] = classify_disappearance(old_instance, merged)
            elif is_gone and not row.get("disappearance_status"):
                row["disappearance_status"] = "pending_history"

            # The first history read is a baseline, not a newly observed market event.
            if fresh_instance and fresh_instance.get("history_found") and old_instance.get("history_found"):
                for event in merged.get("new_events") or []:
                    record = history_event_record(row, event, observed_at)
                    if record and record["event_id"] not in known_catalog_event_ids:
                        known_catalog_event_ids.add(record["event_id"])
                        newly_detected_events.append(record)
            if is_gone and row.get("disappearance_status") == "delisted":
                record = delisted_event_record(row, observed_at)
                if record and record["event_id"] not in known_catalog_event_ids:
                    known_catalog_event_ids.add(record["event_id"])
                    newly_detected_events.append(record)

        for row in lots:
            apply_instance(row, is_gone=False)
        for row in gone_lots:
            apply_instance(row, is_gone=True)

        catalog_events.extend(newly_detected_events)
        catalog_events = catalog_events[-1000:]

        changes = compare([l for l in old_lots if l.get("active", True)], lots) if old_lots else None
        if changes:
            changes["since"] = (previous.get("generated_at") or None)
            changes["observed_at"] = observed_at
        snapshots = list(previous.get("snapshots") or [])
        if is_duplicate_snapshot(snapshots, lots, now_iso=observed_at):
            print("Состав лотов не изменился с прошлого снимка (<10 мин): новая точка истории не добавлена.")
        else:
            snapshots.append(snapshot_entry(observed_at, lots, summary, changes))
        snapshots = [row for row in snapshots
                      if is_recent(row.get("observed_at"), keep_after)][-1000:]

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
                "gift_details": {
                    "status": details_result.get("status", "skipped"),
                    "pages": details_result.get("pages", 0),
                    "updated": len(new_details),
                    "message": details_result.get("message", ""),
                },
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
