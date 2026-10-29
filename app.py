import os, re, time, sqlite3, threading, json, hmac, logging
from datetime import datetime, timezone, timedelta
from urllib.parse import urljoin, urlsplit
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.support.ui import WebDriverWait
from bs4 import BeautifulSoup
import urllib.request, urllib.error
from analytics import market_summary, find_deals, best_value
import support
from huevo_probe import (looks_like_login_page, access_block_status, classify_page,
                         classify_network_error, next_page_is_new, VERDICT_HINTS)
from fastapi import FastAPI, BackgroundTasks, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles

ALLOWED_HUEVO_HOSTS = ("huevo.su", "huevo.departament.site")
BASE_URL = os.getenv("HUEVO_BASE_URL", "https://huevo.su").strip().rstrip("/")
_base_parts = urlsplit(BASE_URL)
if _base_parts.scheme != "https" or _base_parts.hostname not in ALLOWED_HUEVO_HOSTS or _base_parts.username or _base_parts.password:
    raise RuntimeError("HUEVO_BASE_URL должен быть https://huevo.su или https://huevo.departament.site")
APP_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.getenv("HUEVO_DB", "huevo.db")
os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
DELAY = float(os.getenv("CRAWL_DELAY", "2.0"))
MAX_PAGES = int(os.getenv("MAX_PAGES", "500"))
CRAWL_BLOCK_COOLDOWN_HOURS = max(1, int(os.getenv("CRAWL_BLOCK_COOLDOWN_HOURS", "6")))
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"),
                    format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("huevo")
app = FastAPI(title="Huevo Gift Analytics")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://huevo.su", "https://huevo.departament.site"],
    allow_credentials=False,
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)
INGEST_TOKEN = os.getenv("INGEST_TOKEN", "")
# Accept JSON cookie exports and Netscape cookies.txt; never commit these secrets.
HUEVO_COOKIES_EXPORT = (os.getenv("HUEVO_COOKIES_JSON", "").strip()
                        or os.getenv("HUEVO_COOKIES", "").strip())

def is_huevo_host(host):
    host = (host or "").lower().rstrip(".")
    return any(host == domain or host.endswith("." + domain) for domain in ALLOWED_HUEVO_HOSTS)

def load_cookie_export(raw):
    """Normalize browser-extension JSON and Netscape cookies.txt exports."""
    if not raw or not raw.strip():
        return []
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            parsed = parsed.get("cookies", parsed.get("data", []))
        if not isinstance(parsed, list):
            raise ValueError("JSON должен быть массивом cookies или объектом с полем cookies")
        cookies = []
        for item in parsed:
            if not isinstance(item, dict) or not item.get("name") or "value" not in item:
                continue
            cookie = dict(item)
            if "expiry" not in cookie and "expirationDate" in cookie:
                cookie["expiry"] = cookie.pop("expirationDate")
            cookies.append(cookie)
        return cookies
    except json.JSONDecodeError:
        pass

    # Netscape format: domain, includeSubdomains, path, secure, expiry, name, value.
    cookies = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        http_only = line.startswith("#HttpOnly_")
        if line.startswith("#") and not http_only:
            continue
        if http_only:
            line = line[len("#HttpOnly_"):]
        parts = line.split("\t")
        if len(parts) != 7:
            continue
        domain, _include_subdomains, path, secure, expiry, name, value = parts
        cookie = {"domain": domain, "path": path or "/", "secure": secure.upper() == "TRUE",
                  "httpOnly": http_only, "name": name, "value": value}
        try:
            expiration = int(expiry)
            if expiration > 0:
                cookie["expiry"] = expiration
        except (TypeError, ValueError):
            pass
        cookies.append(cookie)
    if not cookies:
        raise ValueError("Формат cookies не распознан. Нужен JSON-массив или Netscape cookies.txt")
    return cookies
lock = threading.Lock()
state = {"running": False, "page": 0, "found": 0, "message": "Ожидает запуска", "started_at": None, "last_ingest_at": None, "ingest_run_started": None, "blocked_until": None, "last_http_status": None}

def db():
    con = sqlite3.connect(DB_PATH, timeout=20)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout=20000")
    return con

def init_db():
    with db() as c:
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("""CREATE TABLE IF NOT EXISTS lots(
            lot_id TEXT PRIMARY KEY, title TEXT, serial TEXT, rarity TEXT,
            price INTEGER, status TEXT, image_url TEXT, lot_url TEXT,
            first_seen TEXT, last_seen TEXT, active INTEGER DEFAULT 1)""")
        c.execute("""CREATE TABLE IF NOT EXISTS price_history(
            id INTEGER PRIMARY KEY AUTOINCREMENT, lot_id TEXT, price INTEGER,
            status TEXT, observed_at TEXT)""")
        c.execute("""CREATE TABLE IF NOT EXISTS market_snapshots(
            id INTEGER PRIMARY KEY AUTOINCREMENT, observed_at TEXT NOT NULL, source TEXT,
            active_lots INTEGER, priced INTEGER, min_price REAL, max_price REAL,
            avg_price REAL, median_price REAL)""")
        c.execute("""CREATE TABLE IF NOT EXISTS support_payments(
            intent_id TEXT PRIMARY KEY, user_id INTEGER, amount INTEGER, test INTEGER,
            status TEXT, error TEXT, created_at TEXT, updated_at TEXT)""")
        c.execute("CREATE INDEX IF NOT EXISTS idx_snapshots_date ON market_snapshots(observed_at)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_history_lot_date ON price_history(lot_id, observed_at)")
        c.execute("CREATE INDEX IF NOT EXISTS idx_lots_active_price ON lots(active, price)")
init_db()

