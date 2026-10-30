"""Pure helpers for merging Huevo /gift instance history into the catalog."""
from copy import deepcopy


def merge_instance_record(old, new):
    """Merge fresh metadata without replacing a previously parsed history with a missing one."""
    old = old if isinstance(old, dict) else {}
    new = new if isinstance(new, dict) else {}
    merged = {**deepcopy(old), **deepcopy(new)}
    old_events = deepcopy(old.get("history") or [])
    old_ids = {str(event.get("event_id")) for event in old_events if event.get("event_id")}
    if not new.get("history_found"):
        merged["history"] = old_events
        merged["history_found"] = bool(old.get("history_found"))
        merged["history_delta_known"] = False
        merged["new_events"] = []
    else:
        incoming = new.get("history") or []
        additions = [event for event in incoming
                     if event.get("event_id") and str(event["event_id"]) not in old_ids]
        merged["history"] = old_events + additions
        merged["new_events"] = additions
        merged["history_delta_known"] = bool(old.get("history_found"))
    return merged


def classify_disappearance(old_instance, fresh_instance):
    """Classify why a market listing vanished, only when a previous history baseline exists."""
    old_instance = old_instance if isinstance(old_instance, dict) else {}
    fresh_instance = fresh_instance if isinstance(fresh_instance, dict) else {}
    if not fresh_instance.get("history_found"):
        return "pending_history"
    if not old_instance.get("history_found"):
        return "history_baseline"
    new_events = fresh_instance.get("new_events") or []
    if not new_events:
        return "delisted"
    for event in reversed(new_events):
        kind = event.get("type")
        if kind == "market_sale":
            return "sold"
        if kind == "transfer":
            return "transferred"
    # Huevo can record a purchase/other event without proving a sale or transfer.
    return "delisted"


def history_event_record(lot, event, observed_at):
    """Build a compact public catalogue event from one newly observed instance-history row."""
    kind = str(event.get("type") or "unknown")
    labels = {
        "purchase": "Подарок куплен",
        "market_sale": "Продан в Маркете",
        "transfer": "Подарок передан",
        "unknown": "Изменение истории подарка",
    }
    gift_instance = lot.get("gift_instance") if isinstance(lot.get("gift_instance"), dict) else {}
    gift_id = str(gift_instance.get("gift_id") or "")
    event_id = str(event.get("event_id") or "")
    if not gift_id or not event_id:
        return None
    serial = gift_instance.get("serial")
    serial_label = ("№ " + str(serial) + ("/" + str(gift_instance.get("supply")) if gift_instance.get("supply") else "")) if serial else ""
    return {
        "event_id": "history:" + gift_id + ":" + event_id,
        "type": kind,
        "label": labels.get(kind, labels["unknown"]),
        "title": str(gift_instance.get("title") or lot.get("title") or "Подарок")[:300],
        "lot_id": str(lot.get("lot_id") or ""),
        "gift_id": gift_id,
        "serial": serial_label,
        "price": lot.get("price"),
        "from_user": str(event.get("from_user") or "")[:80],
        "to_user": str(event.get("to_user") or "")[:80],
        "time_raw": str(event.get("time_raw") or "")[:80],
        "observed_at": observed_at,
        "gift_url": gift_instance.get("gift_url") or "",
        "lot_url": lot.get("lot_url") or "",
        "image_url": lot.get("image_url") or "",
    }


def delisted_event_record(lot, observed_at):
    """Build a single non-sale event only for a checked history with an unchanged event list."""
    instance = lot.get("gift_instance") if isinstance(lot.get("gift_instance"), dict) else {}
    gift_id = str(instance.get("gift_id") or "")
    lot_id = str(lot.get("lot_id") or "")
    disappeared_at = str(lot.get("disappeared_at") or observed_at)
    if not gift_id or not lot_id:
        return None
    serial = instance.get("serial")
    serial_label = ("№ " + str(serial) + ("/" + str(instance.get("supply")) if instance.get("supply") else "")) if serial else ""
    return {
        "event_id": "delisted:" + lot_id + ":" + disappeared_at,
        "type": "delisted",
        "label": "Вероятно снят продавцом",
        "title": str(instance.get("title") or lot.get("title") or "Подарок")[:300],
        "lot_id": lot_id,
        "gift_id": gift_id,
        "serial": serial_label,
        "price": lot.get("price"),
        "from_user": "",
        "to_user": "",
        "time_raw": "",
        "observed_at": observed_at,
        "gift_url": instance.get("gift_url") or "",
        "lot_url": lot.get("lot_url") or "",
        "image_url": lot.get("image_url") or "",
    }
