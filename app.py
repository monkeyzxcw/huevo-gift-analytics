"""Huevo Gift Analytics — FastAPI app.

Layers: lot_parser (HTML->rows) · storage (SQLite) · analytics (pure maths) · crawler (Selenium loop,
injectable browser) · cookies · huevo_probe (page classification) · support (huEVO Apps payments).
This module only wires them to HTTP. Nothing here bypasses Huevo protection: on 403/418/429 or a
login/challenge page the crawl stops and a cooldown (at least Retry-After) is persisted.
"""
import hmac
import json
import logging
import os
import re
import tempfile
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

import support
from analytics import best_value, find_deals, market_summary, price_bins
from cookies import ALLOWED_HUEVO_HOSTS, is_huevo_host, load_cookie_export
from crawler import CrawlConfig, observe, install_session, run_crawl
from huevo_probe import VERDICT_HINTS, classify_network_error
from lot_parser import sanitize_lot
from security import CSP
from storage import SORTS, Store, utcnow

BASE_URL = os.getenv("HUEVO_BASE_URL", "https://huevo.su").strip().rstrip("/")
_base_parts = urlsplit(BASE_URL)
if _base_parts.scheme != "https" or _base_parts.hostname not in ALLOWED_HUEVO_HOSTS or _base_parts.username or _base_parts.password:
    raise RuntimeError("HUEVO_BASE_URL должен быть https://huevo.su или https://huevo.departament.site")
APP_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.getenv("HUEVO_DB", "huevo.db")
DELAY = float(os.getenv("CRAWL_DELAY", "2.0"))
MAX_PAGES = int(os.getenv("MAX_PAGES", "500"))
BLOCK_COOLDOWN_HOURS = max(1, int(os.getenv("CRAWL_BLOCK_COOLDOWN_HOURS", "6")))
AUTO_REFRESH_HOURS = max(1, int(os.getenv("AUTO_REFRESH_HOURS", "2")))
DIAG_COOLDOWN_SECONDS = max(60, int(os.getenv("DIAG_COOLDOWN_SECONDS", "300")))
INGEST_TOKEN = os.getenv("INGEST_TOKEN", "")
HUEVO_COOKIES_EXPORT = (os.getenv("HUEVO_COOKIES_JSON", "").strip() or os.getenv("HUEVO_COOKIES", "").strip())
MAX_BODY = 2_000_000
MAX_INGEST_LOTS = 1000

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("huevo")

store = Store(DB_PATH)
store.migrate()