def record_snapshot(source):
    """Store one point-in-time summary of the currently active offers (not completed sales)."""
    now = datetime.now(timezone.utc).isoformat()
    with db() as c:
        total = c.execute("SELECT COUNT(*) FROM lots WHERE active=1").fetchone()[0]
        prices = [r[0] for r in c.execute("SELECT price FROM lots WHERE active=1 AND price IS NOT NULL")]
        summ = market_summary(prices)
        c.execute("""INSERT INTO market_snapshots(observed_at,source,active_lots,priced,min_price,max_price,avg_price,median_price)
                     VALUES(?,?,?,?,?,?,?,?)""",
                  (now, source, total, summ["priced"], summ["min"], summ["max"], summ["avg"], summ["median"]))
    log.info("snapshot recorded source=%s active=%d priced=%d", source, total, summ["priced"])
    return now

def deactivate_unseen(since_iso):
    """After a COMPLETE pass, lots not seen since the pass began are no longer listed."""
    with db() as c:
        n = c.execute("UPDATE lots SET active=0 WHERE active=1 AND last_seen < ?", (since_iso,)).rowcount
    log.info("deactivated %d lots not seen since %s", n, since_iso)
    return n

def money(text):
    if not text: return None
    digits = re.sub(r"[^0-9]", "", text)
    return int(digits) if digits else None

def parse_cards(html):
    soup = BeautifulSoup(html, "html.parser")
    cards = soup.select("a.mk-gcard[href*='/market/lot/']")
    # Huevo's markup may change; fall back to numeric lot links rather than
    # treating a renamed/missing CSS class as an empty market.
    if not cards:
        cards = soup.select("a[href*='/market/lot/']")

    def field(card, selectors):
        for selector in selectors:
            element = card.select_one(selector)
            if not element:
                continue
            value = element.get_text(" ", strip=True)
            if not value:
                for attr in ("data-price", "data-title", "content", "value", "aria-label"):
                    value = str(element.get(attr) or "").strip()
                    if value:
                        break
            if value:
                return value
        return ""

    rows = []
    now = datetime.now(timezone.utc).isoformat()
    for card in cards:
        href = str(card.get("href", "")).strip()
        match = re.search(r"/market/lot/(\d+)", href)
        if not match:
            continue
        lot_id = match.group(1)
        title = field(card, [".mk-gtitle", "[class*='title']", "[class*='name']", "h2", "h3"])
        serial = field(card, [".mk-gserial", "[class*='serial']", "[class*='number']"])
        rarity = field(card, [".mk-gsub", "[class*='rarity']", "[class*='collection']"])
        price = money(field(card, [".mk-price", ".mk-gprice", "[class*='price']", "[data-price]"]))
        status = field(card, [".mk-status", "[class*='status']"]) or "Неизвестно"
        image = card.select_one("img")
        image_src = ""
        if image:
            for attr in ("src", "data-src", "data-original", "data-lazy-src"):
                image_src = str(image.get(attr) or "").strip()
                if image_src and not image_src.startswith("data:"):
                    break
            if image_src.startswith("data:"):
                image_src = ""
        image_url = urljoin(BASE_URL, image_src) if image_src else ""
        try:
            image_parts = urlsplit(image_url)
            if image_parts.scheme != "https" or not image_parts.netloc or image_parts.username or image_parts.password:
                image_url = ""
        except ValueError:
            image_url = ""
        try:
            candidate_url = urljoin(BASE_URL, href)
            parts = urlsplit(candidate_url)
            host = (parts.hostname or "").lower()
            lot_url = candidate_url if parts.scheme == "https" and is_huevo_host(host) else f"{BASE_URL}/market/lot/{lot_id}"
        except ValueError:
            lot_url = f"{BASE_URL}/market/lot/{lot_id}"
        title = title or (str(image.get("alt") or "").strip() if image else "") or str(card.get("aria-label") or "").strip() or "Без названия"
        rows.append({"lot_id": lot_id, "title": title, "serial": serial,
                     "rarity": rarity, "price": price, "status": status,
                     "image_url": image_url, "lot_url": lot_url,
                     "observed_at": now})
    return rows, len(cards)

def make_browser():
    """Headless Chromium with the default direct network route."""
    options = Options()
    options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-gpu")
    options.add_argument("--window-size=1440,1000")
    return webdriver.Chrome(options=options)


