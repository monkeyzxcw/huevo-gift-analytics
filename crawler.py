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
        if browser.execute_script("return document.readyState") == "complete":
            return True
        sleep(0.2)
    return False


def observe(browser, cfg, path):
    """Load `path`, return (probe dict, rows, link_count, network_failures)."""
    try:
        browser.get(cfg.base_url + path)
    except Exception as exc:
        return {"verdict": "network_error", "cause": classify_network_error(exc)}, [], 0, []
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
    rows, links = parse_cards(browser.page_source, cfg.base_url, cfg.allowed_hosts)
    password = any(e.is_displayed() for e in browser.find_elements("css selector", "input[type='password']"))
    probe = classify_page(browser.current_url, browser.title, body, links, expected_hosts=_hosts(cfg),
                          password_visible=password,
                          http_status=resp["status"] if resp else None,
                          retry_after=resp["retry_after"] if resp else None)
    if probe["verdict"] != "blocked" and not resp and parsed.get("failures"):
        probe.update(verdict="network_error", cause=classify_network_error(parsed["failures"][0]))
    return probe, rows, links, parsed.get("failures", [])


def install_session(browser, cfg, log):
    """Install cookies for the configured base host only. Returns (accepted, rejected)."""
    cookies = load_cookie_export(cfg.cookies_raw)
    if not cookies:
        raise ValueError("В экспорте не найдено cookies с полями name и value.")
    from urllib.parse import urlsplit
    host = urlsplit(cfg.base_url).hostname
    browser.get(cfg.base_url + "/")        # cookies can only be set once a page of the domain is open
    accepted = rejected = 0
    for raw in cookies:
        if not isinstance(raw, dict):
            continue
        cookie = selenium_cookie(raw, host)
        if not cookie:
            rejected += 1
            continue
        try:
            browser.add_cookie(cookie)
            accepted += 1
        except Exception:
            rejected += 1
    log.info("cookies accepted=%d rejected=%d (values never logged)", accepted, rejected)
    return accepted, rejected


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
        path = f"/market/gifts?page={page}"
        t0 = time.monotonic()
        probe, rows, links, _ = observe(browser, cfg, path)
        verdict = probe["verdict"]
        log.info("crawl page=%d verdict=%s http=%s(%s) host=%s title=%r body_len=%s cards=%s parsed=%d %.1fs", page, verdict,
                 probe.get("http_status"), probe.get("status_source"), probe.get("final_host"), probe.get("title"),
                 probe.get("body_length"), links, len(rows), time.monotonic() - t0)
        common = dict(pages=pages, unique_lots=len(seen), new_lots=new_total, changed_lots=changed_total,
                      http_status=probe.get("http_status") or probe.get("status_class_inferred"),
                      status_source=probe.get("status_source"), retry_after=probe.get("retry_after"))
        if verdict == "blocked":
            code = probe.get("http_status") or probe.get("status_class_inferred")
            src = "подтверждён сетевым журналом" if probe.get("status_source") == "network" else "определён по тексту страницы"
            return CrawlResult("blocked", f"Huevo ограничил доступ (HTTP {code}, {src}). Сбор остановлен без повторов.", stop_reason="блокировка", **common)
        if verdict == "network_error":
            return CrawlResult("network_error", f"Сетевая ошибка ({probe.get('cause')}). Сбор остановлен без повторов.", cause=probe.get("cause"), stop_reason="сеть", **common)
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