app = FastAPI(title="Huevo Gift Analytics", docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(CORSMiddleware, allow_origins=[f"https://{h}" for h in ALLOWED_HUEVO_HOSTS],
                   allow_credentials=False, allow_methods=["GET", "POST", "OPTIONS"],
                   allow_headers=["Content-Type", "Authorization"])

@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("Content-Security-Policy", CSP)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    if request.url.path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-store")
    return response


# ------------------------------------------------------------------ runtime state
lock = threading.Lock()
state = {"running": False, "page": 0, "found": 0, "message": "Ожидает запуска", "started_at": None,
         "last_ingest_at": None, "last_result": None}


def set_state(**kw):
    with lock:
        state.update(kw)


def blocked_until():
    """Persisted (survives restarts). Returns aware datetime in the future, else None."""
    raw = store.kv_get("blocked_until")
    if not raw:
        return None
    try:
        when = datetime.fromisoformat(raw)
    except ValueError:
        store.kv_set("blocked_until", None)
        return None
    if when > datetime.now(timezone.utc):
        return when
    store.kv_set("blocked_until", None)
    return None


def start_block(http_status, retry_after):
    seconds = max(BLOCK_COOLDOWN_HOURS * 3600, retry_after or 0)
    until = datetime.now(timezone.utc) + timedelta(seconds=seconds)
    store.kv_set("blocked_until", until.isoformat())
    store.kv_set("last_http_status", http_status if http_status is not None else "")
    return until


def refuse_if_blocked():
    until = blocked_until()
    if until:
        remaining = int((until - datetime.now(timezone.utc)).total_seconds())
        raise HTTPException(status_code=429, headers={"Retry-After": str(max(1, remaining))},
                            detail=f"Сбор приостановлен после ограничения доступа Huevo до {until.strftime('%Y-%m-%d %H:%M UTC')}. Запросы к Huevo не отправляются.")


def persistence_info():
    ephemeral = bool(os.getenv("RENDER")) and not os.path.abspath(DB_PATH).startswith("/var/data")
    return {"db_path_kind": "persistent-disk" if os.path.abspath(DB_PATH).startswith("/var/data") else "local",
            "ephemeral_warning": ephemeral,
            "message": ("База лежит вне подключённого диска: на бесплатном плане Render данные пропадут при перезапуске/деплое. "
                        "Подключите persistent disk и задайте HUEVO_DB=/var/data/huevo.db (платная опция, автоматически не включается).") if ephemeral else ""}


# ------------------------------------------------------------------ auth + limits
_fail_lock = threading.Lock()
_fails = {}          # key -> [timestamps]
FAIL_WINDOW, FAIL_LIMIT, GLOBAL_FAIL_LIMIT = 300, 10, 60


def _client_key(request):
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[-1].strip()[:64]       # the hop added by the trusted proxy
    return request.client.host if request.client else "?"


def _fail_count(key, now):
    return len([t for t in _fails.get(key, []) if now - t < FAIL_WINDOW])


def require_token(request):
    if not INGEST_TOKEN:
        raise HTTPException(status_code=503, detail="На Render не задан INGEST_TOKEN")
    key, now = _client_key(request), time.monotonic()
    with _fail_lock:
        if _fail_count(key, now) >= FAIL_LIMIT or _fail_count("*", now) >= GLOBAL_FAIL_LIMIT:
            raise HTTPException(status_code=429, headers={"Retry-After": str(FAIL_WINDOW)}, detail="Слишком много неверных попыток. Подождите несколько минут.")
    authorization = request.headers.get("authorization", "")
    supplied = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    if not supplied or not hmac.compare_digest(supplied.encode(), INGEST_TOKEN.encode()):
        with _fail_lock:
            for k in (key, "*"):
                _fails[k] = [t for t in _fails.get(k, []) if now - t < FAIL_WINDOW] + [now]
            if len(_fails) > 2000:
                _fails.clear()
        raise HTTPException(status_code=403, detail="Неверный токен")


async def read_json(request, limit=MAX_BODY, what="Ожидается корректный JSON"):
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise HTTPException(status_code=413, detail="Слишком большой запрос")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > limit:
            raise HTTPException(status_code=413, detail="Слишком большой запрос")
    try:
        return json.loads(body or b"{}")
    except (json.JSONDecodeError, UnicodeDecodeError, TypeError):
        raise HTTPException(status_code=400, detail=what)


def valid_lot_id(value):
    if not re.fullmatch(r"\d{1,20}", str(value)):
        raise HTTPException(status_code=400, detail="Некорректный ID лота")
    return str(value)


# ------------------------------------------------------------------ basic
@app.get("/health")
def health():
    try:
        store.counts()
        ok = True
    except Exception:
        ok = False
    return {"ok": ok, "service": "Huevo Gift Analytics"}


@app.get("/", response_class=HTMLResponse)
def home():
    with open(os.path.join(APP_DIR, "static", "index.html"), encoding="utf-8") as f:
        return f.read()


@app.get("/api/status")
def get_status():
    with lock:
        out = dict(state)
    until = blocked_until()
    out.update(blocked_until=until.isoformat() if until else None,
               last_http_status=store.kv_get("last_http_status") or None,
               last_crawl_at=store.kv_get("last_crawl_at"),
               last_crawl_status=store.kv_get("last_crawl_status"),
               server_session_configured=bool(HUEVO_COOKIES_EXPORT),
               ingest_configured=bool(INGEST_TOKEN))
    return out


@app.get("/api/diagnostics")
def diagnostics():
    """Presence flags and counters only; never secret values."""
    counts = store.counts()
    return {"ok": True, "schema_version": 2, "ingest_token_configured": bool(INGEST_TOKEN),
            "huevo_cookies_configured": bool(HUEVO_COOKIES_EXPORT), "huevo_base_url": BASE_URL,
            "cookie_export_format": "JSON or Netscape" if HUEVO_COOKIES_EXPORT else None,
            "lots_in_database": counts["active_total"] + counts["inactive"], "active_lots": counts["active_total"],
            "price_history_rows": counts["history_rows"], "snapshots": counts["snapshots"],
            "persistence": persistence_info(), "collector": get_status()}


# ------------------------------------------------------------------ ingest (browser collector)
@app.post("/api/ingest")
async def ingest(request: Request):
    """Lots parsed by the user's own authorized browser tab. Bearer token only (never a query string)."""
    require_token(request)
    payload = await read_json(request)
    rows = payload.get("lots") if isinstance(payload, dict) else None
    if not isinstance(rows, list) or len(rows) > MAX_INGEST_LOTS:
        raise HTTPException(status_code=400, detail=f"Поле lots должно быть списком до {MAX_INGEST_LOTS} записей")
    clean = [r for r in (sanitize_lot(i, BASE_URL) for i in rows) if r]
    now = utcnow()
    res = store.upsert_many(clean, now=now)
    if not store.kv_get("ingest_run_started"):
        store.kv_set("ingest_run_started", now)
    set_state(message=f"Браузерный импорт: сохранено {len(clean)} лотов (проход не завершён)", found=len(clean), last_ingest_at=now)
    return {"ok": True, "saved": len(clean), "received": len(rows), "rejected": len(rows) - len(clean),
            "new": res["new"], "changed": res["changed"], "observed_at": now}


def finish_pass(source, reached_end, started):
    """Deactivate unseen lots only after a complete pass that still looks plausible; snapshot only then."""
    deactivated, warning = 0, None
    if reached_end and started:
        with store.connect() as c:
            seen = c.execute("SELECT COUNT(*) FROM lots WHERE active=1 AND last_seen>=?", (started,)).fetchone()[0]
            before = c.execute("SELECT COUNT(*) FROM lots WHERE active=1 AND last_seen<?", (started,)).fetchone()[0]
        if before >= 20 and seen < (seen + before) * 0.5:
            warning = (f"Проход увидел только {seen} из {seen + before} активных лотов — похоже на неполный; "
                       "лоты не деактивированы, снимок рынка не записан.")
        else:
            deactivated = store.deactivate_unseen(started)
    snapshot_at = None
    if reached_end and started and not warning:
        snapshot_at = store.record_snapshot(source, market_summary)
    return deactivated, snapshot_at, warning


@app.post("/api/ingest/complete")
async def ingest_complete(request: Request):
    require_token(request)
    payload = await read_json(request, limit=20_000)
    reached_end = bool(isinstance(payload, dict) and payload.get("reached_end"))
    started = store.kv_get("ingest_run_started")
    store.kv_set("ingest_run_started", None)
    deactivated, snapshot_at, warning = finish_pass("browser", reached_end, started)
    msg = ("Браузерный сбор завершён" if reached_end and not warning else warning
           or "Браузерный сбор прерван: неполный проход, активность лотов и снимок рынка не менялись")
    set_state(message=msg)
    return {"ok": True, "deactivated": deactivated, "snapshot_at": snapshot_at, "complete": reached_end and not warning, "warning": warning}


# ------------------------------------------------------------------ server crawl
def crawl_config():
    return CrawlConfig(base_url=BASE_URL, allowed_hosts=ALLOWED_HUEVO_HOSTS, delay=DELAY, max_pages=MAX_PAGES,
                       cookies_raw=HUEVO_COOKIES_EXPORT)


def make_browser():
    """Headless Chromium on the default direct route; performance log gives the real HTTP status."""
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options
    options = Options()
    for arg in ("--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--window-size=1440,1000"):
        options.add_argument(arg)
    options.set_capability("goog:loggingPrefs", {"performance": "ALL"})
    options.add_experimental_option("perfLoggingPrefs", {"enableNetwork": True})
    browser = webdriver.Chrome(options=options)
    browser.set_page_load_timeout(30)
    return browser


def crawl():
    with lock:
        if state["running"]:
            return
        state.update(running=True, page=0, found=0, started_at=utcnow(), message="Сбор запущен")
    started = utcnow()
    browser = None
    try:
        if blocked_until():
            set_state(message="Сбор не запущен: действует пауза после ограничения доступа")
            return
        browser = make_browser()
        res = run_crawl(browser, store, crawl_config(), log, progress=lambda p, n: set_state(page=p, found=n))
        message = res.message
        if res.status == "ok":
            deactivated, snap, warning = finish_pass("server", res.reached_end, started)
            if res.reached_end and not warning:
                message += f"; снято с рынка: {deactivated}"
            elif not res.reached_end:
                message += "; конец каталога не достигнут — активность лотов не менялась"
            if warning:
                message += "; " + warning
            store.kv_set("last_crawl_at", utcnow())
        elif res.status == "blocked":
            until = start_block(res.http_status, res.retry_after)
            message += f" Пауза до {until.strftime('%Y-%m-%d %H:%M UTC')}."
        store.kv_set("last_crawl_status", res.status)
        set_state(message=message, last_result={k: getattr(res, k) for k in (
            "status", "pages", "unique_lots", "new_lots", "changed_lots", "reached_end", "http_status", "status_source",
            "retry_after", "cause", "stop_reason")})
        log.info("crawl finished status=%s pages=%s lots=%s reached_end=%s", res.status, res.pages, res.unique_lots, res.reached_end)
    except Exception as exc:
        log.error("crawl crashed: %s: %s", type(exc).__name__, classify_network_error(exc))
        store.kv_set("last_crawl_status", "error")
        set_state(message=f"Ошибка сбора: {type(exc).__name__} ({classify_network_error(exc)})")
    finally:
        if browser is not None:
            try:
                browser.quit()
            except Exception:
                pass
        set_state(running=False)


@app.post("/api/crawl")
def start_crawl(request: Request, background: BackgroundTasks):
    require_token(request)
    refuse_if_blocked()
    if not HUEVO_COOKIES_EXPORT:
        raise HTTPException(status_code=503, detail="Серверная сессия Huevo не настроена. Используйте браузерный сборщик или задайте HUEVO_COOKIES_JSON / HUEVO_COOKIES в Environment.")
    with lock:
        if state["running"]:
            return {"ok": True, "message": "Сбор уже выполняется"}
    background.add_task(crawl)
    return {"ok": True, "message": "Сбор запущен"}


def scheduled_crawler():
    """Crawl only when the last successful crawl is older than AUTO_REFRESH_HOURS (restart-safe)."""
    time.sleep(5)
    while True:
        try:
            last = store.kv_get("last_crawl_at")
            due = True
            if last:
                due = datetime.now(timezone.utc) - datetime.fromisoformat(last) >= timedelta(hours=AUTO_REFRESH_HOURS)
            if due and not blocked_until() and not state["running"]:
                crawl()
        except Exception as exc:
            log.error("scheduler error: %s", type(exc).__name__)
        time.sleep(600)


@app.on_event("startup")
def start_scheduler():
    if HUEVO_COOKIES_EXPORT:
        threading.Thread(target=scheduled_crawler, name="huevo-auto-refresh", daemon=True).start()
    else:
        set_state(message="Ожидает браузерного сбора: серверная сессия Huevo не настроена")


diag_lock = threading.Lock()
_diag_last = {"at": 0.0}
STEP_HINTS = {"dns": "DNS не разрешает домен (проблема сети узла или недоступность источника).",
              "tls": "Ошибка TLS при подключении.", "timeout": "Тайм-аут соединения.",
              "connect": "Соединение отклонено или сброшено."}


@app.post("/api/diagnose-huevo")
def diagnose_huevo(request: Request):
    """One read-only probe of / and /market/gifts?page=1. No cookies or page bodies are returned."""
    require_token(request)
    with lock:
        if state["running"]:
            raise HTTPException(status_code=409, detail="Идёт сбор; диагностика не запускается параллельно")
    refuse_if_blocked()
    if not diag_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="Диагностика уже выполняется")
    try:
        remaining = DIAG_COOLDOWN_SECONDS - (time.monotonic() - _diag_last["at"])
        if _diag_last["at"] and remaining > 0:
            raise HTTPException(status_code=429, detail=f"Повторите через {int(remaining) + 1} с", headers={"Retry-After": str(int(remaining) + 1)})
        _diag_last["at"] = time.monotonic()
        cfg = crawl_config()
        result = {"base_url": BASE_URL, "cookies_configured": bool(HUEVO_COOKIES_EXPORT), "steps": []}
        browser = None
        try:
            browser = make_browser()
            if HUEVO_COOKIES_EXPORT:
                try:
                    accepted, rejected = install_session(browser, cfg, log)
                    result["cookies_installed_for_base_host"] = accepted
                except ValueError as exc:
                    result["cookie_error"] = str(exc)
            for name, path in (("root", "/"), ("market_page_1", "/market/gifts?page=1")):
                probe, rows, links, _ = observe(browser, cfg, path)
                step = {"step": name, "path": path, **probe, "parsed_lots": len(rows)}
                if probe["verdict"] == "network_error":
                    step["hint"] = STEP_HINTS.get(probe.get("cause"), "Неклассифицированная сетевая ошибка.")
                else:
                    step["hint"] = VERDICT_HINTS.get(probe["verdict"], "")
                result["steps"].append(step)
                log.info("diagnose step=%s verdict=%s http=%s(%s) host=%s cards=%s", name, probe["verdict"],
                         probe.get("http_status"), probe.get("status_source"), probe.get("final_host"), probe.get("cards"))
                if probe["verdict"] in ("blocked", "network_error"):
                    break
        except HTTPException:
            raise
        except Exception as exc:
            result["error"] = f"{type(exc).__name__}: {classify_network_error(exc)}"
            log.error("diagnose failed: %s", result["error"])
        finally:
            if browser is not None:
                try:
                    browser.quit()
                except Exception:
                    pass
        blocked = next((s for s in result["steps"] if s.get("verdict") == "blocked"), None)
        if blocked:
            start_block(blocked.get("http_status") or blocked.get("status_class_inferred"), blocked.get("retry_after"))
        return result
    finally:
        diag_lock.release()


