"""Parser for the Huevo sales history page (/market/history). Pure (bs4 + stdlib).

What is confirmed (AI_HANDOFF/HUEVO_MARKET_RESEARCH.md, from owner-supplied HTML): a `table.mk-table`
with columns Лот, Цена, Продавец, Покупатель, Дата; lot links `/market/lot/<id>`; pager text
"Страница N из M". What is NOT confirmed: whether the date cell carries a calendar date or a
timestamp attribute (only "HH:MM" was seen). So:

* `time_raw` keeps exactly what the page shows;
* `sold_at` is filled ONLY from an explicit timezone-aware ISO value or a unix timestamp in an
  attribute of the date cell; it is never guessed and never taken from the crawl time;
* an unparseable price is None (unknown), never 0;
* seller/buyer names are used only to build a de-duplication key and are NOT returned or stored.
"""
import hashlib
import re
from datetime import datetime, timezone

LOT_PATH = re.compile(r"/market/lot/(\d+)")
_PAGER = re.compile(r"из\s+(\d{1,6})")
_COLUMN_WORDS = (("lot", ("лот",)), ("price", ("цена", "сумма")), ("seller", ("продав",)),
                 ("buyer", ("покуп",)), ("time", ("дата", "врем")))
DEFAULT_ORDER = ["lot", "price", "seller", "buyer", "time"]
MAX_PRICE = 10 ** 12


def parse_price(text):
    """Integer price from cell text ("444 444", "1 250 ◉"); None if absent or not a plain number."""
    if text is None:
        return None
    m = re.search(r"\d[\d\s   ]*", str(text))
    if not m:
        return None
    value = int(re.sub(r"\s", "", m.group(0)).replace(" ", "").replace(" ", "").replace(" ", ""))
    return value if 0 <= value < MAX_PRICE else None


def _column_map(table):
    headers = [th.get_text(" ", strip=True).lower() for th in table.select("thead th, tr:first-child th")]
    mapping = {}
    for index, text in enumerate(headers):
        for name, words in _COLUMN_WORDS:
            if name not in mapping.values() and any(text.startswith(w) or w in text for w in words):
                mapping[index] = name
                break
    if "lot" in mapping.values() and "price" in mapping.values():
        return mapping
    return dict(enumerate(DEFAULT_ORDER))      # headerless/renamed table: fall back to the documented order


def _explicit_timestamp(cell):
    """Timezone-aware ISO string from datetime/data-* attributes, or None. Never guesses."""
    nodes = [cell] + list(cell.select("[datetime], [data-ts], [data-time], [data-timestamp], time"))
    for node in nodes:
        for attr in ("datetime", "data-ts", "data-time", "data-timestamp", "content"):
            raw = str(node.get(attr) or "").strip()
            if not raw:
                continue
            if raw.isdigit() and len(raw) in (10, 13):
                seconds = int(raw) / (1000 if len(raw) == 13 else 1)
                try:
                    return datetime.fromtimestamp(seconds, timezone.utc).isoformat()
                except (OverflowError, OSError, ValueError):
                    continue
            try:
                when = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            except ValueError:
                continue
            if when.tzinfo is not None:
                return when.astimezone(timezone.utc).isoformat()
    return None


def _sale_key(lot_id, price, time_raw, seller, buyer):
    material = "\x1f".join([lot_id, "" if price is None else str(price), time_raw, seller, buyer])
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:32]


def parse_history(html):
    """Return {"rows", "total_pages", "table_found", "skipped"}. Rows never contain person names."""
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html or "", "html.parser")
    pager = soup.find(string=re.compile(r"Страница\s+\d+\s+из\s+\d+"))
    total_pages = int(_PAGER.search(pager).group(1)) if pager else None
    table = soup.select_one("table.mk-table") or soup.select_one("table")
    result = {"rows": [], "total_pages": total_pages, "table_found": table is not None, "skipped": 0}
    if table is None:
        return result
    columns = _column_map(table)
    seen = set()
    for tr in table.select("tbody tr") or [r for r in table.select("tr") if r.find("td")]:
        cells = tr.find_all("td")
        if not cells:
            continue
        by_name = {columns[i]: cell for i, cell in enumerate(cells) if i in columns}
        link = (by_name.get("lot") or tr).select_one("a[href*='/market/lot/']")
        m = LOT_PATH.search(str(link.get("href", ""))) if link else None
        if not m:
            result["skipped"] += 1
            continue
        lot_id = m.group(1)
        price = parse_price(by_name["price"].get_text(" ", strip=True)) if "price" in by_name else None
        time_cell = by_name.get("time")
        time_raw = time_cell.get_text(" ", strip=True)[:60] if time_cell else ""
        name = lambda key: by_name[key].get_text(" ", strip=True) if key in by_name else ""
        key = _sale_key(lot_id, price, time_raw, name("seller"), name("buyer"))
        if key in seen:
            continue
        seen.add(key)
        title = link.get_text(" ", strip=True)[:300]
        result["rows"].append({"sale_key": key, "lot_id": lot_id, "title": title, "price": price,
                               "time_raw": time_raw, "sold_at": _explicit_timestamp(time_cell) if time_cell else None})
    return result