def crawl():
    now = datetime.now(timezone.utc)
    with lock:
        blocked_until = state.get("blocked_until")
        if blocked_until:
            try:
                cooldown_end = datetime.fromisoformat(blocked_until)
                if cooldown_end > now:
                    state["message"] = (
                        f"Сбор на паузе после ограничения Huevo до "
                        f"{cooldown_end.strftime('%Y-%m-%d %H:%M UTC')}; запросы не отправляются."
                    )
                    return
                state["blocked_until"] = None
                state["last_http_status"] = None
            except (TypeError, ValueError):
                state["blocked_until"] = None
        if state["running"]: return
        state.update(running=True, page=0, found=0, message="Сбор запущен",
                     started_at=now.isoformat())
    seen_this_run = set()
    try:
        browser = make_browser()
        try:
            if not HUEVO_COOKIES_EXPORT:
                raise RuntimeError("Не задан HUEVO_COOKIES_JSON или HUEVO_COOKIES в Environment. Поддерживаются JSON-экспорт и Netscape cookies.txt; cookies должны принадлежать выбранному домену и действующей сессии.")
            try:
                cookies = load_cookie_export(HUEVO_COOKIES_EXPORT)
            except ValueError as exc:
                raise RuntimeError(str(exc)) from exc
            if not cookies:
                raise RuntimeError("В экспорте не найдено cookies с полями name и value.")
            accepted = 0
            rejected = 0
            allowed_keys = {"name", "value", "path", "domain", "secure", "httpOnly", "expiry", "sameSite"}
            visited_cookie_hosts = set()
            for raw_cookie in cookies:
                if not isinstance(raw_cookie, dict) or not raw_cookie.get("name") or "value" not in raw_cookie:
                    continue
                domain_raw = str(raw_cookie.get("domain", _base_parts.hostname)).strip().lower()
                domain = domain_raw.lstrip(".")
                if not is_huevo_host(domain):
                    continue
                if domain not in visited_cookie_hosts:
                    try:
                        browser.get("https://" + domain + "/")
                        visited_cookie_hosts.add(domain)
                    except Exception as exc:
                        log.warning("cookies: cannot open %s to install cookies (%s)", domain, classify_network_error(exc))
                        rejected += 1
                        continue
                cookie = {k: v for k, v in raw_cookie.items() if k in allowed_keys}
                cookie["domain"] = domain_raw
                if "expiry" in cookie:
                    try:
                        cookie["expiry"] = int(float(cookie["expiry"]))
                    except (TypeError, ValueError, OverflowError):
                        cookie.pop("expiry", None)
                if cookie.get("sameSite") not in ("Strict", "Lax", "None"):
                    cookie.pop("sameSite", None)
                if "httpOnly" in cookie:
                    cookie["httpOnly"] = bool(cookie["httpOnly"])
                if "secure" in cookie:
                    cookie["secure"] = bool(cookie["secure"])
                try:
                    browser.add_cookie(cookie)
                    accepted += 1
                except Exception:
                    # Expired, partitioned, or domain-incompatible cookies cannot be installed by Selenium.
                    rejected += 1
                    continue
            log.info("cookies: accepted=%d rejected=%d hosts=%s (values never logged)", accepted, rejected, sorted(visited_cookie_hosts))
            if not accepted:
                raise RuntimeError("Ни одна cookie не применена. Проверь домен экспорта: cookies huevo.su не авторизуют huevo.departament.site и наоборот.")

            # Verify the session from the actual root/login entry point first.
            browser.get(BASE_URL + "/")
            WebDriverWait(browser, 20).until(lambda d: d.execute_script("return document.readyState") == "complete")
            time.sleep(1)
            body_text = browser.find_element("tag name", "body").text[:2000]
            heading_text = " ".join(
                element.text.strip() for element in browser.find_elements("css selector", "h1, h2")
                if element.is_displayed() and element.text.strip()
            )[:300]
            has_market_cards = bool(browser.find_elements("css selector", "a[href*='/market/lot/']"))
            password_visible = any(
                element.is_displayed()
                for element in browser.find_elements("css selector", "input[type='password']")
            )
            if looks_like_login_page(
                browser.current_url, browser.title, heading_text, body_text,
                password_visible=password_visible, has_market_cards=has_market_cards,
            ):
                raise RuntimeError(
                    "После загрузки cookies корневая страница Huevo показывает форму/маршрут входа. "
                    "Возможны cookies от другого домена, истёкшая сессия или привязка авторизации к браузеру. "
                    "Выключение 2FA не делает старые cookies действительными."
                )

            browser.get(f"{BASE_URL}/market/gifts?page=1")
            WebDriverWait(browser, 20).until(lambda d: d.execute_script("return document.readyState") == "complete")
            time.sleep(1)
            market_text = browser.find_element("tag name", "body").text[:2000]
            heading_text = " ".join(
                element.text.strip() for element in browser.find_elements("css selector", "h1, h2")
                if element.is_displayed() and element.text.strip()
            )[:300]
            has_market_cards = bool(browser.find_elements("css selector", "a[href*='/market/lot/']"))
            password_visible = any(
                element.is_displayed()
                for element in browser.find_elements("css selector", "input[type='password']")
            )
            if looks_like_login_page(
                browser.current_url, browser.title, heading_text, market_text,
                password_visible=password_visible, has_market_cards=has_market_cards,
            ):
                raise RuntimeError(
                    "Корневая страница открылась, но маркет перенаправил на вход. "
                    "Сессия cookies не авторизовала целевой раздел или нужна дополнительная авторизация."
                )
        except Exception:
            browser.quit()
            raise
        previous_ids = []
        stop_reason = "достигнут MAX_PAGES"
        reached_end = False
        try:
            for page in range(1, MAX_PAGES + 1):
                t0 = time.monotonic()
                with lock: state.update(page=page, message=f"Открывается страница {page} через Selenium")
                url = f"{BASE_URL}/market/gifts?page={page}"
                log.info("crawl page=%d open %s", page, url)
                browser.get(url)
                WebDriverWait(browser, 20).until(lambda d: d.execute_script("return document.readyState") == "complete")
                time.sleep(1.5)
                body_text = browser.find_element("tag name", "body").text[:2000]
                rows, card_count = parse_cards(browser.page_source)
                probe = classify_page(
                    browser.current_url, browser.title, body_text, card_count,
                    expected_hosts={h for h in ALLOWED_HUEVO_HOSTS} | {"www." + h for h in ALLOWED_HUEVO_HOSTS},
                    password_visible=any(e.is_displayed() for e in browser.find_elements("css selector", "input[type='password']")),
                )
                log.info("crawl page=%d verdict=%s host=%s title=%r body_len=%d cards=%d parsed=%d %.1fs",
                         page, probe["verdict"], probe["final_host"], probe["title"],
                         probe["body_length"], card_count, len(rows), time.monotonic() - t0)
                if probe["verdict"] == "blocked":
                    raise RuntimeError(
                        f"Huevo вернул страницу ограничения доступа (HTTP {probe['status_class_inferred']}). "
                        "Сбор остановлен без повторных запросов; проверьте разрешённый способ доступа."
                    )
                if not rows:
                    if page == 1:
                        raise RuntimeError(f"Страница 1: {VERDICT_HINTS.get(probe['verdict'], probe['verdict'])} "
                                           f"(host={probe['final_host']}, title={probe['title']!r}, body={probe['body_length']} симв.)")
                    stop_reason = f"страница {page} без карточек (конец каталога)"
                    reached_end = True
                    break
                ids = [r["lot_id"] for r in rows]
                if not next_page_is_new(previous_ids, ids):
                    # Site ignored ?page=N or the catalog ended by repeating the last page.
                    stop_reason = f"страница {page} не содержит новых лотов"
                    log.warning("crawl stop: %s", stop_reason)
                    reached_end = True
                    break
                previous_ids = ids
                new_lots = updated_lots = 0
                with db() as c:
                    for row in rows:
                        seen_this_run.add(row["lot_id"])
                        old = c.execute("SELECT price,status,first_seen FROM lots WHERE lot_id=?", (row["lot_id"],)).fetchone()
                        first = old["first_seen"] if old else row["observed_at"]
                        c.execute("""INSERT INTO lots(lot_id,title,serial,rarity,price,status,image_url,lot_url,first_seen,last_seen,active)
                        VALUES(?,?,?,?,?,?,?,?,?,?,1)
                        ON CONFLICT(lot_id) DO UPDATE SET title=excluded.title,serial=excluded.serial,
                        rarity=excluded.rarity,price=excluded.price,status=excluded.status,image_url=excluded.image_url,
                        lot_url=excluded.lot_url,last_seen=excluded.last_seen,active=1""",
                        (row["lot_id"],row["title"],row["serial"],row["rarity"],row["price"],row["status"],row["image_url"],row["lot_url"],first,row["observed_at"]))
                        if not old:
                            new_lots += 1
                        if not old or old["price"] != row["price"] or old["status"] != row["status"]:
                            updated_lots += 1
                            c.execute("INSERT INTO price_history(lot_id,price,status,observed_at) VALUES(?,?,?,?)",
                                      (row["lot_id"],row["price"],row["status"],row["observed_at"]))
                log.info("crawl page=%d saved new=%d changed=%d total_unique=%d", page, new_lots, updated_lots, len(seen_this_run))
                with lock: state["found"] = len(seen_this_run)
                time.sleep(DELAY)
        finally:
            browser.quit()
        log.info("crawl finished: %s; unique lots=%d", stop_reason, len(seen_this_run))
        if not seen_this_run:
            raise RuntimeError("Сбор завершился без единого лота; данные не сохранены.")
        if reached_end:
            deactivate_unseen(now.isoformat())
        else:
            log.warning("crawl incomplete (%s): unseen lots are NOT deactivated", stop_reason)
        record_snapshot("server")
        # Do not mark unseen lots inactive on partial/blocked runs.
        with lock: state["message"] = f"Готово. Уникальных лотов просмотрено: {len(seen_this_run)} (остановка: {stop_reason})"
    except Exception as e:
        message = str(e)
        log.error("crawl failed: %s (%s)", type(e).__name__, classify_network_error(e))
        blocked_status = access_block_status(message)
        with lock:
            if blocked_status:
                cooldown_end = datetime.now(timezone.utc) + timedelta(hours=CRAWL_BLOCK_COOLDOWN_HOURS)
                state["blocked_until"] = cooldown_end.isoformat()
                state["last_http_status"] = blocked_status
                state["message"] = (
                    f"Доступ ограничен (HTTP {blocked_status}). Повторный сбор отложен до "
                    f"{cooldown_end.strftime('%Y-%m-%d %H:%M UTC')}; защита не обходится."
                )
            else:
                state["message"] = f"Ошибка: {message}"
    finally:
        with lock: state["running"] = False