# ------------------------------------------------------------------ catalog + analytics
def _int_or_none(value):
    return int(value) if value not in (None, "") else None


@app.get("/api/catalog")
def catalog(q: str = "", sort: str = "price", status: str = "", rarity: str = "", min_price: int = None,
            max_price: int = None, limit: int = 24, offset: int = 0):
    if sort not in SORTS:
        raise HTTPException(status_code=400, detail="Неизвестная сортировка")
    items, total = store.catalog(q=q[:100], sort=sort, status=status[:100], rarity=rarity[:100], min_price=min_price,
                                 max_price=max_price, limit=max(1, min(limit, 200)), offset=max(0, min(offset, 1_000_000)))
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@app.get("/api/facets")
def facets():
    return store.facets()


@app.get("/api/lots/by-ids")
def lots_by_ids(ids: str = ""):
    parts = [i for i in ids.split(",") if i][:100]
    if any(not re.fullmatch(r"\d{1,20}", i) for i in parts):
        raise HTTPException(status_code=400, detail="Некорректный ID лота")
    return {"items": store.lots_by_ids(parts)}


@app.get("/api/lots")
def lots(q: str = "", sort: str = "price", limit: int = 500):
    """Backward-compatible flat list (prefer /api/catalog)."""
    items, _ = store.catalog(q=q[:100], sort=sort if sort in SORTS else "price", limit=max(1, min(limit, 200)))
    return items


