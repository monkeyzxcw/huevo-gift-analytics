"""Cookie export parsing and host allow-list. Pure; cookie values are never logged here."""
import json

ALLOWED_HUEVO_HOSTS = ("huevo.su", "huevo.departament.site")


def is_huevo_host(host, allowed=ALLOWED_HUEVO_HOSTS):
    host = (host or "").lower().rstrip(".")
    return any(host == d or host.endswith("." + d) for d in allowed)


def load_cookie_export(raw):
    """Normalize browser-extension JSON and Netscape cookies.txt exports. Raises ValueError on garbage."""
    if not raw or not raw.strip():
        return []
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            parsed = parsed.get("cookies", parsed.get("data", []))
        if not isinstance(parsed, list):
            raise ValueError("JSON должен быть массивом cookies или объектом с полем cookies")
        out = []
        for item in parsed:
            if not isinstance(item, dict) or not item.get("name") or "value" not in item:
                continue
            cookie = dict(item)
            if "expiry" not in cookie and "expirationDate" in cookie:
                cookie["expiry"] = cookie.pop("expirationDate")
            out.append(cookie)
        return out
    except json.JSONDecodeError:
        pass
    out = []
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
        domain, _sub, path, secure, expiry, name, value = parts
        cookie = {"domain": domain, "path": path or "/", "secure": secure.upper() == "TRUE",
                  "httpOnly": http_only, "name": name, "value": value}
        try:
            if int(expiry) > 0:
                cookie["expiry"] = int(expiry)
        except (TypeError, ValueError):
            pass
        out.append(cookie)
    if not out:
        raise ValueError("Формат cookies не распознан. Нужен JSON-массив или Netscape cookies.txt")
    return out


_ALLOWED_KEYS = {"name", "value", "path", "domain", "secure", "httpOnly", "expiry", "sameSite"}


def selenium_cookie(raw, default_domain):
    """Whitelisted, type-normalized cookie dict for Selenium, or None if it is not for a Huevo host."""
    domain_raw = str(raw.get("domain", default_domain)).strip().lower()
    if not is_huevo_host(domain_raw.lstrip(".")):
        return None
    cookie = {k: v for k, v in raw.items() if k in _ALLOWED_KEYS}
    cookie["domain"] = domain_raw
    if "expiry" in cookie:
        try:
            cookie["expiry"] = int(float(cookie["expiry"]))
        except (TypeError, ValueError, OverflowError):
            cookie.pop("expiry", None)
    if cookie.get("sameSite") not in ("Strict", "Lax", "None"):
        cookie.pop("sameSite", None)
    for flag in ("httpOnly", "secure"):
        if flag in cookie:
            cookie[flag] = bool(cookie[flag])
    return cookie