@app.get("/health")
def health():
    return {"ok": True, "service": "Huevo Gift Analytics"}

@app.get("/api/diagnostics")
def diagnostics():
    """Safe configuration check: reports presence flags, never secret values."""
    with db() as c:
        lots_count = c.execute("SELECT COUNT(*) FROM lots").fetchone()[0]
        history_count = c.execute("SELECT COUNT(*) FROM price_history").fetchone()[0]
    with lock:
        crawl_state = dict(state)
    return {
        "ok": True,
        "database_configured": bool(DB_PATH),
        "ingest_token_configured": bool(INGEST_TOKEN),
        "huevo_cookies_configured": bool(HUEVO_COOKIES_EXPORT),
        "huevo_base_url": BASE_URL,
        "cookie_export_format": "JSON or Netscape" if HUEVO_COOKIES_EXPORT else None,
        "lots_in_database": lots_count,
        "price_history_rows": history_count,
        "collector": crawl_state,
    }

@app.get("/", response_class=HTMLResponse)
def home():
    with open(os.path.join(APP_DIR, "static", "index.html"), encoding="utf-8") as f:
        return f.read()

@app.post("/api/ingest")
async def ingest_browser_data(request: Request, token: str = ""):
    """Accept gift lots parsed by the user's logged-in browser on huevo.su."""
    if not INGEST_TOKEN:
        raise HTTPException(status_code=503, detail="На Render не задан INGEST_TOKEN")
    # Prefer Authorization so the secret is not copied into query-string access logs.
    authorization = request.headers.get("authorization", "")
    header_token = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    supplied_token = header_token or token
    if not supplied_token or not hmac.compare_digest(supplied_token, INGEST_TOKEN):
        raise HTTPException(status_code=403, detail="Неверный токен сбора")
    # Read with a hard cap so a misconfigured or abused collector cannot post an unbounded body.
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 2_000_000:
            raise HTTPException(status_code=413, detail="Слишком большой пакет. Передавайте не более 1000 лотов за раз.")
    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError, TypeError):
        raise HTTPException(status_code=400, detail="Ожидается корректный JSON")
    rows = payload.get("lots") if isinstance(payload, dict) else None
    if not isinstance(rows, list) or len(rows) > 1000:
        raise HTTPException(status_code=400, detail="Поле lots должно быть списком до 1000 записей")
    now = datetime.now(timezone.utc).isoformat()
    saved = 0
    with db() as c:
        for item in rows:
            if not isinstance(item, dict):
                continue
            lot_id = str(item.get("lot_id", "")).strip()
            if not re.fullmatch(r"\d{1,20}", lot_id):
                continue
            title = str(item.get("title", ""))[:500]
            serial = str(item.get("serial", ""))[:200]
            rarity = str(item.get("rarity", ""))[:100]
            status = str(item.get("status", "Неизвестно"))[:100]
            image_url = str(item.get("image_url", ""))[:2000].strip()
            # Images may live on Huevo's CDN, but only HTTPS URLs are rendered by the dashboard.
            try:
                image_parts = urlsplit(image_url)
                if image_parts.scheme != "https" or not image_parts.netloc or image_parts.username or image_parts.password:
                    image_url = ""
            except ValueError:
                image_url = ""
            default_lot_url = f"{BASE_URL}/market/lot/{lot_id}"
            candidate_url = str(item.get("lot_url", default_lot_url))[:2000].strip()
            try:
                lot_parts = urlsplit(candidate_url)
                host = (lot_parts.hostname or "").lower()
                valid_lot_url = lot_parts.scheme == "https" and is_huevo_host(host) and not lot_parts.username and not lot_parts.password
            except ValueError:
                valid_lot_url = False
            lot_url = candidate_url if valid_lot_url else default_lot_url
            raw_price = item.get("price")
            try:
                price = int(raw_price) if raw_price is not None else None
                if price is not None and price < 0: price = None
            except (TypeError, ValueError):
                price = None
            old = c.execute("SELECT price,status,first_seen FROM lots WHERE lot_id=?", (lot_id,)).fetchone()
            first = old["first_seen"] if old else now
            c.execute("""INSERT INTO lots(lot_id,title,serial,rarity,price,status,image_url,lot_url,first_seen,last_seen,active)
                VALUES(?,?,?,?,?,?,?,?,?,?,1)
                ON CONFLICT(lot_id) DO UPDATE SET title=excluded.title,serial=excluded.serial,rarity=excluded.rarity,
                price=excluded.price,status=excluded.status,image_url=excluded.image_url,lot_url=excluded.lot_url,
                last_seen=excluded.last_seen,active=1""",
                (lot_id,title,serial,rarity,price,status,image_url,lot_url,first,now))
            if not old or old["price"] != price or old["status"] != status:
                c.execute("INSERT INTO price_history(lot_id,price,status,observed_at) VALUES(?,?,?,?)", (lot_id,price,status,now))
            saved += 1
    with lock:
        if not state.get("ingest_run_started"):
            state["ingest_run_started"] = now
        state["message"] = f"Браузерный импорт: сохранено {saved} лотов (проход не завершён)"
        state["found"] = saved
        state["last_ingest_at"] = now
    return {"ok": True, "saved": saved, "received": len(rows), "observed_at": now}

