import os, re, time, sqlite3, threading, json, hmac
from datetime import datetime, timezone
from urllib.parse import urljoin, urlsplit
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.support.ui import WebDriverWait
from bs4 import BeautifulSoup
from fastapi import FastAPI, BackgroundTasks, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

BASE_URL = "https://huevo.su"
APP_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.getenv("HUEVO_DB", "huevo.db")
os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
DELAY = float(os.getenv("CRAWL_DELAY", "2.0"))
MAX_PAGES = int(os.getenv("MAX_PAGES", "500"))
app = FastAPI(title="Huevo Gift Analytics")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://huevo.su"],
    allow_credentials=False,
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)
INGEST_TOKEN = os.getenv("INGEST_TOKEN", "")
# JSON array of cookies exported from an already authenticated huevo.su browser.
HUEVO_COOKIES_JSON = os.getenv("HUEVO_COOKIES_JSON", "").strip()
lock = threading.Lock()
state = {"running": False, "page": 0, "found": 0, "message": "Ожидает запуска", "started_at": None, "last_ingest_at": None}

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
init_db()

def money(text):
    if not text: return None
    digits = re.sub(r"[^0-9]", "", text)
    return int(digits) if digits else None

def parse_cards(html):
    soup = BeautifulSoup(html, "html.parser")
    cards = soup.select("a.mk-gcard[href*='/market/lot/']")
    rows = []
    now = datetime.now(timezone.utc).isoformat()
    for card in cards:
        href = card.get("href", "")
        m = re.search(r"/market/lot/(\d+)", href)
        if not m: continue
        lot_id = m.group(1)
        title = (card.select_one(".mk-gtitle").get_text(" ", strip=True)
                 if card.select_one(".mk-gtitle") else "")
        serial = (card.select_one(".mk-gserial").get_text(" ", strip=True)
                  if card.select_one(".mk-gserial") else "")
        rarity = (card.select_one(".mk-gsub").get_text(" ", strip=True)
                  if card.select_one(".mk-gsub") else "")
        price_el = card.select_one(".mk-price, .mk-gprice")
        price = money(price_el.get_text(" ", strip=True) if price_el else "")
        status_el = card.select_one(".mk-status")
        status = status_el.get_text(" ", strip=True) if status_el else "Неизвестно"
        image = card.select_one("img")
        image_url = urljoin(BASE_URL, image.get("src", "")) if image else ""
        rows.append({"lot_id": lot_id, "title": title, "serial": serial,
                     "rarity": rarity, "price": price, "status": status,
                     "image_url": image_url, "lot_url": urljoin(BASE_URL, href),
                     "observed_at": now})
    return rows, len(cards)

def crawl():
    with lock:
        if state["running"]: return
        state.update(running=True, page=0, found=0, message="Сбор запущен",
                     started_at=datetime.now(timezone.utc).isoformat())
    seen_this_run = set()
    try:
        options = Options()
        options.add_argument("--headless=new")
        options.add_argument("--no-sandbox")
        options.add_argument("--disable-dev-shm-usage")
        options.add_argument("--disable-gpu")
        options.add_argument("--window-size=1440,1000")
        browser = webdriver.Chrome(options=options)
        try:
            if not HUEVO_COOKIES_JSON:
                raise RuntimeError("Не задан HUEVO_COOKIES_JSON в Render Environment. Экспортируй cookies авторизованного huevo.su в JSON и добавь их как секрет.")
            try:
                cookies = json.loads(HUEVO_COOKIES_JSON)
            except json.JSONDecodeError as exc:
                raise RuntimeError("HUEVO_COOKIES_JSON должен содержать JSON-массив cookies.") from exc
            if not isinstance(cookies, list) or not cookies:
                raise RuntimeError("HUEVO_COOKIES_JSON должен быть непустым JSON-массивом cookies.")
            # Selenium accepts cookies only after visiting the matching domain.
            browser.get(BASE_URL)
            accepted = 0
            allowed_keys = {"name", "value", "path", "domain", "secure", "httpOnly", "expiry", "sameSite"}
            for raw_cookie in cookies:
                if not isinstance(raw_cookie, dict) or not raw_cookie.get("name") or "value" not in raw_cookie:
                    continue
                domain = str(raw_cookie.get("domain", "huevo.su")).lstrip(".").lower()
                if domain != "huevo.su" and not domain.endswith(".huevo.su"):
                    continue
                cookie = {k: v for k, v in raw_cookie.items() if k in allowed_keys}
                if "expiry" in cookie:
                    try:
                        cookie["expiry"] = int(cookie["expiry"])
                    except (TypeError, ValueError):
                        cookie.pop("expiry", None)
                if cookie.get("sameSite") not in ("Strict", "Lax", "None"):
                    cookie.pop("sameSite", None)
                try:
                    browser.add_cookie(cookie)
                    accepted += 1
                except Exception:
                    # Ignore cookies Chrome refuses (e.g. expired or incompatible).
                    continue
            if not accepted:
                raise RuntimeError("Не удалось применить cookies для huevo.su. Проверь JSON и срок действия сессии.")
            browser.get(f"{BASE_URL}/market/gifts?page=1")
            time.sleep(2)
            auth_text = (browser.title + " " + browser.find_element("tag name", "body").text[:1000]).lower()
            if any(term in auth_text for term in ("войти", "sign in", "log in", "авторизац")):
                raise RuntimeError("Похоже, cookies не авторизовали браузер. Обнови экспорт cookies из Huevo.")
        except Exception:
            browser.quit()
            raise
        empty_streak = 0
        try:
            for page in range(1, MAX_PAGES + 1):
                with lock: state.update(page=page, message=f"Открывается страница {page} через Selenium")
                url = f"{BASE_URL}/market/gifts?page={page}"
                browser.get(url)
                WebDriverWait(browser, 20).until(lambda d: d.execute_script("return document.readyState") == "complete")
                time.sleep(1.5)
                page_text = (browser.title + " " + browser.find_element("tag name", "body").text[:1500]).lower()
                if any(term in page_text for term in ("http error 418", "too many requests", "access denied", "verify you are human")):
                    raise RuntimeError("Huevo показал страницу ограничения доступа/проверки браузера. Selenium не обходит эту защиту; сбор остановлен.")
                rows, card_count = parse_cards(browser.page_source)
                if not rows:
                    empty_streak += 1
                    if page == 1:
                        raise RuntimeError("На первой странице не найдено карточек .mk-gcard. Возможно, изменилась разметка или требуется доступ.")
                    break
                empty_streak = 0
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
                        if not old or old["price"] != row["price"] or old["status"] != row["status"]:
                            c.execute("INSERT INTO price_history(lot_id,price,status,observed_at) VALUES(?,?,?,?)",
                                      (row["lot_id"],row["price"],row["status"],row["observed_at"]))
                with lock: state["found"] = len(seen_this_run)
                time.sleep(DELAY)
        finally:
            browser.quit()
        # Do not mark unseen lots inactive on partial/blocked runs.
        with lock: state["message"] = f"Готово. Уникальных лотов просмотрено: {len(seen_this_run)}"
    except Exception as e:
        with lock: state["message"] = f"Ошибка: {e}"
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
        "huevo_cookies_configured": bool(HUEVO_COOKIES_JSON),
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
                valid_lot_url = lot_parts.scheme == "https" and (host == "huevo.su" or host.endswith(".huevo.su")) and not lot_parts.username and not lot_parts.password
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
        state["message"] = f"Браузерный импорт завершён: сохранено {saved} лотов"
        state["found"] = saved
        state["last_ingest_at"] = now
    return {"ok": True, "saved": saved, "received": len(rows), "observed_at": now}