@app.get("/api/stats")
def stats():
    s = market_summary(store.active_prices())
    n = store.counts()
    return {"n_total": n["active_total"], "n": s["priced"], "minp": s["min"], "maxp": s["max"], "avgp": s["avg"], "medianp": s["median"]}


@app.get("/api/deals")
def deals(limit: int = 20):
    limit = max(1, min(limit, 100))
    return {"method": "цена ниже медианы не менее чем 3 активных предложений с тем же названием и редкостью на 15% и больше",
            "note": "Это текущие предложения, а не цены завершённых продаж.",
            "deals": find_deals(store.active_lots(), limit=limit)}


@app.get("/api/analytics/summary")
def analytics_summary():
    prices = store.active_prices()
    summary = market_summary(prices)
    counts = store.counts()
    enough = summary["priced"] >= 5
    return {"summary": summary, "enough_data": enough, "sample_size": summary["priced"], "active_total": counts["active_total"],
            "bins": price_bins(prices) if enough else [],
            "rarities": [{"rarity": r, "count": n} for r, n in store.rarity_counts()],
            "changes": [store.period_change(d) for d in (7, 30, 90)],
            "method": "Медиана и квартили считаются по ценам текущих активных предложений. Изменение за период — между первым и последним снимком рынка; при менее чем двух снимках показывается «Недостаточно данных».",
            "note": "Цены предложений не равны ценам завершённых сделок."}


