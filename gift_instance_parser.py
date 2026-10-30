"""Parser for an individual Huevo collectible page (/gift/<id>).

The market lot id (/market/lot/<id>) is NOT the collectible/page id (/gift/<id>).
Only public collectible metadata and public history labels/handles are retained. Dates stay
as displayed by Huevo because a year/timezone may not be present in the source markup.
"""
import hashlib
import re
from datetime import datetime, timezone
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup

GIFT_PATH = re.compile(r"/gift/(\d{1,20})(?:/|$)")
SERIAL = re.compile(r"#\s*(\d{1,20})\s+из\s+(\d{1,20})", re.I)
PRICE = re.compile(r"\d[\d\s\u00a0\u2009\u202f]*")


def _text(node, limit=500):
    return " ".join(node.get_text(" ", strip=True).split())[:limit] if node else ""


def _safe_gift_url(value, base_url):
    try:
        candidate = urljoin(base_url, str(value or "").strip())
        parsed = urlsplit(candidate)
    except ValueError:
        return "", ""
    host = (parsed.hostname or "").lower().rstrip(".")
    if parsed.scheme != "https" or parsed.username or parsed.password:
        return "", ""
    if host not in ("huevo.su", "huevo.departament.site") and not host.endswith(".huevo.su"):
        return "", ""
    match = GIFT_PATH.fullmatch(parsed.path)
    if not match:
        return "", ""
    return f"{parsed.scheme}://{parsed.netloc}/gift/{match.group(1)}", match.group(1)


def _price(value):
    match = PRICE.search(str(value or ""))
    if not match:
        return None
    try:
        number = int(re.sub(r"\s", "", match.group(0)))
    except ValueError:
        return None
    return number if 0 <= number < 10**12 else None


def _handle(anchor):
    # Store only the public handle shown on Huevo, not arbitrary profile/page URLs.
    value = _text(anchor, 80)
    href = str(anchor.get("href") or "")
    try:
        parsed = urlsplit(urljoin("https://huevo.su", href))
    except ValueError:
        return value
    host = (parsed.hostname or "").lower()
    if parsed.scheme == "https" and (host == "huevo.su" or host.endswith(".huevo.su")):
        path = parsed.path.strip("/")
        if path and "/" not in path and not path.startswith(("gift", "market", "static")):
            return path[:80]
    return value


def _event_type(label):
    value = str(label or "").strip().lower()
    if value.startswith("куплен"):
        return "purchase"
    if value.startswith("продан в маркете"):
        return "market_sale"
    if value.startswith("передан от") or value.startswith("передан"):
        return "transfer"
    return "unknown"


def _history_event(node):
    body = node.select_one(".mg-hist-text") or node
    raw = _text(body, 500)
    lower = raw.lower()
    if lower.startswith("продан в маркете"):
        label = "Продан в Маркете"
    elif lower.startswith("передан от"):
        label = "Передан"
    elif lower.startswith("куплен"):
        label = "Куплен"
    else:
        label = "Неизвестное событие"
    anchors = body.select("a[href]")
    from_user = _handle(anchors[0]) if anchors else ""
    to_user = _handle(anchors[1]) if len(anchors) > 1 else ""
    date_node = node.select_one(".mg-hist-date")
    time_raw = _text(date_node, 80)
    kind = _event_type(label)
    material = "\x1f".join((kind, from_user, to_user, time_raw, raw))
    event_id = hashlib.sha256(material.encode("utf-8")).hexdigest()[:32]
    return {
        "event_id": event_id,
        "type": kind,
        "label": label,
        "from_user": from_user,
        "to_user": to_user,
        "time_raw": time_raw,
        "text": raw,
    }


def parse_gift_instance(html, gift_id=None, base_url="https://huevo.su", observed_at=None):
    """Parse one /gift/<id> page; never invent an event, owner, amount, or absolute date."""
    soup = BeautifulSoup(html or "", "html.parser")
    gid = str(gift_id or "").strip()
    if not re.fullmatch(r"\d{1,20}", gid):
        for node in soup.select("a[href*='/gift/']"):
            _, found = _safe_gift_url(node.get("href"), base_url)
            if found:
                gid = found
                break
    if not re.fullmatch(r"\d{1,20}", gid):
        return None

    heading = soup.select_one(".mg-gname") or soup.select_one("h1")
    heading_text = _text(heading, 300)
    serial_match = SERIAL.search(heading_text)
    serial = int(serial_match.group(1)) if serial_match else None
    supply = int(serial_match.group(2)) if serial_match else None
    title = SERIAL.sub("", heading_text).strip(" ·#—-") if heading_text else ""

    rarity_node = soup.select_one(".mg-grar")
    rarity_text = _text(rarity_node, 120)
    rarity = SERIAL.sub("", rarity_text).strip(" ·#—-") if rarity_text else ""

    author = ""
    author_node = soup.select_one(".ga-line")
    if author_node:
        author_link = author_node.select_one("a.ga-name, a")
        author = _text(author_link, 120) or re.sub(r"^Автор дизайна:\s*", "", _text(author_node, 180), flags=re.I)[:120]

    collection = ""
    for node in soup.select("[data-tip], [aria-label]"):
        hint = str(node.get("data-tip") or node.get("aria-label") or "")
        match = re.search(r"(?:сбор полной коллекции|полный сбор коллекции)\s+(.+?)(?:[.!]|$)", hint, re.I)
        if match:
            collection = match.group(1).strip()[:120]
            break

    drop_price = None
    drop_price_text = ""
    edition_sold_out = None
    current_owner = ""
    for row in soup.select(".mg-r"):
        spans = row.find_all("span", recursive=False)
        if len(spans) < 2:
            continue
        label = _text(spans[0], 60).rstrip(":").lower()
        value_node = spans[1]
        value = _text(value_node, 220)
        if label == "цена":
            drop_price_text = value
            drop_price = _price(value)
            edition_sold_out = "тираж разошелся" in value.lower()
        elif label in ("владелец", "владелец:"):
            link = value_node.select_one("a[href]")
            current_owner = _handle(link) if link else value[:80]

    history_card = None
    for card in soup.select(".vk-card"):
        title_node = card.select_one(".vk-card-title")
        if _text(title_node, 100).lower().startswith("история"):
            history_card = card
            break
    history_nodes = (history_card.select(".mg-hist") if history_card else soup.select(".mg-hist"))
    history_found = history_card is not None or bool(history_nodes)
    events = []
    repeated = {}
    for order, node in enumerate(history_nodes[:300]):
        event = _history_event(node)
        signature = (event["type"], event["from_user"], event["to_user"])
        repeated[signature] = repeated.get(signature, 0) + 1
        # Relative labels such as "вчера" change every day. Keep event ids stable by
        # hashing the event kind, participants, and occurrence number instead.
        material = "\\x1f".join((*signature, str(repeated[signature])))
        event["event_id"] = hashlib.sha256(material.encode("utf-8")).hexdigest()[:32]
        event["event_order"] = order
        events.append(event)

    if not heading_text and not history_found and drop_price_text == "" and not rarity:
        return None
    return {
        "gift_id": gid,
        "gift_url": f"{base_url.rstrip('/')}/gift/{gid}",
        "title": title,
        "serial": serial,
        "supply": supply,
        "rarity": rarity,
        "author": author,
        "collection": collection,
        "drop_price": drop_price,
        "drop_price_text": drop_price_text,
        "edition_sold_out": edition_sold_out,
        "current_owner": current_owner,
        "history_found": history_found,
        "history": events,
        "checked_at": observed_at or datetime.now(timezone.utc).isoformat(),
        "source": "huevo_gift_instance_page",
    }