@app.post("/api/ingest/complete")
async def ingest_complete(request: Request):
    """Called by the browser collector after the last page. Body: {"reached_end": bool}.

    Only a pass that reached the end of the catalog deactivates lots it did not see.
    """
    _require_token(request)
    try:
        payload = await request.json()
    except Exception:
        payload = {}
    reached_end = bool(isinstance(payload, dict) and payload.get("reached_end"))
    with lock:
        started = state.get("ingest_run_started")
        state["ingest_run_started"] = None
    deactivated = 0
    if reached_end and started:
        deactivated = deactivate_unseen(started)
    snapshot_at = record_snapshot("browser") if started else None
    with lock:
        state["message"] = ("Браузерный сбор завершён" if reached_end else "Браузерный сбор прерван: неполный проход, активность лотов не менялась")
    return {"ok": True, "deactivated": deactivated, "snapshot_at": snapshot_at, "complete": reached_end}

@app.get("/api/deals")
def deals(limit: int = 20):
    """Offers well below the median of same-title active offers. A hint, not a valuation."""
    limit = max(1, min(limit, 100))
    with db() as c:
        rows = [dict(r) for r in c.execute("SELECT * FROM lots WHERE active=1 AND price IS NOT NULL")]
    return {"method": "price <= 85% of the median of >=3 active offers with the same title",
            "note": "Это текущие предложения, а не цены завершённых продаж.",
            "deals": find_deals(rows, limit=limit)}

@app.get("/api/analytics/snapshots")
def snapshots(days: int = 30):
    days = max(1, min(int(days), 365))
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    with db() as c:
        rows = c.execute("""SELECT observed_at,source,active_lots,priced,min_price,max_price,avg_price,median_price
                            FROM market_snapshots WHERE observed_at>=? ORDER BY observed_at""", (cutoff,)).fetchall()
    return {"days": days, "points": [dict(r) for r in rows]}

@app.post("/api/crawl")
def start_crawl(request: Request, background: BackgroundTasks):
    _require_token(request)
    with lock:
        blocked_until = state.get("blocked_until")
        if blocked_until:
            try:
                cooldown_end = datetime.fromisoformat(blocked_until)
                remaining = int((cooldown_end - datetime.now(timezone.utc)).total_seconds())
                if remaining > 0:
                    raise HTTPException(
                        status_code=429,
                        detail=f"Сбор приостановлен после блокировки Huevo до {cooldown_end.strftime('%Y-%m-%d %H:%M UTC')}.",
                        headers={"Retry-After": str(remaining)},
                    )
                state["blocked_until"] = None
                state["last_http_status"] = None
            except ValueError:
                state["blocked_until"] = None
    if not HUEVO_COOKIES_EXPORT:
        raise HTTPException(
            status_code=503,
            detail="Серверная сессия Huevo не настроена. Задайте HUEVO_BASE_URL и HUEVO_COOKIES_JSON (JSON) или HUEVO_COOKIES (Netscape cookies.txt) в Environment.",
        )
    with lock:
        if state["running"]:
            return {"ok": True, "message": "Сбор уже выполняется"}
    background.add_task(crawl)
    return {"ok": True, "message": "Сбор запущен"}

