"""Server-side crawl engine. Selenium is only touched through the injected `browser` object,
so the loop can be tested with a fake browser. It never retries a blocked/failed page and
only reports `reached_end` when a normal page after page 1 has no new lots.

Nothing here bypasses protection: on 403/418/429 (or a login/challenge page) it stops.
"""
import time
from dataclasses import dataclass, field

from cookies import selenium_cookie, load_cookie_export
from huevo_probe import (classify_network_error, classify_page, main_response, parse_perf_log,
                         next_page_is_new, VERDICT_HINTS)
from lot_parser import parse_cards
from storage import utcnow


@dataclass
class CrawlConfig:
    base_url: str = "https://huevo.su"
    allowed_hosts: tuple = ("huevo.su", "huevo.departament.site")
    delay: float = 2.0
    max_pages: int = 500
    ready_timeout: float = 20.0
    settle: float = 1.5
    network_retries: int = 2        # bounded retries, only for transient timeout/connect errors
    retry_backoff: float = 5.0
    cookies_raw: str = ""
    sleep: callable = field(default=time.sleep, repr=False)


@dataclass
class CrawlResult:
    status: str                 # ok | blocked | login | no_cards | network_error | server_error | error
    message: str
    pages: int = 0
    unique_lots: int = 0
    new_lots: int = 0
    changed_lots: int = 0
    reached_end: bool = False
    http_status: int = None
    status_source: str = None   # network | inferred
    retry_after: int = None
    cause: str = None
    stop_reason: str = ""


def _hosts(cfg):
    return set(cfg.allowed_hosts) | {"www." + h for h in cfg.allowed_hosts}


def _wait_ready(browser, timeout, sleep):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        # "interactive" is sufficient to inspect the already parsed DOM; waiting
        # for every late resource can hang on a market page indefinitely.
        if browser.execute_script("return document.readyState") in ("interactive", "complete"):
            return True
        sleep(0.2)
    return False


def observe(browser, cfg, path, parser=None):
    """Load `path`, return (probe dict, rows, link_count, network_failures).

    `parser(html) -> (rows, count)` defaults to the catalog card parser.
    """
    try:
        browser.get(cfg.base_url + path)
    except Exception as exc:
        # A Selenium page-load timeout can occur after the DOM has already
        # navigated to Huevo. Inspect that page before classifying it as a network
        # failure; non-timeout navigation errors still stop immediately.
        message = str(exc).lower()
        is_timeout = "timeout" in message or "timed out" in message
        if not is_timeout:
            return {"verdict": "network_error", "cause": classify_network_error(exc)}, [], 0, []
        try:
            state = browser.execute_script("return document.readyState")
        except Exception:
            return {"verdict": "network_error", "cause": "timeout"}, [], 0, []
        if state not in ("interactive", "complete") and not _wait_ready(browser, min(5, cfg.ready_timeout), cfg.sleep):
            return {"verdict": "network_error", "cause": "timeout"}, [], 0, []
    if not _wait_ready(browser, cfg.ready_timeout, cfg.sleep):
        return {"verdict": "network_error", "cause": "timeout"}, [], 0, []
    cfg.sleep(cfg.settle)
    parsed = {}
    try:
        parsed = parse_perf_log(browser.get_log("performance"))
    except Exception:
        pass     # performance log not enabled -> status stays "inferred"
    resp = main_response(parsed, path)
    body = browser.find_element("tag name", "body").text[:2000]
    if parser is None:
        rows, links = parse_cards(browser.page_source, cfg.base_url, cfg.allowed_hosts)
    else:
        rows, links = parser(browser.page_source)
    password = any(e.is_displayed() for e in browser.find_elements("css selector", "input[type='password']"))
    probe = classify_page(browser.current_url, browser.title, body, links, expected_hosts=_hosts(cfg),
                          password_visible=password,
                          http_status=resp["status"] if resp else None,
                          retry_after=resp["retry_after"] if resp else None)
    if probe["verdict"] != "blocked" and not resp and parsed.get("failures"):
        probe.update(verdict="network_error", cause=classify_network_error(parsed["failures"][0]))
    return probe, rows, links, parsed.get("failures", [])




def _cookie_expiry(value):
    """Return a cookie expiry in Unix seconds, or None for a session/invalid expiry."""
    if value in (None, ""):
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError, OverflowError):
        return None