@app.get("/api/analytics/snapshots")
def snapshots(days: int = 30):
    days = max(1, min(int(days), 365))
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    with store.connect() as c:
        rows = c.execute("SELECT observed_at,source,active_lots,priced,min_price,max_price,avg_price,median_price "
                         "FROM market_snapshots WHERE observed_at>=? ORDER BY observed_at", (cutoff,)).fetchall()
    return {"days": days, "points": [dict(r) for r in rows]}


@app.get("/api/analytics/price-history")
def analytics_price_history(days: int = 7, lot_id: str = ""):
    """Daily averages of recorded price changes. These are observations of offers, not sale prices."""
    days = max(1, min(int(days), 90))
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days - 1)).date().isoformat()
    sql = ("SELECT substr(observed_at,1,10) day, AVG(price) avg_price, COUNT(*) snapshots FROM price_history "
           "WHERE price IS NOT NULL AND date(observed_at)>=? {} GROUP BY day ORDER BY day")
    with store.connect() as c:
        if lot_id:
            rows = c.execute(sql.format("AND lot_id=?"), (cutoff, valid_lot_id(lot_id))).fetchall()
        else:
            rows = c.execute(sql.format(""), (cutoff,)).fetchall()
    return {"days": days, "lot_id": lot_id or None,
            "points": [{"day": r["day"], "avg_price": round(r["avg_price"], 2), "snapshots": r["snapshots"]} for r in rows]}


