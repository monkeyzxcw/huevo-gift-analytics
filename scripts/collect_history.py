"""Manual, local collection of CONFIRMED sales from https://huevo.su/market/history.

Uses the same dedicated local Chrome profile as the scheduled collector (session stays on this PC),
reads only a few pages (default 3; the history has hundreds), stops on any block/login/5xx and
shares the cooldown memory with collect_snapshot.py. Results go to a local SQLite file
(`history.db`, gitignored). Nothing is published; no seller/buyer names are stored.

    python scripts/collect_history.py --local-profile --pages 3
"""
import argparse
import logging
import os
import sys
from datetime import timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import collect_snapshot as snap
from analytics import sales_summary
from cookies import ALLOWED_HUEVO_HOSTS
from crawler import CrawlConfig, run_history_crawl
from storage import Store

DB = ROOT / "history.db"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--local-profile", action="store_true", required=True, help="Use the saved local Chrome profile (required).")
    parser.add_argument("--pages", type=int, default=3, help="History pages to read (1-20, default 3).")
    args = parser.parse_args(argv)
    pages = max(1, min(args.pages, 20))
    until = snap.active_cooldown(snap.load_state())
    if until:
        print(f"Huevo ограничил доступ ранее; пауза до {until.isoformat()}. Запрос не отправляется.", file=sys.stderr)
        return 3
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s %(message)s")
    store = Store(str(DB))
    store.migrate()
    browser = None
    try:
        browser = snap.make_browser(local_profile=True)
        config = CrawlConfig(base_url="https://huevo.su", allowed_hosts=ALLOWED_HUEVO_HOSTS, delay=max(3.0, float(os.getenv("CRAWL_DELAY", "3.0"))))
        result = run_history_crawl(browser, store, config, logging.getLogger("huevo-history"), max_pages=pages)
    except Exception as exc:
        print(f"Сбор истории не удался: {type(exc).__name__}", file=sys.stderr)
        return 2
    finally:
        if browser is not None:
            try:
                browser.quit()
            except Exception:
                pass
    print(f"{result.status}: {result.message}")
    if result.status == "blocked":
        wait = max(int(os.getenv("CRAWL_BLOCK_COOLDOWN_HOURS", "6")) * 3600, int(result.retry_after or 0))
        snap.save_state({"blocked_until": snap.iso(snap.now_utc() + timedelta(seconds=wait)), "http_status": result.http_status, "checked_at": snap.iso(snap.now_utc())})
        return 2
    if result.status != "ok":
        return 2
    summary = sales_summary([r["price"] for r in store.sales()])
    print(f"В базе подтверждённых сделок: {summary['count']} (цена неизвестна у {summary['unknown']}); медиана: {summary['median']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