def install_session(browser, cfg, log):
    """Install cookies for the configured base host only. Returns (accepted, rejected)."""
    cookies = load_cookie_export(cfg.cookies_raw)
    if not cookies:
        raise ValueError("В экспорте не найдено cookies с полями name и value.")
    from urllib.parse import urlsplit
    host = (urlsplit(cfg.base_url).hostname or "").lower()
    browser.get(cfg.base_url + "/")        # cookies can only be set once a page of the domain is open
    now = int(time.time())
    input_domains = sorted({str(c.get("domain", host)).strip().lower().lstrip(".") for c in cookies if isinstance(c, dict)})
    # Cookie names and flags are metadata, not credentials; values are never logged.
    cookie_metadata = sorted({
        f"{str(c.get('name', '?'))}[secure={bool(c.get('secure', False))},httponly={bool(c.get('httpOnly', False))},samesite={str(c.get('sameSite', 'unset'))}]"
        for c in cookies if isinstance(c, dict) and c.get("name")
    })
    expired = sum(
        1 for c in cookies if isinstance(c, dict)
        and c.get("expiry") not in (None, "")
        and _cookie_expiry(c.get("expiry")) is not None
        and _cookie_expiry(c.get("expiry")) <= now
    )
    log.info("cookie export summary: count=%d domains=%s expired=%d names_and_flags=%s (values never logged)",
             len(cookies), ",".join(input_domains) if input_domains else "none", expired,
             ",".join(cookie_metadata) if cookie_metadata else "none")
    accepted = rejected = 0
    for raw in cookies:
        if not isinstance(raw, dict):
            continue
        cookie = selenium_cookie(raw, host)
        if not cookie:
            rejected += 1
            continue
        # A permitted Huevo domain is not necessarily the domain this run visits.
        # Reject cross-domain cookies explicitly instead of treating add_cookie as proof of auth.
        scope = str(cookie.get("domain", "")).lstrip(".").lower()
        if host != scope and not host.endswith("." + scope):
            rejected += 1
            continue
        expiry = _cookie_expiry(cookie.get("expiry"))
        if expiry is not None and expiry <= now:
            rejected += 1
            continue
        try:
            browser.add_cookie(cookie)
            accepted += 1
        except Exception:
            rejected += 1
    try:
        visible = len(browser.get_cookies())
    except Exception:
        visible = -1
    log.info("cookie install summary: accepted=%d rejected=%d visible_on_base_host=%d (values never logged)",
             accepted, rejected, visible)
    return accepted, rejected


TRANSIENT_CAUSES = ("timeout", "connect")


def observe_with_retry(browser, cfg, path, log, parser=None):
    """`observe`, retried a bounded number of times and ONLY for transient network errors.

    Blocks (403/418/429), login pages, 5xx and DNS/TLS failures are returned at once: retrying
    them would just be pressure on the source. Waits grow 1x, 2x, ... of `retry_backoff`.
    """
    attempt = 0
    while True:
        result = observe(browser, cfg, path, parser)
        probe = result[0]
        if (probe.get("verdict") != "network_error" or probe.get("cause") not in TRANSIENT_CAUSES
                or attempt >= max(0, int(cfg.network_retries))):
            if attempt:
                probe["attempts"] = attempt + 1
            return result
        attempt += 1
        wait = max(0.0, cfg.retry_backoff) * attempt
        log.warning("transient network error (%s) on %s; retry %d/%d in %.0fs",
                    probe.get("cause"), path, attempt, cfg.network_retries, wait)
        cfg.sleep(wait)


