"""Poll only Huevo's first market page using the operator's saved local Chrome session.

This is intended to run on the PC/server that owns the logged-in Chrome profile.
It does not export or print cookies, and stops immediately on login/challenge/403/418/429.
"""
import json
import logging
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cookies import ALLOWED_HUEVO_HOSTS
from huevo_probe import classify_page, parse_retry_after
from lot_parser import parse_cards
from scripts.collect_snapshot import make_browser, load_state, save_state, iso, now_utc

LOG = logging.getLogger("huevo-live-poller")
DEFAULT_WORKER = "https://huevo-gift-analytics.monkeyzxcw.workers.dev"
DEFAULT_BASE_URL = "https://huevo.su"


def poll_interval():
    try:
        return max(3.0, min(float(os.getenv("HUEVO_LIVE_POLL_SECONDS", "3")), 60.0))
    except ValueError:
        return 3.0


def active_cooldown():
    value = (load_state() or {}).get("blocked_until")
    if not value:
        return None
    try:
        until = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    if until.tzinfo is None:
        until = until.replace(tzinfo=timezone.utc)
    return until if until > now_utc() else None


def get_page(browser, base_url):
    script = """
    const done = arguments[arguments.length - 1];
    fetch('/market/gifts?page=1', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'follow',
      headers: { 'Accept': 'text/html' }
    }).then(async (response) => {
      done({
        status: response.status,
        url: response.url,
        retry_after: response.headers.get('Retry-After') || '',
        html: await response.text()
      });
    }).catch(() => done({ network_error: true }));
    """
    result = browser.execute_async_script(script)
    if not isinstance(result, dict) or result.get("network_error"):
        raise URLError("fetch failed")
    final_url = str(result.get("url") or base_url)
    parsed_url = urlsplit(final_url)
    if parsed_url.scheme != "https" or parsed_url.hostname not in set(ALLOWED_HUEVO_HOSTS) | {"www." + h for h in ALLOWED_HUEVO_HOSTS}:
        return {"status": 0, "url": final_url, "html": "", "retry_after": "", "wrong_host": True}
    return result


def send_live(endpoint, token, source_url, items):
    payload = json.dumps({
        "source": source_url,
        "observed_at": datetime.now(timezone.utc).isoformat(),
        "items": items,
    }, ensure_ascii=False).encode("utf-8")
    req = Request(endpoint, data=payload, method="POST", headers={
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "Accept": "application/json",
    })
    try:
        with urlopen(req, timeout=10) as response:
            body = json.loads(response.read().decode("utf-8") or "{}")
            if response.status != 200 or not body.get("ok"):
                raise RuntimeError("Cloudflare ingest was not accepted")
            return body
    except HTTPError as exc:
        if exc.code in (401, 403, 404, 413, 503):
            raise RuntimeError(f"Cloudflare ingest returned HTTP {exc.code}; check D1 binding and LIVE_INGEST_TOKEN") from None
        raise RuntimeError(f"Cloudflare ingest returned HTTP {exc.code}") from None


def main():
    base_url = os.getenv("HUEVO_BASE_URL", DEFAULT_BASE_URL).strip().rstrip("/")
    endpoint = os.getenv("HUEVO_LIVE_INGEST_URL", DEFAULT_WORKER + "/api/live/page").strip()
    token = os.getenv("HUEVO_LIVE_INGEST_TOKEN", "").strip()
    profile = os.getenv("HUEVO_CHROME_PROFILE", "").strip()
    if base_url not in ("https://huevo.su", "https://huevo.departament.site"):
        print("HUEVO_BASE_URL must be an approved Huevo HTTPS host.", file=sys.stderr)
        return 2
    if not endpoint.startswith("https://") or not token:
        print("Set HUEVO_LIVE_INGEST_URL and HUEVO_LIVE_INGEST_TOKEN in your local environment.", file=sys.stderr)
        return 2
    if not profile:
        print('Set HUEVO_CHROME_PROFILE to the profile name copied by scripts/clone_chrome_profile.py (for example "Default").', file=sys.stderr)
        return 2
    cooldown = active_cooldown()
    if cooldown:
        print(f"Huevo cooldown active until {cooldown.isoformat()}; no source request sent.", file=sys.stderr)
        return 3

    interval = poll_interval()
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s %(message)s")
    LOG.info("starting first-page polling every %.1f seconds; session stays on this machine", interval)
    browser = None
    try:
        # Visible Chrome makes it easier to see if Huevo asks for a fresh login.
        browser = make_browser(local_login=True, local_profile=True)
        browser.get(base_url + "/")
        current_host = (urlsplit(browser.current_url).hostname or "").lower()
        if current_host not in set(ALLOWED_HUEVO_HOSTS) | {"www." + h for h in ALLOWED_HUEVO_HOSTS}:
            LOG.error("initial Chrome navigation ended on an unexpected host; stopping")
            return 2

        while True:
            started = time.monotonic()
            try:
                result = get_page(browser, base_url)
            except URLError:
                LOG.warning("temporary network error; waiting 15 seconds before next check")
                time.sleep(15)
                continue
            status = int(result.get("status") or 0)
            html = str(result.get("html") or "")
            if result.get("wrong_host"):
                LOG.error("Huevo redirected to an unapproved host; stopping without publishing")
                return 2
            if status in (403, 418, 429):
                retry_after = parse_retry_after(result.get("retry_after"))
                wait_seconds = max(6 * 3600, int(retry_after or 0))
                blocked_until = iso(now_utc() + timedelta(seconds=wait_seconds))
                save_state({"blocked_until": blocked_until, "http_status": status, "checked_at": iso(now_utc())})
                LOG.error("Huevo returned HTTP %d; polling stopped and cooldown saved (values never logged)", status)
                return 3
            if status >= 500 or status < 200 or status >= 400:
                LOG.error("Huevo returned HTTP %d; polling stopped", status)
                return 2

            rows, link_count = parse_cards(html, base_url, ALLOWED_HUEVO_HOSTS)
            from bs4 import BeautifulSoup
            soup = BeautifulSoup(html, "html.parser")
            title = soup.title.get_text(" ", strip=True) if soup.title else ""
            body = soup.body.get_text(" ", strip=True)[:2000] if soup.body else ""
            verdict = classify_page(result.get("url") or base_url + "/market/gifts?page=1",
                                    title, body, link_count,
                                    expected_hosts=set(ALLOWED_HUEVO_HOSTS) | {"www." + h for h in ALLOWED_HUEVO_HOSTS})
            if verdict.get("verdict") in ("login", "blocked", "wrong_host", "server_error") or not rows:
                LOG.error("Huevo page verdict=%s http=%s title=%r cards=%d; polling stopped",
                          verdict.get("verdict"), status, title[:100], len(rows))
                if verdict.get("verdict") == "blocked":
                    blocked_until = iso(now_utc() + timedelta(hours=6))
                    save_state({"blocked_until": blocked_until, "http_status": status, "checked_at": iso(now_utc())})
                    return 3
                return 2

            published = send_live(endpoint, token, base_url + "/market/gifts?page=1", rows)
            LOG.info("first page checked http=%d lots=%d stored=%d fingerprint=%s",
                     status, len(rows), published.get("accepted", len(rows)), str(published.get("fingerprint", ""))[:12])
            remaining = interval - (time.monotonic() - started)
            if remaining > 0:
                time.sleep(remaining)
    except KeyboardInterrupt:
        LOG.info("stopped by operator")
        return 0
    finally:
        if browser is not None:
            try:
                browser.quit()
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
