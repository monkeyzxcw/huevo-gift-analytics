"""Pure helpers for the huEVO Apps payment flow ("support the author" button).

Implements only what the official docs describe:
  - launch-parameter verification (hu_* + hu_hash, HMAC-SHA256 with SHA256(client_secret) as key)
  - payment callback signature (X-Huevo-Signature = HMAC-SHA256 hex of the raw body, same key)
  - POST /payments request body

Docs: https://huevo-docs.lunnaholy.workers.dev/apps/monetization/payments/
No network and no secrets are stored here.
"""
import base64
import hashlib
import hmac
import time
import uuid
from urllib.parse import parse_qsl

API_BASE = "https://huevo.su/api/apps/v1"
MAX_LAUNCH_AGE = 24 * 3600
MIN_AMOUNT, MAX_AMOUNT = 1, 100_000
FINAL_STATUSES = {"succeeded", "failed", "cancelled", "expired"}


def _key(client_secret):
    return hashlib.sha256(client_secret.encode()).digest()


def verify_launch(query, client_secret, max_age=MAX_LAUNCH_AGE, now=None):
    """Return the hu_* params if the signature and freshness are valid, else None."""
    if not client_secret or not isinstance(query, str) or len(query) > 4096:
        return None
    params = dict(parse_qsl(query.lstrip("?"), keep_blank_values=True))
    data = "\n".join(f"{k}={v}" for k, v in sorted(params.items())
                     if k.startswith("hu_") and k != "hu_hash")
    expected = hmac.new(_key(client_secret), data.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, params.get("hu_hash", "")):
        return None
    try:
        age = (time.time() if now is None else now) - int(params.get("hu_ts", ""))
    except ValueError:
        return None
    if not 0 <= age <= max_age:
        return None
    return {k: v for k, v in params.items() if k.startswith("hu_")}


def sign_launch(params, client_secret):
    """Test helper: produce a valid hu_hash for params (used by unit tests only)."""
    data = "\n".join(f"{k}={v}" for k, v in sorted(params.items()) if k.startswith("hu_") and k != "hu_hash")
    return hmac.new(_key(client_secret), data.encode(), hashlib.sha256).hexdigest()


def verify_callback(raw_body, signature, client_secret):
    """Constant-time check of X-Huevo-Signature over the exact raw bytes."""
    if not client_secret or not signature:
        return False
    expected = hmac.new(_key(client_secret), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature.strip().lower())


def clean_amount(value):
    """Integer amount within docs limits, else None. Booleans and floats are rejected."""
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if MIN_AMOUNT <= value <= MAX_AMOUNT else None


def is_test_session(launch):
    """Derive the test flag from VERIFIED launch params (docs: send test=true when hu_mode=test)."""
    return launch.get("hu_mode") != "live"


def payment_body(user_id, amount, test, description="Поддержка автора Huevo Gift Analytics", key=None):
    return {
        "user_id": int(user_id),
        "amount": int(amount),
        "description": description[:200],
        "idempotency_key": key or ("support-" + uuid.uuid4().hex),   # 1-64 chars, unique per app
        "test": bool(test),
    }


def basic_auth_header(client_id, client_secret):
    token = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    return "Basic " + token