def run_crawl(browser, store, cfg, log, progress=lambda page, found: None, should_stop=lambda: False):
    # --- session check on the root page, then the catalog
    if cfg.cookies_raw:
        try:
            accepted, _ = install_session(browser, cfg, log)
        except ValueError as exc:
            return CrawlResult("error", str(exc))
        if not accepted:
            return CrawlResult("login", "Ни одна cookie не применена: проверьте домен экспорта (cookies huevo.su не авторизуют huevo.departament.site).")
    pages = 0
    seen, previous = set(), []
    new_total = changed_total = 0
    for page in range(1, cfg.max_pages + 1):
        if should_stop():
            return CrawlResult("error", "Остановлено оператором", pages, len(seen), new_total, changed_total, stop_reason="остановка")
        # Use the canonical catalog URL for page 1; page=1 may redirect to the profile.
        path = "/market/gifts" if page == 1 else f"/market/gifts?page={page}"
        t0 = time.monotonic()
        probe, rows, links, _ = observe_with_retry(browser, cfg, path, log)
        verdict = probe["verdict"]
        log.info("crawl page=%d verdict=%s http=%s(%s) host=%s path=%s title=%r body_len=%s cards=%s parsed=%d %.1fs", page, verdict,
                 probe.get("http_status"), probe.get("status_source"), probe.get("final_host"), probe.get("final_path"), probe.get("title"),
                 probe.get("body_length"), links, len(rows), time.monotonic() - t0)
        common = dict(pages=pages, unique_lots=len(seen), new_lots=new_total, changed_lots=changed_total,
                      http_status=probe.get("http_status") or probe.get("status_class_inferred"),
                      status_source=probe.get("status_source"), retry_after=probe.get("retry_after"))
        if verdict == "blocked":
            code = probe.get("http_status") or probe.get("status_class_inferred")
            src = "подтверждён сетевым журналом" if probe.get("status_source") == "network" else "определён по тексту страницы"
            return CrawlResult("blocked", f"Huevo ограничил доступ (HTTP {code}, {src}). Сбор остановлен без повторов.", stop_reason="блокировка", **common)
        if verdict == "network_error":
            return CrawlResult("network_error", f"Сетевая ошибка ({probe.get('cause')}), попыток: {probe.get('attempts', 1)}. Сбор остановлен.", cause=probe.get("cause"), stop_reason="сеть", **common)
        if verdict == "server_error":
            return CrawlResult("server_error", VERDICT_HINTS["server_error"], stop_reason="ошибка источника", **common)
        if not rows:
            if page == 1 or verdict not in ("no_cards", "ok"):
                kind = "login" if verdict == "login" else "no_cards" if verdict == "no_cards" else "error"
                return CrawlResult(kind, VERDICT_HINTS.get(verdict, verdict) + f" (страница {page}, хост {probe.get('final_host')}, заголовок {probe.get('title')!r}, {probe.get('body_length')} симв.)",
                                   stop_reason=verdict, **common)
            return _finish(pages, seen, new_total, changed_total, True, f"страница {page} без карточек (конец каталога)")
        ids = [r["lot_id"] for r in rows]
        if not next_page_is_new(previous, ids):
            return _finish(pages, seen, new_total, changed_total, True, f"страница {page} не содержит новых лотов")
        previous = ids
        res = store.upsert_many(rows, now=utcnow())
        seen.update(ids)
        pages, new_total, changed_total = page, new_total + res["new"], changed_total + res["changed"]
        log.info("crawl page=%d saved new=%d changed=%d unique=%d", page, res["new"], res["changed"], len(seen))
        progress(page, len(seen))
        cfg.sleep(cfg.delay)
    return _finish(pages, seen, new_total, changed_total, False, "достигнут MAX_PAGES")


def _finish(pages, seen, new, changed, reached_end, reason):
    if not seen:
        return CrawlResult("no_cards", "Сбор завершился без единого лота; данные не сохранены.", stop_reason=reason)
    return CrawlResult("ok", f"Готово: {len(seen)} уникальных лотов, страниц {pages} ({reason})", pages, len(seen), new, changed, reached_end, stop_reason=reason)



def _detail_cache_fresh(record, now=None, max_age_days=14):
    """True when we inspected this lot page recently, even if it exposed no whitelisted fields."""
    from datetime import datetime, timezone
    record = record if isinstance(record, dict) else {}
    raw = record.get("checked_at")
    try:
        checked = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        if checked.tzinfo is None:
            return False
        current = now or datetime.now(timezone.utc)
        return (current - checked).total_seconds() < max_age_days * 86400
    except (TypeError, ValueError):
        return False


