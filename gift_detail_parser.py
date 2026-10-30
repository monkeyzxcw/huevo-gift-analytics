"""Best-effort parser for one Huevo gift lot detail page.

Only whitelisted collectible attributes are retained. Seller/owner/account data is deliberately
ignored. The live detail-page markup is not part of the stable public contract, so extraction is
defensive and an empty attributes object is an honest outcome rather than invented metadata.
"""
import re
from datetime import datetime, timezone
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup

LOT_PATH = re.compile(r"/market/lot/(\d+)")
LABELS = {
    "model": ("модель", "model"),
    "backdrop": ("фон", "backdrop"),
    "symbol": ("символ", "symbol"),
    "pattern": ("узор", "pattern"),
    "rarity": ("редкость", "rarity"),
    "serial": ("номер", "серийный номер", "serial", "number"),
    "supply": ("тираж", "выпуск", "supply", "edition"),
    "collection": ("коллекция", "collection"),
}
DATA_KEYS = {
    "model": "model", "backdrop": "backdrop", "background": "backdrop",
    "symbol": "symbol", "pattern": "pattern", "rarity": "rarity",
    "serial": "serial", "number": "serial", "supply": "supply",
    "edition": "supply", "collection": "collection",
}


def _clean(value, limit=180):
    return " ".join(str(value or "").split())[:limit]


def _attribute_key(value):
    key = _clean(value, 60).strip().lower().replace("_", " ").replace("-", " ")
    for canonical, aliases in LABELS.items():
        if key in aliases:
            return canonical
    return None


def _safe_image(value, base_url):
    try:
        candidate = urljoin(base_url, str(value or "").strip())
        parsed = urlsplit(candidate)
    except ValueError:
        return ""
    host = (parsed.hostname or "").lower().rstrip(".")
    if parsed.scheme != "https" or parsed.username or parsed.password:
        return ""
    if host not in ("huevo.su", "huevo.departament.site") and not host.endswith(".huevo.su"):
        return ""
    return candidate[:2000]


def parse_gift_detail(html, lot_id=None, base_url="https://huevo.su", observed_at=None):
    """Parse a Huevo /market/lot/<id> page into a privacy-safe collectible detail record."""
    soup = BeautifulSoup(html or "", "html.parser")
    lid = str(lot_id or "").strip()
    if not re.fullmatch(r"\d{1,20}", lid):
        link = soup.select_one("a[href*='/market/lot/']")
        match = LOT_PATH.search(str(link.get("href", ""))) if link else None
        lid = match.group(1) if match else ""
    if not re.fullmatch(r"\d{1,20}", lid):
        return None

    title = ""
    og_title = soup.select_one('meta[property="og:title"], meta[name="twitter:title"]')
    if og_title:
        title = _clean(og_title.get("content"), 300)
    if not title:
        for selector in ("h1", ".mk-gtitle", "[class*='lot-title']", "[class*='gift-title']"):
            node = soup.select_one(selector)
            if node:
                title = _clean(node.get_text(" ", strip=True), 300)
                if title:
                    break

    attributes = {}

    def add(label, value):
        key = _attribute_key(label)
        value = _clean(value)
        if key and value and key not in attributes:
            attributes[key] = value

    # Semantic definition lists.
    for dl in soup.select("dl"):
        terms = dl.find_all("dt")
        for term in terms:
            value = term.find_next_sibling("dd")
            if value:
                add(term.get_text(" ", strip=True), value.get_text(" ", strip=True))

    # Two-column tables are a common fallback for details pages.
    for row in soup.select("tr"):
        cells = row.find_all(["th", "td"], recursive=False)
        if len(cells) >= 2:
            add(cells[0].get_text(" ", strip=True), cells[1].get_text(" ", strip=True))

    # Explicit data attributes make extraction resilient to CSS class changes.
    for node in soup.select("[data-model], [data-backdrop], [data-background], [data-symbol], [data-pattern], [data-rarity], [data-serial], [data-number], [data-supply], [data-edition], [data-collection]"):
        for attr, raw in node.attrs.items():
            if attr.startswith("data-") and attr[5:] in DATA_KEYS:
                add(DATA_KEYS[attr[5:]], raw)

    # Labels rendered as text ("Модель: ...") are a final safe fallback.
    for node in soup.select("li, p, div, span"):
        text = _clean(node.get_text(" ", strip=True), 260)
        match = re.match(r"^([^:：]{2,40})\s*[:：]\s*(.{1,180})$", text)
        if match:
            add(match.group(1), match.group(2))

    gift_url = ""
    gift_id = ""
    for gift_link in soup.select("a[href*='/gift/']"):
        candidate = urljoin(base_url, str(gift_link.get("href") or "").strip())
        try:
            parts = urlsplit(candidate)
        except ValueError:
            continue
        host = (parts.hostname or "").lower().rstrip(".")
        match = re.fullmatch(r"/gift/(\\d{1,20})/?", parts.path)
        if (parts.scheme == "https" and not parts.username and not parts.password
                and (host in ("huevo.su", "huevo.departament.site") or host.endswith(".huevo.su"))
                and match):
            gift_id = match.group(1)
            gift_url = f"{base_url.rstrip('/')}/gift/{gift_id}"
            break

    image = ""
    og_image = soup.select_one('meta[property="og:image"]')
    if og_image:
        image = _safe_image(og_image.get("content"), base_url)
    if not image:
        image_node = soup.select_one(".mk-lot img, .mk-gift img, main img, article img")
        if image_node:
            image = _safe_image(image_node.get("src") or image_node.get("data-src"), base_url)

    if not title and not attributes:
        return None
    return {
        "lot_id": lid,
        "title": title,
        "attributes": attributes,
        "image_url": image,
        "gift_id": gift_id,
        "gift_url": gift_url,
        "checked_at": observed_at or datetime.now(timezone.utc).isoformat(),
        "source": "huevo_lot_page",
    }