@app.get("/api/history/{lot_id}")
def history(lot_id: str):
    valid_lot_id(lot_id)
    with store.connect() as c:
        return [dict(r) for r in c.execute("SELECT price,status,observed_at FROM price_history WHERE lot_id=? ORDER BY observed_at", (lot_id,))]


PUBLIC_FIELDS = ("lot_id", "title", "serial", "rarity", "price", "status", "image_url", "lot_url", "first_seen", "last_seen")


@app.get("/api/highlights")
def highlights():
    latest = store.latest_lot()
    counts = store.counts()
    best = best_value(store.active_lots(), store.gone_lots(), limit=3)
    return {
        "latest": {k: latest[k] for k in PUBLIC_FIELDS} if latest else None,
        "latest_note": ("Время выставления сайт не отдаёт: показан лот, который сборщик увидел последним (при равенстве — с наибольшим ID)."
                        + ("" if counts["snapshots"] >= 2 else " Пока был один проход, все лоты замечены одновременно.")),
        "best": best[0] if best else None, "runner_up": best[1:],
        "best_note": ("Эталон — медиана последних цен лотов того же названия и редкости, ушедших с рынка (вероятно проданы или сняты: сайт не раскрывает причину). "
                      "Если таких меньше трёх, берётся медиана активных предложений; основа и размер выборки указаны в карточке. Это не цены завершённых сделок."),
        "data_state": "empty" if counts["active_total"] == 0 else "ok",
    }


@app.get("/api/drops")
def price_drops(limit: int = 12, days: int = 0):
    return store.drops(limit=max(1, min(limit, 100)), days=max(0, min(days, 365)) or None)


@app.get("/api/backup")
def backup(request: Request):
    """Consistent SQLite copy for the operator (Bearer token). Contains public market data and payment status rows."""
    require_token(request)
    tmp = tempfile.NamedTemporaryFile(prefix="huevo-backup-", suffix=".db", delete=False)
    tmp.close()
    store.backup(tmp.name)
    return FileResponse(tmp.name, media_type="application/octet-stream", filename="huevo-backup.db",
                        background=BackgroundTask(lambda: os.path.exists(tmp.name) and os.unlink(tmp.name)))


# ------------------------------------------------------------------ support the author (huEVO Apps payments)
HUEVO_CLIENT_ID = os.getenv("HUEVO_CLIENT_ID", "").strip()
HUEVO_CLIENT_SECRET = os.getenv("HUEVO_CLIENT_SECRET", "").strip()
SUPPORT_AMOUNTS = [5, 10, 50, 100]


def support_enabled():
    return bool(HUEVO_CLIENT_ID and HUEVO_CLIENT_SECRET)