def run_gift_detail_crawl(browser, cfg, lots, previous_by_id=None, log=None, limit=12,
                          max_age_days=14, should_stop=lambda: False):
    """Inspect a small, rotating set of individual lot pages without expanding request volume.

    Details are cached per lot id. A page that renders but exposes no known attributes is still
    marked as inspected, preventing the same unsupported page from being requested every run.
    Any source block stops this detail pass immediately; already collected catalog data remains
    usable and the caller can persist the shared cooldown.
    """
    from datetime import datetime, timezone
    from gift_detail_parser import parse_gift_detail

    previous_by_id = previous_by_id or {}
    logger = log
    max_pages = max(0, min(int(limit), 50))
    if not max_pages:
        return {"details": {}, "status": "disabled", "pages": 0, "message": "Проверка карточек выключена."}
    current = datetime.now(timezone.utc)
    candidates = []
    for lot in lots or []:
        lot_id = str(lot.get("lot_id", "")).strip()
        if not lot_id or lot.get("active") is False:
            continue
        old = previous_by_id.get(lot_id) or {}
        if _detail_cache_fresh(old.get("gift_details"), now=current, max_age_days=max_age_days):
            continue
        url = str(lot.get("lot_url") or "")
        if not url.startswith(cfg.base_url + "/market/lot/"):
            continue
        candidates.append(lot)
    details = {}
    pages = 0
    status = "ok"
    message = "Карточки подарков проверены."
    for lot in candidates[:max_pages]:
        if should_stop():
            status, message = "stopped", "Проверка карточек остановлена оператором."
            break
        lot_id = str(lot["lot_id"])
        parsed = {}
        checked_at = datetime.now(timezone.utc).isoformat()

        def parser(html):
            nonlocal parsed
            parsed = parse_gift_detail(html, lot_id=lot_id, base_url=cfg.base_url,
                                       observed_at=checked_at) or {}
            return ([parsed] if parsed else []), (1 if parsed else 0)

        probe, rows, _, _ = observe_with_retry(browser, cfg, "/market/lot/" + lot_id,
                                               logger, parser=parser)
        pages += 1
        verdict = probe.get("verdict")
        if verdict == "blocked":
            status, message = "blocked", "Huevo ограничил доступ при проверке карточек подарков. Проверка остановлена."
            if logger:
                logger.warning("gift detail block on lot=%s http=%s; stopping detail pass",
                                lot_id, probe.get("http_status"))
            break
        if verdict in ("network_error", "server_error", "login", "wrong_host"):
            status = verdict
            message = "Проверка карточек прервана: " + verdict
            if logger:
                logger.warning("gift detail inspection stopped on lot=%s verdict=%s", lot_id, verdict)
            break
        if parsed:
            # Retain only the whitelisted object from the parser. Never copy arbitrary page text.
            details[lot_id] = parsed
            if logger:
                logger.info("gift detail lot=%s attrs=%d", lot_id, len(parsed.get("attributes") or {}))
        elif logger:
            logger.info("gift detail lot=%s: no recognised metadata; skipped", lot_id)
        if pages < min(max_pages, len(candidates)):
            cfg.sleep(max(float(cfg.delay), 3.0))
    return {"details": details, "status": status, "pages": pages, "message": message}

def run_history_crawl(browser, store, cfg, log, max_pages=5, should_stop=lambda: False):
    """Collect confirmed sales from /market/history into `store.sales`.

    Deliberately shallow by default (max_pages=5 of ~650): the same stop rules as the catalog crawl
    apply (block / login / 5xx / network error end the run with no retry). `reached_end` is True only
    when the pager says the last page was read or a later page has an empty table.
    """
    from history_parser import parse_history
    meta = {}

    def parser(html):
        meta.update(parse_history(html))
        return meta["rows"], len(meta["rows"])

    pages = saved = new_total = 0
    for page in range(1, max(1, max_pages) + 1):
        if should_stop():
            return CrawlResult("error", "Остановлено оператором", pages, saved, new_total, stop_reason="остановка")
        meta.clear()
        path = "/market/history" if page == 1 else f"/market/history?page={page}"
        probe, rows, _, _ = observe_with_retry(browser, cfg, path, log, parser=parser)
        verdict = probe["verdict"]
        log.info("history page=%d verdict=%s http=%s(%s) rows=%d table=%s total_pages=%s", page, verdict, probe.get("http_status"),
                 probe.get("status_source"), len(rows), meta.get("table_found"), meta.get("total_pages"))
        common = dict(pages=pages, unique_lots=saved, new_lots=new_total, http_status=probe.get("http_status") or probe.get("status_class_inferred"),
                      status_source=probe.get("status_source"), retry_after=probe.get("retry_after"))
        if verdict == "blocked":
            return CrawlResult("blocked", f"Huevo ограничил доступ к истории (HTTP {common['http_status']}). Остановлено без повторов.", stop_reason="блокировка", **common)
        if verdict == "network_error":
            return CrawlResult("network_error", f"Сетевая ошибка ({probe.get('cause')}).", cause=probe.get("cause"), stop_reason="сеть", **common)
        if verdict == "server_error":
            return CrawlResult("server_error", VERDICT_HINTS["server_error"], stop_reason="ошибка источника", **common)
        if not rows:
            if page > 1 and meta.get("table_found"):
                return CrawlResult("ok", f"История: страница {page} пуста (конец).", pages, saved, new_total, reached_end=True, stop_reason="конец истории")
            kind = "login" if verdict == "login" else "no_cards"
            return CrawlResult(kind, "Таблица истории не найдена или пуста на первой странице: вход, разметка или пустая история. Данные не сохранены.", stop_reason=verdict, **common)
        new_total += store.upsert_sales(rows, now=utcnow())
        saved += len(rows)
        pages = page
        total = meta.get("total_pages")
        if total and page >= total:
            return CrawlResult("ok", f"История прочитана целиком: страниц {pages}.", pages, saved, new_total, reached_end=True, stop_reason="последняя страница")
        cfg.sleep(cfg.delay)
    return CrawlResult("ok", f"История: прочитано страниц {pages} (лимит {max_pages}), новых сделок {new_total}.", pages, saved, new_total, reached_end=False, stop_reason="лимит страниц")