AUTO_REFRESH_HOURS = max(1, int(os.getenv("AUTO_REFRESH_HOURS", "2")))

def scheduled_crawler():
    # Scan at startup, then respect the configured full-scan interval.
    time.sleep(5)
    while True:
        try:
            if not state["running"]:
                crawl()
        except Exception as exc:
            with lock:
                state["message"] = f"Ошибка планового обновления: {exc}"
                state["running"] = False
        time.sleep(AUTO_REFRESH_HOURS * 3600)

@app.on_event("startup")
def start_scheduler():
    # Do not start a crawler that is guaranteed to fail without an authenticated session.
    if HUEVO_COOKIES_EXPORT:
        threading.Thread(target=scheduled_crawler, name="huevo-auto-refresh", daemon=True).start()
    else:
        with lock:
            state["message"] = "Ожидает браузерного сбора: серверная сессия Huevo не настроена"

DIAG_COOLDOWN_SECONDS = max(60, int(os.getenv("DIAG_COOLDOWN_SECONDS", "300")))
diag_lock = threading.Lock()
diag_last_at = 0.0

def _require_token(request):
    if not INGEST_TOKEN:
        raise HTTPException(status_code=503, detail="INGEST_TOKEN не задан")
    authorization = request.headers.get("authorization", "")
    supplied = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    if not supplied or not hmac.compare_digest(supplied, INGEST_TOKEN):
        raise HTTPException(status_code=403, detail="Неверный токен")

@app.post("/api/diagnose-huevo")
def diagnose_huevo(request: Request):
    """One read-only probe: open / and /market/gifts?page=1 and report a coarse verdict.

    Requires `Authorization: Bearer <INGEST_TOKEN>`, is throttled, refuses to run
    during a block cooldown or a crawl, and returns no cookies or page content.
    """
    _require_token(request)
    global diag_last_at
    with lock:
        if state["running"]:
            raise HTTPException(status_code=409, detail="Идёт сбор; диагностика не запускается параллельно")
        blocked_until = state.get("blocked_until")
        if blocked_until and datetime.fromisoformat(blocked_until) > datetime.now(timezone.utc):
            raise HTTPException(status_code=429, detail=f"Пауза после блокировки до {blocked_until}; запросы к Huevo не отправляются")
    if not diag_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="Диагностика уже выполняется")
    try:
        remaining = DIAG_COOLDOWN_SECONDS - (time.monotonic() - diag_last_at)
        if diag_last_at and remaining > 0:
            raise HTTPException(status_code=429, detail=f"Повторите через {int(remaining) + 1} с",
                                headers={"Retry-After": str(int(remaining) + 1)})
        diag_last_at = time.monotonic()
        hosts = set(ALLOWED_HUEVO_HOSTS) | {"www." + h for h in ALLOWED_HUEVO_HOSTS}
        result = {"base_url": BASE_URL, "cookies_configured": bool(HUEVO_COOKIES_EXPORT), "steps": []}
        browser = None
        try:
            browser = make_browser()
            browser.set_page_load_timeout(30)
            if HUEVO_COOKIES_EXPORT:
                # Same cookie install as the crawler would do, but only for BASE_URL's host.
                browser.get(BASE_URL + "/")
                installed = 0
                for c in load_cookie_export(HUEVO_COOKIES_EXPORT):
                    dom = str(c.get("domain", _base_parts.hostname)).strip().lower().lstrip(".")
                    if dom != _base_parts.hostname and not dom.endswith("." + _base_parts.hostname):
                        continue
                    ck = {k: v for k, v in c.items() if k in {"name", "value", "path", "domain", "secure", "httpOnly", "expiry"}}
                    try:
                        if "expiry" in ck: ck["expiry"] = int(float(ck["expiry"]))
                        browser.add_cookie(ck); installed += 1
                    except Exception:
                        pass
                result["cookies_installed_for_base_host"] = installed
            for name, path in (("root", "/"), ("market_page_1", "/market/gifts?page=1")):
                step = {"step": name, "path": path}
                try:
                    browser.get(BASE_URL + path)
                    WebDriverWait(browser, 20).until(lambda d: d.execute_script("return document.readyState") == "complete")
                    time.sleep(1)
                    body = browser.find_element("tag name", "body").text[:2000]
                    _, cards = parse_cards(browser.page_source)
                    step.update(classify_page(
                        browser.current_url, browser.title, body, cards, expected_hosts=hosts,
                        password_visible=any(e.is_displayed() for e in browser.find_elements("css selector", "input[type='password']"))))
                    step["hint"] = VERDICT_HINTS[step["verdict"]]
                except Exception as exc:
                    cause = classify_network_error(exc)
                    step.update(verdict="network_error", cause=cause,
                                hint={"dns": "DNS не разрешает домен (узел/прокси или недоступность источника).",
                                      "tls": "Ошибка TLS при подключении.",
                                      "timeout": "Тайм-аут соединения.",
                                      "connect": "Соединение отклонено или сброшено."}.get(cause, "Неклассифицированная сетевая ошибка: " + type(exc).__name__))
                result["steps"].append(step)
                log.info("diagnose step=%s verdict=%s host=%s cards=%s", name, step.get("verdict"), step.get("final_host"), step.get("cards"))
                if step.get("verdict") in ("blocked", "network_error"):
                    break  # never keep sending requests after a block or network failure
        except HTTPException:
            raise
        except Exception as exc:
            result["error"] = f"{type(exc).__name__}: {classify_network_error(exc)}"
            log.error("diagnose failed: %s", result["error"])
        finally:
            if browser is not None:
                try: browser.quit()
                except Exception: pass
        blocked = next((s_["status_class_inferred"] for s_ in result["steps"] if s_.get("verdict") == "blocked"), None)
        if blocked:
            with lock:
                state["blocked_until"] = (datetime.now(timezone.utc) + timedelta(hours=CRAWL_BLOCK_COOLDOWN_HOURS)).isoformat()
                state["last_http_status"] = blocked
        return result
    finally:
        diag_lock.release()