def huevo_api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(support.API_BASE + path, data=data, method=method,
                                 headers={"Authorization": support.basic_auth_header(HUEVO_CLIENT_ID, HUEVO_CLIENT_SECRET),
                                          "Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read() or b"{}")
        except ValueError:
            return exc.code, {}
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        log.warning("huevo api %s %s failed: %s", method, path, type(exc).__name__)
        return 0, {}


def store_payment(intent_id, status, error=None):
    """Idempotent: a final status is never overwritten (docs: it cannot change)."""
    with store.connect() as c:
        row = c.execute("SELECT status FROM support_payments WHERE intent_id=?", (intent_id,)).fetchone()
        if not row or row["status"] in support.FINAL_STATUSES:
            return False
        c.execute("UPDATE support_payments SET status=?, error=?, updated_at=? WHERE intent_id=?", (status, error, utcnow(), intent_id))
    return True


@app.get("/api/support/config")
def support_config():
    return {"enabled": support_enabled(), "amounts": SUPPORT_AMOUNTS, "sdk_url": "https://huevo.su/static/js/huevo-apps-v1.js",
            "origins": list(ALLOWED_HUEVO_HOSTS)}


@app.post("/api/support/intent")
async def support_intent(request: Request):
    if not support_enabled():
        raise HTTPException(status_code=503, detail="Приём поддержки не настроен (нужны HUEVO_CLIENT_ID и HUEVO_CLIENT_SECRET).")
    payload = await read_json(request, limit=10_000, what="Ожидается JSON")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Ожидается JSON-объект")
    amount = support.clean_amount(payload.get("amount"))
    if amount is None:
        raise HTTPException(status_code=400, detail=f"Сумма — целое число от {support.MIN_AMOUNT} до {support.MAX_AMOUNT}.")
    launch = support.verify_launch(str(payload.get("launch_query", ""))[:4000], HUEVO_CLIENT_SECRET)
    if not launch or not str(launch.get("hu_user_id", "")).isdigit():
        raise HTTPException(status_code=401, detail="Откройте приложение внутри huEVO: подпись запуска не подтверждена.")
    test = support.is_test_session(launch)
    status, data = huevo_api("POST", "/payments", support.payment_body(launch["hu_user_id"], amount, test))
    if status != 200 or not data.get("ok") or not data.get("intent_id"):
        code = (data.get("error") or {}).get("code") if isinstance(data.get("error"), dict) else None
        log.warning("create intent failed http=%s code=%s", status, code)
        raise HTTPException(status_code=502, detail=f"huEVO не создал платёж ({code or 'нет ответа'}).")
    now = utcnow()
    with store.connect() as c:
        c.execute("INSERT OR IGNORE INTO support_payments(intent_id,user_id,amount,test,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                  (data["intent_id"], int(launch["hu_user_id"]), amount, int(test), "pending", now, now))
    return {"ok": True, "intent_id": data["intent_id"], "amount": amount, "test": test}


@app.get("/api/support/status/{intent_id}")
def support_status(intent_id: str):
    if not re.fullmatch(r"pi_[A-Za-z0-9_-]{1,80}", intent_id):
        raise HTTPException(status_code=400, detail="Некорректный intent_id")
    with store.connect() as c:
        row = c.execute("SELECT * FROM support_payments WHERE intent_id=?", (intent_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Платёж не найден")
    status = row["status"]
    if status == "pending" and support_enabled():
        http, data = huevo_api("GET", "/payments/" + intent_id)
        if http == 200 and data.get("status") in ("pending", "succeeded", "failed", "cancelled", "expired"):
            status = data["status"]
            if status != "pending":
                store_payment(intent_id, status, data.get("error"))
    return {"intent_id": intent_id, "status": status, "test": bool(row["test"])}


@app.post("/api/support/callback")
async def support_callback(request: Request):
    raw = await request.body()
    if len(raw) > 20_000 or not support.verify_callback(raw, request.headers.get("x-huevo-signature", ""), HUEVO_CLIENT_SECRET):
        raise HTTPException(status_code=401, detail="bad signature")
    try:
        data = json.loads(raw)
        intent_id, status = str(data["intent_id"]), str(data["status"])
    except (ValueError, KeyError, TypeError):
        raise HTTPException(status_code=400, detail="bad payload")
    if status in support.FINAL_STATUSES:
        changed = store_payment(intent_id, status, data.get("error"))
        log.info("support callback intent=%s status=%s test=%s applied=%s", intent_id, status, data.get("test"), changed)
    return Response(status_code=204)


@app.get("/api/support/stats")
def support_stats():
    with store.connect() as c:
        row = c.execute("SELECT COUNT(*) n, COALESCE(SUM(amount),0) total FROM support_payments WHERE status='succeeded' AND test=0").fetchone()
    return {"supporters": row["n"], "total": row["total"]}


app.mount("/static", StaticFiles(directory=os.path.join(APP_DIR, "static")), name="static")
