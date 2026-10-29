"""Optional VLESS -> local SOCKS5 bridge for Selenium.

Configure VLESS_URL only as a private environment variable. The value is never
returned by diagnostics or written to logs. This module does not rotate proxies
or retry blocked requests; it only routes the crawler through one configured
VLESS endpoint.
"""
import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from urllib.parse import parse_qs, unquote, urlsplit

LOCAL_HOST = "127.0.0.1"
LOCAL_PORT = int(os.getenv("VLESS_LOCAL_PORT", "10808"))
VLESS_URL = os.getenv("VLESS_URL", "").strip()
XRAY_BIN = os.getenv("XRAY_BIN", "xray")

_lock = threading.Lock()
_process = None
_config_path = None
_last_start_error = None


def parse_vless_url(value):
    """Convert a standard vless:// share URL into an Xray JSON configuration."""
    if not value or not value.strip():
        raise ValueError("VLESS_URL не задан")
    parsed = urlsplit(value.strip())
    if parsed.scheme.lower() != "vless" or not parsed.hostname or not parsed.port:
        raise ValueError("VLESS_URL должен быть полной ссылкой vless:// с сервером и портом")
    user_id = unquote(parsed.username or "")
    if not user_id:
        raise ValueError("В VLESS_URL отсутствует ID/UUID пользователя")

    query = parse_qs(parsed.query, keep_blank_values=True)

    def first(*names, default=""):
        for name in names:
            values = query.get(name)
            if values and values[0] != "":
                return values[0]
        return default

    transport = first("type", "network", default="tcp").lower()
    if transport == "raw":
        transport = "tcp"
    supported = {"tcp", "ws", "grpc", "httpupgrade", "xhttp", "splithttp", "http"}
    if transport not in supported:
        raise ValueError(f"VLESS transport '{transport}' не поддерживается этим адаптером")
    if transport == "splithttp":
        transport = "xhttp"

    security = first("security", default="none").lower()
    if security not in {"none", "tls", "reality"}:
        raise ValueError(f"VLESS security '{security}' не поддерживается")
    server_name = first("sni", "servername", default=first("host", default=parsed.hostname))
    fingerprint = first("fp", default="chrome")
    flow = first("flow")

    user = {"id": user_id, "encryption": "none"}
    if flow:
        user["flow"] = flow
    outbound = {
        "tag": "vless-out",
        "protocol": "vless",
        "settings": {
            "vnext": [{
                "address": parsed.hostname,
                "port": parsed.port,
                "users": [user],
            }]
        },
        "streamSettings": {
            "network": transport,
            "security": security,
        },
    }
    stream = outbound["streamSettings"]

    if security == "tls":
        tls = {"serverName": server_name, "fingerprint": fingerprint}
        alpn = first("alpn")
        if alpn:
            tls["alpn"] = [part.strip() for part in alpn.split(",") if part.strip()]
        if first("allowInsecure") == "1" or first("insecure") == "1":
            tls["allowInsecure"] = True
        stream["tlsSettings"] = tls
    elif security == "reality":
        public_key = first("pbk", "publicKey")
        if not public_key:
            raise ValueError("В VLESS_URL для REALITY отсутствует параметр pbk")
        reality = {
            "serverName": server_name,
            "fingerprint": fingerprint,
            "publicKey": public_key,
            "shortId": first("sid", "shortId"),
            "spiderX": first("spx", "spiderX", default="/"),
        }
        stream["realitySettings"] = reality

    path = first("path", default="/")
    transport_host = first("host", default=server_name)
    if transport == "ws":
        ws = {"path": path}
        if transport_host:
            ws["headers"] = {"Host": transport_host}
        stream["wsSettings"] = ws
    elif transport == "grpc":
        grpc = {"serviceName": first("serviceName", "service_name", default=path.strip("/"))}
        if first("mode") == "multi":
            grpc["multiMode"] = True
        stream["grpcSettings"] = grpc
    elif transport == "httpupgrade":
        stream["httpupgradeSettings"] = {"path": path, "host": transport_host}
    elif transport == "xhttp":
        stream["xhttpSettings"] = {
            "path": path,
            "host": transport_host,
            "mode": first("mode", default="auto"),
        }
    elif transport == "tcp" and first("headerType", "header_type", default="none") not in {"", "none"}:
        stream["tcpSettings"] = {"header": {"type": first("headerType", "header_type")}}

    return {
        "log": {"loglevel": "warning"},
        "inbounds": [{
            "tag": "local-socks",
            "listen": LOCAL_HOST,
            "port": LOCAL_PORT,
            "protocol": "socks",
            "settings": {"auth": "noauth", "udp": False},
        }],
        "outbounds": [outbound, {"tag": "direct", "protocol": "freedom"}],
        "routing": {
            "domainStrategy": "AsIs",
            "rules": [{
                "type": "field",
                "inboundTag": ["local-socks"],
                "outboundTag": "vless-out",
            }],
        },
    }


def _port_ready():
    try:
        with socket.create_connection((LOCAL_HOST, LOCAL_PORT), timeout=0.3):
            return True
    except OSError:
        return False


def ensure_vless_proxy():
    """Start Xray lazily and return a local SOCKS5 URL, or None when disabled."""
    global _process, _config_path, _last_start_error
    if not VLESS_URL:
        return None
    with _lock:
        if _process is not None and _process.poll() is None and _port_ready():
            return f"socks5://{LOCAL_HOST}:{LOCAL_PORT}"
        xray_path = shutil.which(XRAY_BIN)
        if not xray_path:
            _last_start_error = "Xray binary is missing; rebuild the Docker image"
            raise RuntimeError(_last_start_error)
        try:
            config = parse_vless_url(VLESS_URL)
        except (ValueError, TypeError) as exc:
            _last_start_error = str(exc)
            raise RuntimeError(_last_start_error) from exc

        fd, path = tempfile.mkstemp(prefix="huevo-xray-", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(config, handle, ensure_ascii=False)
            os.chmod(path, 0o600)
        except Exception:
            try:
                os.unlink(path)
            except OSError:
                pass
            raise

        try:
            process = subprocess.Popen(
                [xray_path, "run", "-c", path],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
            )
        except OSError as exc:
            os.unlink(path)
            _last_start_error = "Xray failed to start"
            raise RuntimeError(_last_start_error) from exc

        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            if process.poll() is not None:
                try:
                    os.unlink(path)
                except OSError:
                    pass
                _last_start_error = "Xray exited while starting; check VLESS_URL format and server availability"
                raise RuntimeError(_last_start_error)
            if _port_ready():
                _process, _config_path, _last_start_error = process, path, None
                return f"socks5://{LOCAL_HOST}:{LOCAL_PORT}"
            time.sleep(0.2)

        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
        try:
            os.unlink(path)
        except OSError:
            pass
        _last_start_error = "Xray did not open the local SOCKS port"
        raise RuntimeError(_last_start_error)


def proxy_status():
    with _lock:
        return {
            "configured": bool(VLESS_URL),
            "running": bool(_process is not None and _process.poll() is None and _port_ready()),
            "local_socks": f"{LOCAL_HOST}:{LOCAL_PORT}" if VLESS_URL else None,
            "last_error": _last_start_error,
        }