@app.get("/api/status")
def get_status():
    with lock: return dict(state)

@app.get("/api/stats")
def stats():
    with db() as c:
        row = c.execute("""SELECT
        (SELECT COUNT(*) FROM lots WHERE active=1) n_total,
        COUNT(*) n, COUNT(DISTINCT title) kinds,
        MIN(price) minp, MAX(price) maxp, AVG(price) avgp, SUM(price) total
        FROM lots WHERE active=1 AND price IS NOT NULL""").fetchone()
        return dict(row)

@app.get("/api/lots")
def lots(q: str = "", sort: str = "price", limit: int = 500):
    # Keep lots without a parsed price at the end, not ahead of priced offers.
    allowed = {"price":"price IS NULL ASC, price ASC", "price_desc":"price IS NULL ASC, price DESC", "title":"title COLLATE NOCASE ASC", "recent":"last_seen DESC", "new":"first_seen DESC, CAST(lot_id AS INTEGER) DESC"}
    order = allowed.get(sort, allowed["price"])
    limit = max(1, min(limit, 2000))
    with db() as c:
        rows = c.execute(f"""SELECT * FROM lots WHERE active=1 AND (title LIKE ? OR lot_id LIKE ?)
        ORDER BY {order} LIMIT ?""", (f"%{q}%", f"%{q}%", limit)).fetchall()
        return [dict(r) for r in rows]

@app.get("/api/analytics/price-history")
def analytics_price_history(days: int = 7, lot_id: str = ""):
    """Daily aggregates of stored price-change observations; these are not completed sale prices."""
    days = max(1, min(int(days), 90))
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days - 1)).date().isoformat()
    with db() as c:
        if lot_id:
            if not re.fullmatch(r"\d{1,20}", str(lot_id)):
                raise HTTPException(status_code=400, detail="Некорректный ID лота")
            rows = c.execute("""
                SELECT substr(observed_at, 1, 10) AS day,
                       AVG(price) AS avg_price,
                       COUNT(*) AS snapshots
                FROM price_history
                WHERE lot_id=? AND price IS NOT NULL AND date(observed_at)>=?
                GROUP BY substr(observed_at, 1, 10)
                ORDER BY day
            """, (lot_id, cutoff)).fetchall()
        else:
            rows = c.execute("""
                SELECT substr(observed_at, 1, 10) AS day,
                       AVG(price) AS avg_price,
                       COUNT(*) AS snapshots
                FROM price_history
                WHERE price IS NOT NULL AND date(observed_at)>=?
                GROUP BY substr(observed_at, 1, 10)
                ORDER BY day
            """, (cutoff,)).fetchall()
    points = [{"day": row["day"], "avg_price": round(row["avg_price"], 2),
               "snapshots": row["snapshots"]} for row in rows]
    return {"days": days, "lot_id": lot_id or None, "points": points}

@app.get("/api/history/{lot_id}")
def history(lot_id: str):
    with db() as c:
        return [dict(r) for r in c.execute("SELECT price,status,observed_at FROM price_history WHERE lot_id=? ORDER BY observed_at", (lot_id,))]


# ---------------------------------------------------------------- highlights

def _public_lot(row):
    return {k: row[k] for k in ("lot_id", "title", "serial", "rarity", "price", "status", "image_url", "lot_url", "first_seen", "last_seen")}

@app.get("/api/highlights")
def highlights():
    """Two headline cards: newest observed lot and best value versus the market reference."""
    with db() as c:
        latest = c.execute("""SELECT * FROM lots WHERE active=1
                              ORDER BY first_seen DESC, CAST(lot_id AS INTEGER) DESC LIMIT 1""").fetchone()
        runs = c.execute("SELECT COUNT(*) FROM market_snapshots").fetchone()[0]
        active = [dict(r) for r in c.execute("SELECT * FROM lots WHERE active=1 AND price IS NOT NULL")]
        gone = [dict(r) for r in c.execute("SELECT title,price FROM lots WHERE active=0 AND price IS NOT NULL")]
    best = best_value(active, gone, limit=3)
    return {
        "latest": _public_lot(latest) if latest else None,
        "latest_note": ("Время выставления сайт не отдаёт: показан лот, замеченный сборщиком последним "
                        "(при равенстве — с наибольшим ID). Точность растёт с каждым проходом."
                        + ("" if runs >= 2 else " Пока был один проход, все лоты замечены одновременно.")),
        "best": best[0] if best else None,
        "runner_up": best[1:] if len(best) > 1 else [],
        "best_note": ("Эталон — медиана последних цен лотов того же названия, ушедших с рынка (вероятно проданы или сняты: "
                      "сайт не раскрывает причину). Если таких меньше трёх, берётся медиана активных предложений; "
                      "основа указана в карточке. Это не цены завершённых сделок."),
    }

@app.get("/api/drops")
def price_drops(limit: int = 12):
    """Active lots whose latest recorded price is lower than the previous recorded one."""
    limit = max(1, min(limit, 100))
    with db() as c:
        rows = c.execute("""
            WITH ranked AS (
              SELECT lot_id, price, observed_at,
                     ROW_NUMBER() OVER (PARTITION BY lot_id ORDER BY observed_at DESC, id DESC) rn
              FROM price_history WHERE price IS NOT NULL)
            SELECT l.lot_id, l.title, l.price, l.lot_url, l.image_url, p.price AS previous_price, r.observed_at AS changed_at
            FROM ranked r JOIN ranked p ON p.lot_id=r.lot_id AND p.rn=2
            JOIN lots l ON l.lot_id=r.lot_id
            WHERE r.rn=1 AND l.active=1 AND r.price < p.price
            ORDER BY (p.price - r.price) * 1.0 / p.price DESC LIMIT ?""", (limit,)).fetchall()
    return [{**dict(r), "drop_pct": round((1 - r["price"] / r["previous_price"]) * 100, 1)} for r in rows]

