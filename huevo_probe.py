"""Pure helpers for classifying what a Huevo page request actually returned.

No Selenium/FastAPI imports here so the logic is unit-testable anywhere.
Nothing in this module stores or returns cookies or page bodies; callers get
only coarse facts (host, title, body length, card count, verdict).
"""
import json
import re
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit

LOGIN_WORDS = r"(войти|вход|авторизация|вход в аккаунт|sign in|log in|login)"


def looks_like_login_page(url, title="", heading="", body_text="", password_visible=False, has_market_cards=False):
    """Avoid mistaking a navigation link saying 'Log in' for an unauthenticated session."""
    path = (urlsplit(url or "").path or "").lower().rstrip("/")
    if re.search(r"/(login|log-in|signin|sign-in|auth|authorize|authentication)$", path):
        return True
    if password_visible:
        return True
    normalized = " ".join((body_text or "").lower().split())
    explicit_prompts = (
        "войдите в аккаунт", "необходимо войти", "требуется авторизация",
        "для продолжения войдите", "авторизуйтесь", "sign in to continue",
        "please log in", "login required", "authentication required",
    )
    if any(prompt in normalized for prompt in explicit_prompts):
        return True
    simple_heading = any(
        re.fullmatch(LOGIN_WORDS, " ".join((value or "").lower().split()))
        for value in (title, heading)
    )
    return bool(simple_heading and not has_market_cards)


def access_block_status(text):
    """Return 418/429/403 for recognizable access/rate-limit pages, else None."""
    normalized = (text or "").lower()
    markers = ("http error 418", "418 i'm a teapot", "http error 429",
               "too many requests", "access denied", "verify you are human",
               "captcha", "проверка браузера", "ограничение доступа")
    if not any(marker in normalized for marker in markers):
        return None
    match = re.search(r"\b(418|429|403)\b", normalized)
    if match:
        return int(match.group(1))
    if "too many requests" in normalized:
        return 429
    return 403


# Chrome/Selenium network error markers -> coarse cause.
_NETWORK_MARKERS = (
    ("dns", ("err_name_not_resolved", "err_name_resolution_failed", "name or service not known")),
    ("tls", ("err_ssl", "err_cert", "certificate")),
    ("timeout", ("err_timed_out", "timed out", "timeout", "err_connection_timed_out")),
    ("connect", ("err_connection_refused", "err_connection_reset", "err_connection_closed",
                 "err_address_unreachable", "err_internet_disconnected", "err_connection_failed")),
)


def classify_network_error(exc_or_text):
    """Map a Selenium/requests exception (or text) to dns/tls/timeout/connect/other."""
    text = str(exc_or_text or "").lower()
    for kind, markers in _NETWORK_MARKERS:
        if any(marker in text for marker in markers):
            return kind
    return "other"


def parse_retry_after(value, now=None, cap=24 * 3600):
    """Retry-After as seconds (0..cap) from either delta-seconds or an HTTP date; None if absent/invalid."""
    if value is None or str(value).strip() == "":
        return None
    text = str(value).strip()
    if text.isdigit():
        return min(int(text), cap)
    try:
        when = parsedate_to_datetime(text)
        if when.tzinfo is None:
            when = when.replace(tzinfo=timezone.utc)
        delta = (when - (now or datetime.now(timezone.utc))).total_seconds()
        return int(min(max(delta, 0), cap))
    except (TypeError, ValueError):
        return None


