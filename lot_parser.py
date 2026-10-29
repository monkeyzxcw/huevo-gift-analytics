"""HTML -> lot rows. Pure (bs4 only), shared by the server crawler and tests.

Markup knowledge comes from the `.mk-g*` classes seen earlier plus generic fallbacks.
It is NOT verified against a live Huevo page; tests use fixtures that model it.
"""
import re
from datetime import datetime, timezone
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup

LOT_PATH = re.compile(r"/market/lot/(\d+)")
_NUMBER = re.compile(r"\d[\d\s  .,]*")


def parse_price(text):
    """First number in the text as int (or float with 1-2 decimals); None if absent.

    Handles thin/non-breaking spaces as thousands separators and decimal comma/dot.
    Does NOT glue several numbers together ("от 100 до 200" -> 100).
    """
    if not text:
        return None
    m = _NUMBER.search(str(text))
    if not m:
        return None
    raw = re.sub(r"[\s  ]", "", m.group(0)).rstrip(".,")
    if not raw:
        return None
    dec = re.fullmatch(r"(\d+)[.,](\d{1,2})", raw)
    if dec:
        value = float(f"{dec.group(1)}.{dec.group(2)}")
        return int(value) if value == int(value) else value
    digits = re.sub(r"[.,]", "", raw)   # remaining separators are thousands
    return int(digits) if digits else None


def _https_url(url):
    try:
        p = urlsplit(url)
    except ValueError:
        return ""
    return url if p.scheme == "https" and p.netloc and not p.username and not p.password else ""


def parse_cards(html, base_url="https://huevo.su", allowed_hosts=("huevo.su", "huevo.departament.site"), now=None):
    """Return (rows, raw_link_count). Rows are de-duplicated by lot_id (first wins)."""
    soup = BeautifulSoup(html or "", "html.parser")
    cards = soup.select("a.mk-gcard[href*='/market/lot/']") or soup.select("a[href*='/market/lot/']")

    def field(card, selectors):
        for selector in selectors:
            el = card.select_one(selector)
            if not el:
                continue
            value = el.get_text(" ", strip=True)
            if not value:
                for attr in ("data-price", "data-title", "content", "value", "aria-label"):
                    value = str(el.get(attr) or "").strip()
                    if value:
                        break
            if value:
                return value
        return ""

    def is_allowed(host):
        host = (host or "").lower().rstrip(".")
        return any(host == d or host.endswith("." + d) for d in allowed_hosts)

    observed = (now or datetime.now(timezone.utc)).isoformat()
    rows, seen = [], set()
    for card in cards:
        href = str(card.get("href", "")).strip()
        m = LOT_PATH.search(href)
        if not m or m.group(1) in seen:
            continue
        lot_id = m.group(1)
        seen.add(lot_id)
        image = card.select_one("img")
        src = ""
        if image:
            for attr in ("src", "data-src", "data-original", "data-lazy-src"):
                src = str(image.get(attr) or "").strip()
                if src and not src.startswith("data:"):
                    break
            if src.startswith("data:"):
                src = ""
        try:
            cand = urljoin(base_url, href)
            parts = urlsplit(cand)
            lot_url = cand if parts.scheme == "https" and is_allowed(parts.hostname) else f"{base_url}/market/lot/{lot_id}"
        except ValueError:
            lot_url = f"{base_url}/market/lot/{lot_id}"
        title = (field(card, [".mk-gtitle", "[class*='title']", "[class*='name']", "h2", "h3"])
                 or (str(image.get("alt") or "").strip() if image else "")
                 or str(card.get("aria-label") or "").strip() or "Без названия")
        rows.append({
            "lot_id": lot_id, "title": title[:500],
            "serial": field(card, [".mk-gserial", "[class*='serial']", "[class*='number']"])[:200],
            "rarity": field(card, [".mk-gsub", "[class*='rarity']", "[class*='collection']"])[:100],
            "price": parse_price(field(card, [".mk-price", ".mk-gprice", "[class*='price']", "[data-price]"])),
            "status": (field(card, [".mk-status", "[class*='status']"]) or "Неизвестно")[:100],
            "image_url": _https_url(urljoin(base_url, src)) if src else "",
            "lot_url": lot_url, "observed_at": observed,
        })
    return rows, len(cards)


def sanitize_lot(item, base_url="https://huevo.su", allowed_hosts=("huevo.su", "huevo.departament.site")):
    """Validate one lot dict received from the browser collector. Returns a clean row or None.

    lot_id must be digits; text fields are truncated; image must be https; lot_url must be
    https on an allowed Huevo host (otherwise rebuilt); price must be a non-negative int.
    """
    if not isinstance(item, dict):
        return None
    lot_id = str(item.get("lot_id", "")).strip()
    if not re.fullmatch(r"\d{1,20}", lot_id):
        return None

    def text(key, limit, default=""):
        value = item.get(key)
        return (str(value).strip() if value is not None else default)[:limit]

    default_url = f"{base_url}/market/lot/{lot_id}"
    candidate = text("lot_url", 2000)
    try:
        parts = urlsplit(candidate)
        host = (parts.hostname or "").lower().rstrip(".")
        ok = (parts.scheme == "https" and not parts.username and not parts.password
              and any(host == d or host.endswith("." + d) for d in allowed_hosts))
    except ValueError:
        ok = False
    raw_price = item.get("price")
    price = None
    if isinstance(raw_price, bool):
        price = None
    elif isinstance(raw_price, (int, float)) and raw_price >= 0 and raw_price == raw_price and raw_price < 10**12:
        price = int(raw_price)
    elif isinstance(raw_price, str):
        price = parse_price(raw_price)
        price = int(price) if price is not None and price >= 0 else None
    return {
        "lot_id": lot_id, "title": text("title", 500) or "Без названия", "serial": text("serial", 200),
        "rarity": text("rarity", 100), "price": price, "status": text("status", 100, "Неизвестно") or "Неизвестно",
        "image_url": _https_url(text("image_url", 2000)), "lot_url": candidate if ok else default_url,
    }