# ---------------------------------------------------------------- support the author (huEVO Apps payments)
# Flow from https://huevo-docs.lunnaholy.workers.dev/apps/monetization/payments/ :
# server creates intent -> frontend huevo.confirmPayment(intent_id) -> server verifies status
# via GET /payments/{id} or a signed callback. Nothing is granted from the frontend result.

HUEVO_CLIENT_ID = os.getenv("HUEVO_CLIENT_ID", "").strip()
HUEVO_CLIENT_SECRET = os.getenv("HUEVO_CLIENT_SECRET", "").strip()
SUPPORT_AMOUNTS = [5, 10, 50, 100]

def support_enabled():
    return bool(HUEVO_CLIENT_ID and HUEVO_CLIENT_SECRET)

def huevo_api(method, path, body=None):
    """Documented Apps API call (Basic auth). Returns (http_status, json_dict)."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        support.API_BASE + path, data=data, method=method,
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

def _store_payment(intent_id, status, error=None):
    """Idempotent status update; a final status is never overwritten (docs: it cannot change)."""
    now = datetime.now(timezone.utc).isoformat()
    with db() as c:
        row = c.execute("SELECT status FROM support_payments WHERE intent_id=?", (intent_id,)).fetchone()
        if not row or row["status"] in support.FINAL_STATUSES:
            return False
        c.execute("UPDATE support_payments SET status=?, error=?, updated_at=? WHERE intent_id=?",
                  (status, error, now, intent_id))
    return True

@app.get("/api/support/config")
def support_config():
    return {"enabled": support_enabled(), "amounts": SUPPORT_AMOUNTS, "sdk_url": "https://huevo.su/static/js/huevo-apps-v1.js",
            "origins": list(ALLOWED_HUEVO_HOSTS)}

@app.post("/api/support/intent")
async def support_intent(request: Request):
    if not support_enabled():
        raise HTTPException(status_code=503, detail="Приём поддержки не настроен (нужны HUEVO_CLIENT_ID и HUEVO_CLIENT_SECRET).")
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Ожидается JSON")
    amount = support.clean_amount(payload.get("amount") if isinstance(payload, dict) else None)
    if amount is None:
        raise HTTPException(status_code=400, detail=f"Сумма — целое число от {support.MIN_AMOUNT} до {support.MAX_AMOUNT}.")
    launch = support.verify_launch(str(payload.get("launch_query", "")), HUEVO_CLIENT_SECRET)
    if not launch or not str(launch.get("hu_user_id", "")).isdigit():
        raise HTTPException(status_code=401, detail="Откройте приложение внутри huEVO: подпись запуска не подтверждена.")
    test = support.is_test_session(launch)
    body = support.payment_body(launch["hu_user_id"], amount, test)
    status, data = huevo_api("POST", "/payments", body)
    if status != 200 or not data.get("ok") or not data.get("intent_id"):
        code = (data.get("error") or {}).get("code") if isinstance(data.get("error"), dict) else None
        log.warning("create intent failed http=%s code=%s", status, code)
        raise HTTPException(status_code=502, detail=f"huEVO не создал платёж ({code or 'нет ответа'}).")
    now = datetime.now(timezone.utc).isoformat()
    with db() as c:
        c.execute("INSERT OR IGNORE INTO support_payments(intent_id,user_id,amount,test,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
                  (data["intent_id"], int(launch["hu_user_id"]), amount, int(test), "pending", now, now))
    return {"ok": True, "intent_id": data["intent_id"], "amount": amount, "test": test}

@app.get("/api/support/status/{intent_id}")
def support_status(intent_id: str):
    if not re.fullmatch(r"pi_[A-Za-z0-9_-]{1,80}", intent_id):
        raise HTTPException(status_code=400, detail="Некорректный intent_id")
    with db() as c:
        row = c.execute("SELECT * FROM support_payments WHERE intent_id=?", (intent_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Платёж не найден")
    status = row["status"]
    if status == "pending" and support_enabled():
        http, data = huevo_api("GET", "/payments/" + intent_id)
        if http == 200 and data.get("status") in ("pending", "succeeded", "failed", "cancelled", "expired"):
            status = data["status"]
            if status != "pending":
                _store_payment(intent_id, status, data.get("error"))
    return {"intent_id": intent_id, "status": status, "test": bool(row["test"])}

@app.post("/api/support/callback")
async def support_callback(request: Request):
    """Signed payment callback. Any 2xx counts as delivered; duplicates are deduplicated by intent_id."""
    raw = await request.body()
    if len(raw) > 20_000 or not support.verify_callback(raw, request.headers.get("x-huevo-signature", ""), HUEVO_CLIENT_SECRET):
        raise HTTPException(status_code=401, detail="bad signature")
    try:
        data = json.loads(raw)
        intent_id, status = str(data["intent_id"]), str(data["status"])
    except (ValueError, KeyError, TypeError):
        raise HTTPException(status_code=400, detail="bad payload")
    if status in support.FINAL_STATUSES:
        changed = _store_payment(intent_id, status, data.get("error"))
        log.info("support callback intent=%s status=%s test=%s applied=%s", intent_id, status, data.get("test"), changed)
    return Response(status_code=204)

@app.get("/api/support/stats")
def support_stats():
    """Public thank-you counter: live (non-test) successful payments only. No user data."""
    with db() as c:
        row = c.execute("SELECT COUNT(*) n, COALESCE(SUM(amount),0) total FROM support_payments WHERE status='succeeded' AND test=0").fetchone()
    return {"supporters": row["n"], "total": row["total"]}

app.mount("/static", StaticFiles(directory=os.path.join(APP_DIR, "static")), name="static")