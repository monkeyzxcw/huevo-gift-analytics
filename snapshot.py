"""Pure helpers for the public static snapshot (cloudflare-site/data.json).

No Selenium, no network. The collector builds the payload with these functions, validates it and
only then replaces the published file. Everything here describes *asking* prices of active
offers; nothing in the snapshot is a completed-sale price.
"""
import hashlib
import json
import os
import statistics
from pathlib import Path

SCHEMA_VERSION = 2
LOT_REQUIRED = ("lot_id", "title", "price")
TOP_LEVEL_LISTS = ("lots", "gone_lots", "snapshots", "price_bins", "deals", "drops", "runner_up",
                   "categories", "top_expensive")
MAX_DETAIL = 50


class SnapshotError(ValueError):
    """The payload is not safe to publish."""


def _num(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value == value and value >= 0


def lots_hash(lots):
    """Stable fingerprint of (id, price) pairs: detects a snapshot that carries no change."""
    pairs = sorted((str(l.get("lot_id")), l.get("price")) for l in lots)
    return hashlib.sha256(json.dumps(pairs, ensure_ascii=False).encode("utf-8")).hexdigest()[:16]


def validate(data):
    """Return a list of problems; an empty list means the payload may be published."""
    problems = []
    if not isinstance(data, dict):
        return ["корень data.json не объект"]
    version = data.get("schema_version")
    if not isinstance(version, int) or version < 1 or version > SCHEMA_VERSION:
        problems.append(f"неизвестная schema_version: {version!r}")
    if not isinstance(data.get("generated_at"), str):
        problems.append("нет generated_at")
    if not isinstance(data.get("collector"), dict):
        problems.append("нет блока collector")
    for key in TOP_LEVEL_LISTS:
        if key in data and not isinstance(data[key], list):
            problems.append(f"поле {key} не список")
    lots = data.get("lots")
    if not isinstance(lots, list):
        return problems + ["нет списка lots"]
    seen = set()
    for i, lot in enumerate(lots):
        if not isinstance(lot, dict):
            problems.append(f"lots[{i}] не объект"); continue
        for field in LOT_REQUIRED:
            if field not in lot:
                problems.append(f"lots[{i}] без поля {field}")
        lid = str(lot.get("lot_id"))
        if lid in seen:
            problems.append(f"дубликат lot_id {lid}")
        seen.add(lid)
        if lot.get("price") is not None and not _num(lot.get("price")):
            problems.append(f"lots[{i}] некорректная цена")
        if len(problems) > 20:
            problems.append("…и другие ошибки"); break
    stats = data.get("stats")
    if isinstance(stats, dict) and stats.get("n_total") is not None and stats["n_total"] != len(lots):
        problems.append("stats.n_total не совпадает с числом лотов")
    return problems


def migrate(data):
    """Bring an older snapshot (v1) to the current shape without losing data. Pure: returns a copy."""
    if not isinstance(data, dict):
        return {}
    out = dict(data)
    for key in TOP_LEVEL_LISTS:
        if not isinstance(out.get(key), list):
            out[key] = []
    out.setdefault("changes", None)
    out.setdefault("sales", None)
    if not isinstance(out.get("collector"), dict):
        out["collector"] = {}
    out["schema_version"] = SCHEMA_VERSION
    return out


def compare(old_lots, new_lots):
    """Difference between two sets of active lots by lot_id.

    Returns counts plus bounded detail lists. A lot missing from the newer set is reported as
    'не найден' — it may be sold, delisted or hidden; the source does not say which.
    """
    old = {str(l["lot_id"]): l for l in old_lots or [] if l.get("lot_id") is not None}
    new = {str(l["lot_id"]): l for l in new_lots or [] if l.get("lot_id") is not None}
    brief = lambda l: {k: l.get(k) for k in ("lot_id", "title", "price", "rarity", "lot_url")}
    added = [brief(new[i]) for i in new if i not in old]
    gone = [brief(old[i]) for i in old if i not in new]
    changed = []
    for i in new.keys() & old.keys():
        a, b = old[i].get("price"), new[i].get("price")
        if _num(a) and _num(b) and a != b:
            changed.append({"lot_id": i, "title": new[i].get("title"), "from": a, "to": b,
                            "pct": round((b - a) / a * 100, 1) if a else None,
                            "lot_url": new[i].get("lot_url")})
    rank = lambda l: -(l.get("price") or 0)
    added.sort(key=rank); gone.sort(key=rank)
    changed.sort(key=lambda c: abs(c["pct"] or 0), reverse=True)
    return {
        "counts": {"new": len(added), "gone": len(gone), "price_up": sum(1 for c in changed if c["to"] > c["from"]),
                   "price_down": sum(1 for c in changed if c["to"] < c["from"]),
                   "unchanged": len(new.keys() & old.keys()) - len(changed)},
        "new": added[:MAX_DETAIL], "gone": gone[:MAX_DETAIL], "price_changes": changed[:MAX_DETAIL],
    }


def category_distribution(lots, key="rarity"):
    """Count and price stats per category; categories without a price report null stats."""
    groups = {}
    for lot in lots:
        groups.setdefault(lot.get(key) or "Не указано", []).append(lot.get("price"))
    out = []
    for name, prices in groups.items():
        priced = [p for p in prices if _num(p) and p > 0]
        out.append({"name": name, "count": len(prices), "priced": len(priced),
                    "min": min(priced) if priced else None,
                    "median": statistics.median(priced) if priced else None,
                    "max": max(priced) if priced else None})
    out.sort(key=lambda r: (-r["count"], r["name"]))
    return out


def top_expensive(lots, n=10):
    priced = [l for l in lots if _num(l.get("price")) and l["price"] > 0]
    priced.sort(key=lambda l: -l["price"])
    return [{k: l.get(k) for k in ("lot_id", "title", "serial", "rarity", "price", "lot_url", "image_url")}
            for l in priced[:n]]


def snapshot_entry(observed_at, lots, summary, changes=None):
    """One history point. `changes` (from compare) adds new/gone/price-change counts."""
    entry = {"observed_at": observed_at, "active_lots": len(lots), "priced": summary["priced"],
             "min_price": summary["min"], "max_price": summary["max"], "avg_price": summary["avg"],
             "median_price": summary["median"], "lots_hash": lots_hash(lots)}
    if changes:
        c = changes["counts"]
        entry.update(new_lots=c["new"], gone_lots=c["gone"], price_up=c["price_up"], price_down=c["price_down"])
    return entry


def is_duplicate_snapshot(snapshots, lots, min_gap_seconds=600, now_iso=None):
    """True if the newest history point has the same fingerprint and is younger than the gap."""
    from datetime import datetime
    if not snapshots:
        return False
    last = snapshots[-1]
    if last.get("lots_hash") != lots_hash(lots) or not now_iso:
        return False
    try:
        a = datetime.fromisoformat(str(last["observed_at"]).replace("Z", "+00:00"))
        b = datetime.fromisoformat(str(now_iso).replace("Z", "+00:00"))
        return (b - a).total_seconds() < min_gap_seconds
    except (KeyError, ValueError):
        return False


def safe_write(path, data):
    """Validate, write to a temp file in the same directory, fsync, then atomically replace.

    Raises SnapshotError (and leaves the published file untouched) if validation fails or the
    serialised text does not parse back to the same number of lots.
    """
    problems = validate(data)
    if problems:
        raise SnapshotError("; ".join(problems[:5]))
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n"
    if len(json.loads(text).get("lots", [])) != len(data.get("lots", [])):
        raise SnapshotError("сериализация изменила число лотов")
    temp = path.with_name(path.name + ".tmp")
    with open(temp, "w", encoding="utf-8") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, path)