def parse_perf_log(entries):
    """Extract real HTTP facts from Chrome performance-log entries (Selenium `get_log('performance')`).

    Returns {"documents": [{"url","status","retry_after"}], "failures": [error_text]}.
    Only main-document responses and failed requests are kept; no cookies or bodies.
    Headers other than Retry-After are discarded.
    """
    documents, failures = [], []
    for entry in entries or []:
        try:
            msg = json.loads(entry["message"])["message"] if isinstance(entry.get("message"), str) else entry["message"]["message"]
            method, params = msg.get("method"), msg.get("params", {})
        except (KeyError, TypeError, ValueError, AttributeError):
            continue
        if method == "Network.responseReceived" and params.get("type") == "Document":
            resp = params.get("response", {})
            headers = {str(k).lower(): v for k, v in (resp.get("headers") or {}).items()}
            documents.append({"url": resp.get("url", ""), "status": resp.get("status"),
                              "retry_after": parse_retry_after(headers.get("retry-after"))})
        elif method == "Network.loadingFailed" and params.get("type") in (None, "Document"):
            failures.append(str(params.get("errorText", "")))
    return {"documents": documents, "failures": failures}


def main_response(parsed, target_path):
    """The last Document response whose path matches the page we asked for (after redirects), else the last one."""
    docs = parsed.get("documents") or []
    want = (urlsplit(target_path).path or "/").rstrip("/") or "/"
    for d in reversed(docs):
        if ((urlsplit(d["url"]).path or "/").rstrip("/") or "/") == want:
            return d
    return docs[-1] if docs else None


def classify_page(final_url, title, body_text, card_count, *, expected_hosts,
                  password_visible=False, heading="", http_status=None, retry_after=None):
    """Return a safe verdict about a loaded page.

    verdict is one of: blocked, login, wrong_host, empty, no_cards, ok.
    `http_status` (from the browser's network log) is authoritative when given
    (status_source="network"); otherwise a block is inferred from page text
    (status_source="inferred"). Extra verdicts with a real status: server_error, not_found.
    """
    parts = urlsplit(final_url or "")
    host = (parts.hostname or "").lower()
    body_text = body_text or ""
    info = {
        "final_host": host,
        "final_path": parts.path or "/",
        "title": (title or "")[:120],
        "body_length": len(body_text),
        "cards": int(card_count),
        "status_class_inferred": None,
        "http_status": http_status, "status_source": "network" if http_status else "inferred",
        "retry_after": retry_after,
    }
    blocked = access_block_status((title or "") + " " + body_text[:1500])
    if http_status in (403, 418, 429):
        info.update(verdict="blocked", status_class_inferred=http_status)
    elif isinstance(http_status, int) and http_status >= 500:
        info["verdict"] = "server_error"
    elif http_status == 404:
        info["verdict"] = "not_found"
    elif blocked:
        info.update(verdict="blocked", status_class_inferred=blocked)
    elif host and host not in expected_hosts:
        info["verdict"] = "wrong_host"
    elif looks_like_login_page(final_url, title, heading, body_text,
                               password_visible=password_visible, has_market_cards=card_count > 0):
        info["verdict"] = "login"
    elif not body_text.strip():
        info["verdict"] = "empty"
    elif card_count == 0:
        info["verdict"] = "no_cards"
    else:
        info["verdict"] = "ok"
    return info


VERDICT_HINTS = {
    "server_error": "Сервер Huevo вернул ошибку 5xx: временная проблема источника, повтор позже.",
    "not_found": "Huevo вернул 404: адрес каталога изменился или страница недоступна.",
    "blocked": "Источник ограничил доступ. Это ограничение стороны Huevo, а не формат cookies: сбор не повторяется, защита не обходится.",
    "login": "Открылась страница входа: сессия/cookies не подходят для этого домена. Используйте браузерный сборщик в авторизованной вкладке.",
    "wrong_host": "Редирект на другой хост. Проверьте HUEVO_BASE_URL и домен cookies.",
    "empty": "Пустой ответ: страница не отрисовалась (JS не выполнился или соединение оборвано).",
    "no_cards": "Страница загрузилась, но карточек лотов нет: изменилась разметка, JS-рендеринг не завершился или каталог пуст.",
    "ok": "Каталог доступен, карточки найдены.",
}


def next_page_is_new(previous_ids, current_ids):
    """Pagination guard: True only when the page brings lot ids not seen before.

    Protects against a site that ignores ?page=N and keeps returning page 1.
    """
    current = set(current_ids)
    return bool(current) and not current.issubset(set(previous_ids))