@app.post("/api/crawl")
def start_crawl(background: BackgroundTasks):
    if not HUEVO_COOKIES_JSON:
        raise HTTPException(
            status_code=503,
            detail="Серверная сессия Huevo не настроена. Откройте Huevo в авторизованном браузере и используйте browser collector из панели; cookies вручную передавать не нужно.",
        )
    with lock:
        if state["running"]:
            return {"ok": True, "message": "Сбор уже выполняется"}
    background.add_task(crawl)
    return {"ok": True, "message": "Сбор запущен"}

AUTO_REFRESH_HOURS = max(1, int(os.getenv("AUTO_REFRESH_HOURS", "2")))
PAGE_ONE_REFRESH_SECONDS = max(5, int(os.getenv("PAGE_ONE_REFRESH_SECONDS", "5")))

def scheduled_crawler():
    # Full market scan at startup, then scan every two hours.
    # Page-one refresh is scheduled separately below to keep the cadence explicit.
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
    if HUEVO_COOKIES_JSON:
        threading.Thread(target=scheduled_crawler, name="huevo-auto-refresh", daemon=True).start()
    else:
        with lock:
            state["message"] = "Ожидает браузерного сбора: серверная сессия Huevo не настроена"

@app.get("/api/status")
def get_status():
    with lock: return dict(state)

@app.get("/api/stats")
def stats():
    with db() as c:
        row = c.execute("""SELECT COUNT(*) n, COUNT(DISTINCT title) kinds,
        MIN(price) minp, MAX(price) maxp, AVG(price) avgp, SUM(price) total
        FROM lots WHERE active=1 AND price IS NOT NULL""").fetchone()
        return dict(row)

@app.get("/api/lots")
def lots(q: str = "", sort: str = "price", limit: int = 500):
    allowed = {"price":"price ASC", "price_desc":"price DESC", "title":"title COLLATE NOCASE ASC", "recent":"last_seen DESC"}
    order = allowed.get(sort, allowed["price"])
    limit = max(1, min(limit, 2000))
    with db() as c:
        rows = c.execute(f"""SELECT * FROM lots WHERE active=1 AND (title LIKE ? OR lot_id LIKE ?)
        ORDER BY {order} LIMIT ?""", (f"%{q}%", f"%{q}%", limit)).fetchall()
        return [dict(r) for r in rows]

@app.get("/api/history/{lot_id}")
def history(lot_id: str):
    with db() as c:
        return [dict(r) for r in c.execute("SELECT price,status,observed_at FROM price_history WHERE lot_id=? ORDER BY observed_at", (lot_id,))]

app.mount("/static", StaticFiles(directory=os.path.join(APP_DIR, "static")), name="static")