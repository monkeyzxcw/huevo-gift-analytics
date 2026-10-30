import { authenticateHuevoLaunch, currentAccount, saveAccountProfile, purgeAuthRecords, authenticatedUserId } from "./auth.js";
import { verifyHuevoLaunch } from "./huevo_launch.js";

const HUEVO_HOSTS = new Set(["huevo.su", "huevo.departament.site"]);
const MAX_LIVE_BODY_BYTES = 256_000;
const MAX_SNAPSHOT_BODY_BYTES = 1_500_000;
const LIVE_FRESH_SECONDS = 15;
const LIVE_MERGE_SECONDS = 60 * 60;
const DEFAULT_RETENTION_HOURS = 72;
const FRAME_ANCESTORS = "'self' https://huevo.su https://*.huevo.su https://huevo.departament.site https://*.huevo.departament.site";

function isAllowedHost(host) {
  const value = String(host || "").toLowerCase().replace(/\.$/, "");
  return [...HUEVO_HOSTS].some((root) => value === root || value.endsWith("." + root));
}

function corsOrigin(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return "";
  if (env.ALLOWED_ORIGIN && origin === String(env.ALLOWED_ORIGIN).trim()) return origin;
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && isAllowedHost(url.hostname) ? origin : "";
  } catch (_) {
    return "";
  }
}

function responseHeaders(request, env, extra = {}) {
  const headers = new Headers(extra);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), notifications=(self)");
  const pagePath = new URL(request.url).pathname;
  const supportsHuEvoSdk = pagePath === "/" || pagePath === "/index.html";
  const csp = supportsHuEvoSdk
    ? `default-src 'none'; script-src 'self' https://huevo.su; style-src 'self'; img-src 'self' https://huevo.su https://*.huevo.su https://huevo.departament.site data:; connect-src 'self' https://huevo.su https://*.huevo.su; base-uri 'none'; form-action 'none'; frame-ancestors ${FRAME_ANCESTORS}`
    : `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${FRAME_ANCESTORS}`;
  headers.set("Content-Security-Policy", csp);
  const origin = corsOrigin(request, env);
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    headers.append("Vary", "Origin");
  }
  return headers;
}

function jsonResponse(request, env, value, status = 200, extra = {}) {
  const headers = responseHeaders(request, env, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extra,
  });
  return new Response(JSON.stringify(value), { status, headers });
}

function constantTimeEqual(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  if (!a || a.length !== b.length) return false;
  let different = 0;
  for (let i = 0; i < a.length; i++) different |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return different === 0;
}

function hasIngestAuth(request, env) {
  if (!env.LIVE_INGEST_TOKEN) return false;
  const match = (request.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/i);
  return Boolean(match && constantTimeEqual(match[1].trim(), env.LIVE_INGEST_TOKEN));
}

function retentionHours(env) {
  const parsed = Number.parseInt(String(env.HUEVO_RETENTION_HOURS || DEFAULT_RETENTION_HOURS), 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 720)) : DEFAULT_RETENTION_HOURS;
}

function isSafeHttpsHuevoUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && isAllowedHost(url.hostname) && !url.username && !url.password;
  } catch (_) {
    return false;
  }
}

function sanitizeLiveItems(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new Error("items must be a list with 1–100 lots");
  }
  const seen = new Set();
  const items = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const id = String(raw.lot_id ?? "").trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const price = raw.price == null ? null : Number(raw.price);
    if (price != null && (!Number.isFinite(price) || price < 0)) continue;
    const fallbackLotUrl = "https://huevo.su/market/lot/" + encodeURIComponent(id);
    const lotUrl = isSafeHttpsHuevoUrl(raw.lot_url) ? String(raw.lot_url) : fallbackLotUrl;
    const imageUrl = isSafeHttpsHuevoUrl(raw.image_url) ? String(raw.image_url) : "";
    items.push({
      lot_id: id,
      title: String(raw.title || "Без названия").slice(0, 300),
      serial: String(raw.serial || "").slice(0, 120),
      rarity: String(raw.rarity || "").slice(0, 80),
      price,
      status: String(raw.status || "Неизвестно").slice(0, 80),
      lot_url: lotUrl,
      image_url: imageUrl,
      active: true,
    });
  }
  if (!items.length) throw new Error("no valid lots found");
  return items;
}

async function readJsonBody(request, limit) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > limit) return { error: "request body too large", status: 413 };
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > limit) return { error: "request body too large", status: 413 };
  try {
    return { value: JSON.parse(raw) };
  } catch (_) {
    return { error: "expected valid JSON", status: 400 };
  }
}

async function ensureSupportSchema(env) {
  if (!env.DB) return false;
  try {
    const existing = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='support_payments'"
    ).first();
    if (!existing) {
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS support_payments (" +
        "intent_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, " +
        "amount INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 100000), " +
        "test INTEGER NOT NULL DEFAULT 1 CHECK (test IN (0, 1)), " +
        "status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'cancelled', 'expired')), " +
        "created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT)"
      ).run();
      await env.DB.prepare(
        "CREATE INDEX IF NOT EXISTS idx_support_payments_status_test ON support_payments (status, test)"
      ).run();
      await env.DB.prepare(
        "CREATE INDEX IF NOT EXISTS idx_support_payments_created_at ON support_payments (created_at)"
      ).run();
    }
    const ready = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='support_payments'"
    ).first();
    return Boolean(ready);
  } catch (_) {
    return false;
  }
}

async function getStorageHealth(env) {
  if (!env.DB) return {
    storage_configured: false, schema_ready: false, support_schema_ready: false,
    accounts_schema_ready: false, ingest_enabled: Boolean(env.LIVE_INGEST_TOKEN)
  };
  const supportSchemaReady = await ensureSupportSchema(env);
  try {
    const result = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('full_snapshot','live_page_state','live_price_history','user_accounts','user_sessions','user_profiles','auth_rate_limits','push_vapid_keys','push_subscriptions','push_alert_state')"
    ).all();
    const names = new Set((result.results || []).map((row) => row.name));
    return {
      storage_configured: true,
      schema_ready: names.has("full_snapshot") && names.has("live_page_state") && names.has("live_price_history"),
      support_schema_ready: supportSchemaReady,
      accounts_schema_ready: ["user_accounts", "user_sessions", "user_profiles", "auth_rate_limits"].every((name) => names.has(name)),
      push_schema_ready: ["push_vapid_keys", "push_subscriptions", "push_alert_state"].every((name) => names.has(name)),
      ingest_enabled: Boolean(env.LIVE_INGEST_TOKEN),
    };
  } catch (_) {
    return {
      storage_configured: true, schema_ready: false, support_schema_ready: supportSchemaReady,
      accounts_schema_ready: false, ingest_enabled: Boolean(env.LIVE_INGEST_TOKEN)
    };
  }
}

async function getLiveState(env) {
  if (!env.DB) return null;
  const row = await env.DB.prepare(
    "SELECT items_json, fingerprint, last_poll_at, item_count, source FROM live_page_state WHERE id = 1"
  ).first();
  if (!row) return null;
  let items = [];
  try {
    items = JSON.parse(row.items_json);
    if (!Array.isArray(items)) items = [];
  } catch (_) {
    items = [];
  }
  const ageSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(row.last_poll_at)) / 1000));
  return {
    enabled: true,
    fresh: Number.isFinite(ageSeconds) && ageSeconds <= LIVE_FRESH_SECONDS,
    age_seconds: Number.isFinite(ageSeconds) ? ageSeconds : null,
    last_poll_at: row.last_poll_at,
    fingerprint: row.fingerprint,
    item_count: Number(row.item_count) || items.length,
    source: row.source,
    items,
  };
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function ingestLivePage(request, env, ctx) {
  if (!env.DB) return jsonResponse(request, env, { ok: false, error: "Cloudflare D1 is not bound yet" }, 503);
  if (!env.LIVE_INGEST_TOKEN) return jsonResponse(request, env, { ok: false, error: "LIVE_INGEST_TOKEN is not configured" }, 503);
  if (!hasIngestAuth(request, env)) return jsonResponse(request, env, { ok: false, error: "unauthorized" }, 401);

  const parsed = await readJsonBody(request, MAX_LIVE_BODY_BYTES);
  if (parsed.error) return jsonResponse(request, env, { ok: false, error: parsed.error }, parsed.status);
  const payload = parsed.value;
  if (!payload || typeof payload !== "object") return jsonResponse(request, env, { ok: false, error: "expected JSON object" }, 400);
  if (payload.source && !isSafeHttpsHuevoUrl(payload.source)) {
    return jsonResponse(request, env, { ok: false, error: "source must be an approved Huevo HTTPS URL" }, 400);
  }

  let items;
  try {
    items = sanitizeLiveItems(payload.items);
  } catch (error) {
    return jsonResponse(request, env, { ok: false, error: error.message }, 400);
  }

  const observedAt = new Date().toISOString();
  const fingerprintSource = JSON.stringify(items.map((item) => ({
    lot_id: item.lot_id, title: item.title, rarity: item.rarity, price: item.price, status: item.status,
  })));
  const fingerprint = await sha256Hex(fingerprintSource);
  let previousItems = [];
  try {
    const previous = await env.DB.prepare("SELECT items_json FROM live_page_state WHERE id = 1").first();
    if (previous && previous.items_json) {
      previousItems = JSON.parse(previous.items_json);
      if (!Array.isArray(previousItems)) previousItems = [];
    }
  } catch (_) {
    return jsonResponse(request, env, { ok: false, error: "D1 tables are not initialized; apply migrations first" }, 503);
  }
  const oldById = new Map(previousItems.map((item) => [String(item.lot_id), item]));
  const statements = [];
  const source = isSafeHttpsHuevoUrl(payload.source) ? String(payload.source) : "https://huevo.su/market/gifts?page=1";
  statements.push(env.DB.prepare(
    "INSERT INTO live_page_state (id, items_json, fingerprint, last_poll_at, item_count, source) VALUES (1, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(id) DO UPDATE SET items_json=excluded.items_json, fingerprint=excluded.fingerprint, " +
    "last_poll_at=excluded.last_poll_at, item_count=excluded.item_count, source=excluded.source"
  ).bind(JSON.stringify(items), fingerprint, observedAt, items.length, source));

  for (const item of items) {
    if (typeof item.price !== "number") continue;
    const old = oldById.get(item.lot_id);
    if (!old || Number(old.price) !== item.price) {
      statements.push(env.DB.prepare(
        "INSERT OR IGNORE INTO live_price_history (lot_id, observed_at, price, title, status) VALUES (?, ?, ?, ?, ?)"
      ).bind(item.lot_id, observedAt, item.price, item.title, item.status));
    }
  }
  try {
    await env.DB.batch(statements);
  } catch (_) {
    return jsonResponse(request, env, { ok: false, error: "could not write live state; check D1 migrations" }, 503);
  }
  schedulePushEvaluation(env, items, ctx);
  return jsonResponse(request, env, {
    ok: true, accepted: items.length, fingerprint, observed_at: observedAt,
  }, 200);
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q;
  const lo = Math.floor(position), hi = Math.ceil(position);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (position - lo);
}

function refreshStats(data) {
  if (!Array.isArray(data.lots)) return;
  const active = data.lots.filter((lot) => lot && lot.active !== false);
  const prices = active.map((lot) => lot.price).filter((price) => typeof price === "number" && Number.isFinite(price) && price > 0).sort((a, b) => a - b);
  const sum = prices.reduce((total, price) => total + price, 0);
  const middle = prices.length ? (prices.length % 2 ? prices[(prices.length - 1) / 2] : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2) : null;
  data.stats = {
    n_total: active.length,
    priced: prices.length,
    min: prices.length ? prices[0] : null,
    max: prices.length ? prices[prices.length - 1] : null,
    avg: prices.length ? Math.round((sum / prices.length) * 100) / 100 : null,
    median: middle,
    p25: quantile(prices, 0.25),
    p75: quantile(prices, 0.75),
  };
}

async function loadPublishedSnapshot(request, env) {
  let data = null;
  if (env.DB) {
    try {
      const row = await env.DB.prepare("SELECT data_json FROM full_snapshot WHERE id = 1").first();
      if (row && row.data_json) data = JSON.parse(row.data_json);
    } catch (_) {
      // Before D1 migrations are applied, gracefully use the deployed static baseline.
    }
  }
  if (!data) {
    if (!env.ASSETS) return jsonResponse(request, env, { ok: false, error: "static asset binding unavailable" }, 503);
    const assetUrl = new URL("/data.json", request.url);
    const assetResponse = await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: "GET" }));
    if (!assetResponse.ok) return assetResponse;
    try {
      data = await assetResponse.json();
    } catch (_) {
      return jsonResponse(request, env, { ok: false, error: "published data.json is invalid" }, 502);
    }
  }

  let live = null;
  let historyRows = [];
  if (env.DB) {
    try {
      live = await getLiveState(env);
      const cutoff = new Date(Date.now() - retentionHours(env) * 3600_000).toISOString();
      const results = await env.DB.prepare(
        "SELECT lot_id, observed_at, price, title, status FROM live_price_history WHERE observed_at >= ? ORDER BY observed_at DESC LIMIT 2000"
      ).bind(cutoff).all();
      historyRows = results.results || [];
    } catch (_) {
      live = null;
      historyRows = [];
    }
  }

  const liveEnabled = Boolean(env.DB);
  const liveAge = live && live.age_seconds != null ? live.age_seconds : null;
  data.live = {
    enabled: liveEnabled,
    fresh: Boolean(live && live.fresh),
    last_poll_at: live ? live.last_poll_at : null,
    item_count: live ? live.item_count : 0,
    age_seconds: liveAge,
    fingerprint: live ? live.fingerprint : null,
    message: !liveEnabled ? "Cloudflare D1 не подключена." :
      !live ? "Ожидается первый локальный опрос Huevo." :
      live.fresh ? "Первая страница Huevo обновляется в реальном времени." :
      "Локальный опрос первой страницы не поступал более 15 секунд.",
  };

  if (live && Array.isArray(data.lots) && liveAge != null && liveAge <= LIVE_MERGE_SECONDS) {
    const liveById = new Map(live.items.map((item) => [String(item.lot_id), item]));
    const historyById = new Map();
    for (const row of historyRows) {
      const id = String(row.lot_id);
      if (!historyById.has(id)) historyById.set(id, []);
      historyById.get(id).push({ observed_at: row.observed_at, price: row.price });
    }
    const seen = new Set();
    data.lots = data.lots.map((lot) => {
      const id = String(lot.lot_id);
      const fresh = liveById.get(id);
      const historic = historyById.get(id) || [];
      const oldHistory = Array.isArray(lot.history) ? lot.history : [];
      const mergedHistory = new Map();
      for (const point of [...oldHistory, ...historic]) {
        if (!point || !point.observed_at || typeof point.price !== "number") continue;
        mergedHistory.set(String(point.observed_at) + "|" + String(point.price), point);
      }
      const history = [...mergedHistory.values()].sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
      if (!fresh) return { ...lot, history };
      seen.add(id);
      return {
        ...lot,
        title: fresh.title || lot.title,
        serial: fresh.serial || lot.serial,
        rarity: fresh.rarity || lot.rarity,
        price: fresh.price,
        status: fresh.status || lot.status,
        lot_url: fresh.lot_url || lot.lot_url,
        image_url: fresh.image_url || lot.image_url,
        active: true,
        last_seen: live.last_poll_at,
        history,
      };
    });
    for (const item of live.items) {
      if (seen.has(String(item.lot_id)) || data.lots.some((lot) => String(lot.lot_id) === String(item.lot_id))) continue;
      const history = historyById.get(String(item.lot_id)) || [];
      data.lots.push({
        ...item,
        first_seen: live.last_poll_at,
        last_seen: live.last_poll_at,
        active: true,
        history,
      });
    }
    refreshStats(data);
  }
  return jsonResponse(request, env, data, 200);
}

async function liveStatus(request, env) {
  const health = await getStorageHealth(env);
  if (!env.DB || !health.schema_ready) {
    return jsonResponse(request, env, {
      enabled: false,
      storage_configured: health.storage_configured,
      schema_ready: health.schema_ready,
      fresh: false,
      last_poll_at: null,
      item_count: 0,
      items: [],
    });
  }
  let live = null;
  try {
    live = await getLiveState(env);
  } catch (_) {
    return jsonResponse(request, env, { enabled: true, storage_configured: true, schema_ready: false, fresh: false, items: [] }, 503);
  }
  return jsonResponse(request, env, {
    enabled: true,
    storage_configured: true,
    schema_ready: true,
    fresh: Boolean(live && live.fresh),
    last_poll_at: live ? live.last_poll_at : null,
    age_seconds: live ? live.age_seconds : null,
    fingerprint: live ? live.fingerprint : null,
    item_count: live ? live.item_count : 0,
    items: live ? live.items : [],
  });
}

async function storeFullSnapshot(request, env, ctx) {
  if (!env.DB) return jsonResponse(request, env, { ok: false, error: "Cloudflare D1 is not bound yet" }, 503);
  if (!env.LIVE_INGEST_TOKEN) return jsonResponse(request, env, { ok: false, error: "LIVE_INGEST_TOKEN is not configured" }, 503);
  if (!hasIngestAuth(request, env)) return jsonResponse(request, env, { ok: false, error: "unauthorized" }, 401);
  const parsed = await readJsonBody(request, MAX_SNAPSHOT_BODY_BYTES);
  if (parsed.error) return jsonResponse(request, env, { ok: false, error: parsed.error }, parsed.status);
  const data = parsed.value;
  if (!data || typeof data !== "object" || !Array.isArray(data.lots) || data.lots.length < 1 ||
      typeof data.generated_at !== "string" || !Number.isFinite(Date.parse(data.generated_at))) {
    return jsonResponse(request, env, { ok: false, error: "snapshot needs a generated_at timestamp and non-empty lots array" }, 400);
  }
  const writtenAt = new Date().toISOString();
  try {
    await env.DB.prepare(
      "INSERT INTO full_snapshot (id, data_json, generated_at, updated_at) VALUES (1, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json, generated_at=excluded.generated_at, updated_at=excluded.updated_at"
    ).bind(JSON.stringify(data), data.generated_at, writtenAt).run();
  } catch (_) {
    return jsonResponse(request, env, { ok: false, error: "could not store snapshot; check D1 migrations" }, 503);
  }
  schedulePushEvaluation(env, data.lots, ctx);
  return jsonResponse(request, env, {
    ok: true, stored_at: writtenAt, generated_at: data.generated_at, lots: data.lots.length,
    collector_status: data.collector && data.collector.status || "unknown",
  });
}


const PUSH_ALLOWED_HOSTS = new Set([
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com"
]);
const PUSH_DEFAULT_TTL = 60 * 60 * 24;

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const raw = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = raw + "=".repeat((4 - raw.length % 4) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function concatBytes(...chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

async function ensureVapidKeys(env) {
  if (!env.DB) return null;
  let row = await env.DB.prepare(
    "SELECT public_key, private_jwk FROM push_vapid_keys WHERE id = 1"
  ).first();
  if (row && row.public_key && row.private_jwk) return row;

  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicBytes = concatBytes(
    new Uint8Array([4]),
    base64UrlToBytes(publicJwk.x),
    base64UrlToBytes(publicJwk.y)
  );
  const publicKey = bytesToBase64Url(publicBytes);
  const privateKey = JSON.stringify({
    kty: "EC", crv: "P-256", x: privateJwk.x, y: privateJwk.y,
    d: privateJwk.d, ext: true, key_ops: ["sign"]
  });
  await env.DB.prepare(
    "INSERT OR IGNORE INTO push_vapid_keys (id, public_key, private_jwk, created_at) VALUES (1, ?, ?, ?)"
  ).bind(publicKey, privateKey, new Date().toISOString()).run();
  row = await env.DB.prepare(
    "SELECT public_key, private_jwk FROM push_vapid_keys WHERE id = 1"
  ).first();
  return row && row.public_key && row.private_jwk ? row : null;
}

function isSameOriginMutation(request) {
  const origin = request.headers.get("Origin");
  return Boolean(origin && origin === new URL(request.url).origin);
}

function validPushEndpoint(value) {
  try {
    const url = new URL(String(value || ""));
    const host = url.hostname.toLowerCase();
    const allowed = PUSH_ALLOWED_HOSTS.has(host) ||
      host.endsWith(".fcm.googleapis.com") ||
      host.endsWith(".push.services.mozilla.com") ||
      host.endsWith(".notify.windows.com");
    return url.protocol === "https:" && allowed && !url.username && !url.password && url.href.length <= 2048;
  } catch (_) {
    return false;
  }
}

async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey(
    "raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, dataBytes));
}

async function hkdfExpand(prk, info, length) {
  const blocks = [];
  let previous = new Uint8Array(0);
  let generated = 0;
  for (let counter = 1; generated < length; counter++) {
    previous = await hmacSha256(prk, concatBytes(previous, info, new Uint8Array([counter])));
    blocks.push(previous);
    generated += previous.length;
  }
  return concatBytes(...blocks).slice(0, length);
}

function uint16be(value) {
  return new Uint8Array([(value >>> 8) & 255, value & 255]);
}

function uint32be(value) {
  return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
}

async function vapidAuthorization(endpoint, keys) {
  const audience = new URL(endpoint).origin;
  const header = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: "https://github.com/monkeyzxcw/huevo-gift-analytics"
  })));
  const unsigned = header + "." + payload;
  const privateJwk = JSON.parse(keys.private_jwk);
  const signingKey = await crypto.subtle.importKey(
    "jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, signingKey, new TextEncoder().encode(unsigned)
  ));
  return "vapid t=" + unsigned + "." + bytesToBase64Url(signature) + ", k=" + keys.public_key;
}

async function encryptPushPayload(subscription, payload) {
  const uaPublic = base64UrlToBytes(subscription.p256dh);
  const authSecret = base64UrlToBytes(subscription.auth_secret);
  if (uaPublic.length !== 65 || authSecret.length !== 16 || uaPublic[0] !== 4) {
    throw new Error("invalid push subscription key material");
  }
  const clientKey = await crypto.subtle.importKey(
    "raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []
  );
  const senderKeys = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]
  );
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", senderKeys.publicKey));
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: clientKey }, senderKeys.privateKey, 256
  ));

  const keyInfo = concatBytes(
    new TextEncoder().encode("WebPush: info\0"), uaPublic, asPublic
  );
  const authPrk = await hmacSha256(authSecret, sharedSecret);
  const inputKeyMaterial = await hkdfExpand(authPrk, keyInfo, 32);
  const salt = randomBytes(16);
  const prk = await hmacSha256(salt, inputKeyMaterial);
  const context = concatBytes(
    new TextEncoder().encode("P-256\0"),
    uint16be(uaPublic.length), uaPublic,
    uint16be(asPublic.length), asPublic
  );
  const cek = await hkdfExpand(
    prk, concatBytes(new TextEncoder().encode("Content-Encoding: aes128gcm\0"), context), 16
  );
  const nonce = await hkdfExpand(
    prk, concatBytes(new TextEncoder().encode("Content-Encoding: nonce\0"), context), 12
  );
  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const plaintext = concatBytes(new TextEncoder().encode(JSON.stringify(payload)), new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, plaintext
  ));
  return concatBytes(salt, uint32be(4096), new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

async function sendWebPush(env, keys, subscription, payload) {
  const endpoint = subscription.endpoint;
  if (!validPushEndpoint(endpoint)) return { ok: false, status: 400 };
  try {
    const body = await encryptPushPayload(subscription, payload);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": await vapidAuthorization(endpoint, keys),
        "Content-Type": "application/octet-stream",
        "Content-Encoding": "aes128gcm",
        "TTL": String(PUSH_DEFAULT_TTL),
        "Urgency": "high"
      },
      body
    });
    if (response.status === 404 || response.status === 410) {
      await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint_hash = ?")
        .bind(subscription.endpoint_hash).run().catch(() => undefined);
    }
    return { ok: response.status >= 200 && response.status < 300, status: response.status };
  } catch (_) {
    return { ok: false, status: 0 };
  }
}

async function pushConfig(request, env) {
  const keys = await ensureVapidKeys(env).catch(() => null);
  return jsonResponse(request, env, {
    enabled: Boolean(keys && keys.public_key),
    public_key: keys ? keys.public_key : null
  }, keys ? 200 : 503);
}

async function pushStatus(request, env) {
  const userId = await authenticatedUserId(request, env);
  if (!userId) {
    return jsonResponse(request, env, { ok: true, authenticated: false, enabled: false, subscriptions: 0 });
  }
  try {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id = ?"
    ).bind(userId).first();
    return jsonResponse(request, env, {
      ok: true, authenticated: true, enabled: true, subscriptions: Number(row && row.count) || 0
    });
  } catch (_) {
    return jsonResponse(request, env, { ok: false, error: "push storage unavailable" }, 503);
  }
}

async function savePushSubscription(request, env) {
  if (!isSameOriginMutation(request)) return jsonResponse(request, env, { ok: false, error: "same-origin request required" }, 403);
  const userId = await authenticatedUserId(request, env);
  if (!userId) return jsonResponse(request, env, { ok: false, error: "Открой AMNYAM внутри huEVO и войди в профиль, чтобы подключить push." }, 401);
  if (!(await ensureVapidKeys(env).catch(() => null))) {
    return jsonResponse(request, env, { ok: false, error: "Web Push сейчас не настроен на сервере." }, 503);
  }
  const parsed = await readJsonBody(request, 12000);
  if (parsed.error) return jsonResponse(request, env, { ok: false, error: parsed.error }, parsed.status);
  const payload = parsed.value;
  const endpoint = String(payload.endpoint || "");
  const p256dh = String(payload.keys && payload.keys.p256dh || "");
  const authSecret = String(payload.keys && payload.keys.auth || "");
  if (!validPushEndpoint(endpoint)) return jsonResponse(request, env, { ok: false, error: "Неподдерживаемый push endpoint браузера." }, 400);
  try {
    if (base64UrlToBytes(p256dh).length !== 65 || base64UrlToBytes(authSecret).length !== 16) {
      throw new Error("bad key lengths");
    }
  } catch (_) {
    return jsonResponse(request, env, { ok: false, error: "Некорректные ключи push-подписки." }, 400);
  }
  const endpointHash = await sha256Hex(endpoint);
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      "INSERT INTO push_subscriptions (endpoint_hash, user_id, endpoint, p256dh, auth_secret, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(endpoint_hash) DO UPDATE SET " +
      "user_id=excluded.user_id, endpoint=excluded.endpoint, p256dh=excluded.p256dh, " +
      "auth_secret=excluded.auth_secret, updated_at=excluded.updated_at"
    ).bind(endpointHash, userId, endpoint, p256dh, authSecret, now, now).run();
    return jsonResponse(request, env, { ok: true, saved: true });
  } catch (_) {
    return jsonResponse(request, env, { ok: false, error: "Не удалось сохранить push-подписку в D1." }, 503);
  }
}

async function pushTest(request, env) {
  if (!isSameOriginMutation(request)) return jsonResponse(request, env, { ok: false, error: "same-origin request required" }, 403);
  const userId = await authenticatedUserId(request, env);
  if (!userId) return jsonResponse(request, env, { ok: false, error: "Требуется активный профиль huEVO." }, 401);
  const keys = await ensureVapidKeys(env).catch(() => null);
  if (!keys) return jsonResponse(request, env, { ok: false, error: "Ключ сервера push недоступен." }, 503);
  let result;
  try {
    result = await env.DB.prepare(
      "SELECT endpoint_hash, endpoint, p256dh, auth_secret FROM push_subscriptions WHERE user_id = ?"
    ).bind(userId).all();
  } catch (_) {
    return jsonResponse(request, env, { ok: false, error: "Хранилище push-подписок не готово." }, 503);
  }
  const subscriptions = result.results || [];
  if (!subscriptions.length) return jsonResponse(request, env, { ok: false, error: "Сначала подключи push на этом устройстве." }, 409);
  const outcomes = await Promise.all(subscriptions.map((subscription) => sendWebPush(env, keys, subscription, {
    title: "AMNYAM · тестовый push",
    body: "Отлично! Серверное уведомление доставлено даже без открытой вкладки приложения.",
    url: "/?view=favorites",
    tag: "amnyam-push-test",
    kind: "test",
    sent_at: new Date().toISOString()
  })));
  const sent = outcomes.filter((item) => item.ok).length;
  return jsonResponse(request, env, {
    ok: sent > 0, sent, failed: outcomes.length - sent,
    statuses: outcomes.map((item) => item.status)
  }, sent > 0 ? 200 : 502);
}

async function removePushSubscriptions(request, env) {
  if (!isSameOriginMutation(request)) return jsonResponse(request, env, { ok: false, error: "same-origin request required" }, 403);
  const userId = await authenticatedUserId(request, env);
  if (!userId) return jsonResponse(request, env, { ok: false, error: "Требуется активный профиль huEVO." }, 401);
  const parsed = await readJsonBody(request, 4000);
  if (parsed.error) return jsonResponse(request, env, { ok: false, error: parsed.error }, parsed.status);
  const endpoint = String(parsed.value.endpoint || "");
  if (!validPushEndpoint(endpoint)) return jsonResponse(request, env, { ok: false, error: "Не удалось определить push-подписку этого браузера." }, 400);
  const endpointHash = await sha256Hex(endpoint);
  try {
    const result = await env.DB.prepare(
      "DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint_hash = ?"
    ).bind(userId, endpointHash).run();
    return jsonResponse(request, env, { ok: true, removed: Number(result.meta && result.meta.changes) || 0 });
  } catch (_) {
    return jsonResponse(request, env, { ok: false, error: "Не удалось отключить push." }, 503);
  }
}

async function evaluatePushTargets(env, incomingLots) {
  if (!env.DB || !Array.isArray(incomingLots) || !incomingLots.length) return;
  let keys;
  let rows;
  let states;
  try {
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM push_subscriptions").first();
    if (!Number(count && count.count)) return;
    keys = await ensureVapidKeys(env);
    if (!keys) return;
    rows = await env.DB.prepare(
      "SELECT p.user_id, p.profile_json, s.endpoint_hash, s.endpoint, s.p256dh, s.auth_secret " +
      "FROM user_profiles p JOIN push_subscriptions s ON s.user_id = p.user_id"
    ).all();
    states = await env.DB.prepare(
      "SELECT user_id, lot_id, target_price FROM push_alert_state"
    ).all();
  } catch (_) {
    return;
  }
  const lots = new Map();
  for (const lot of incomingLots) {
    if (!lot || lot.lot_id == null || lot.active === false) continue;
    const id = String(lot.lot_id);
    const price = lot.price == null ? null : Number(lot.price);
    if (!/^\d{1,20}$/.test(id) || !Number.isFinite(price) || price < 0) continue;
    lots.set(id, {
      lot_id: id, title: String(lot.title || ("Лот #" + id)).slice(0, 180),
      price, lot_url: "https://huevo.su/market/lot/" + encodeURIComponent(id)
    });
  }

  const users = new Map();
  for (const row of rows.results || []) {
    let user = users.get(String(row.user_id));
    if (!user) {
      let profile = {};
      try { profile = JSON.parse(row.profile_json || "{}"); } catch (_) {}
      const targets = profile && profile.targets && typeof profile.targets === "object" && !Array.isArray(profile.targets)
        ? profile.targets : {};
      user = { targets, subscriptions: [], states: new Map() };
      users.set(String(row.user_id), user);
    }
    user.subscriptions.push(row);
  }
  for (const row of states.results || []) {
    const user = users.get(String(row.user_id));
    if (user) user.states.set(String(row.lot_id), Number(row.target_price));
  }

  const tasks = [];
  const now = new Date().toISOString();
  for (const [userId, user] of users) {
    const targetEntries = Object.entries(user.targets).filter(([id, value]) =>
      /^\d{1,20}$/.test(id) && Number.isSafeInteger(value) && value > 0 && value <= 1e15
    );
    const targetIds = new Set(targetEntries.map(([id]) => id));
    for (const oldId of user.states.keys()) {
      if (!targetIds.has(oldId)) {
        tasks.push(env.DB.prepare("DELETE FROM push_alert_state WHERE user_id = ? AND lot_id = ?").bind(userId, oldId).run());
        user.states.delete(oldId);
      }
    }
    for (const [lotId, target] of targetEntries) {
      const lot = lots.get(lotId);
      if (!lot) continue;
      const oldTarget = user.states.get(lotId);
      if (lot.price > target) {
        if (oldTarget != null) {
          tasks.push(env.DB.prepare("DELETE FROM push_alert_state WHERE user_id = ? AND lot_id = ?").bind(userId, lotId).run());
          user.states.delete(lotId);
        }
        continue;
      }
      // SQLite's conditional UPSERT is an atomic one-shot claim: concurrent live
      // and full-snapshot ingests cannot send duplicate alerts for the same target.
      const claim = await env.DB.prepare(
        "INSERT INTO push_alert_state (user_id, lot_id, target_price, alerted_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(user_id, lot_id) DO UPDATE SET target_price=excluded.target_price, alerted_at=excluded.alerted_at " +
        "WHERE push_alert_state.target_price != excluded.target_price RETURNING lot_id"
      ).bind(userId, lotId, target, now).first().catch(() => null);
      if (!claim) continue;
      const payload = {
        title: "AMNYAM · достигнута цена-цель",
        body: lot.title + ": " + lot.price.toLocaleString("ru-RU") +
          " монэток (цель " + target.toLocaleString("ru-RU") + ").",
        url: lot.lot_url,
        tag: "amnyam-target-" + lotId,
        kind: "target",
        lot_id: lotId,
        price: lot.price,
        target_price: target,
        sent_at: now
      };
      for (const subscription of user.subscriptions) {
        tasks.push(sendWebPush(env, keys, subscription, payload));
      }
    }
  }
  if (tasks.length) await Promise.allSettled(tasks);
}

function schedulePushEvaluation(env, lots, ctx) {
  const task = evaluatePushTargets(env, lots).catch(() => undefined);
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(task);
  else return task;
}

const SUPPORT_AMOUNTS = [5000, 10000, 25000, 50000, 100000];
const SUPPORT_FINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "expired"]);
const HUEVO_APPS_API = "https://huevo.su/api/apps/v1";
const HUEVO_APPS_SDK = "https://huevo.su/static/js/huevo-apps-v1.js";

function supportCredentials(env) {
  const configuredAppId = String(env.HU_APP_ID || "").trim();
  // Apps API client_id is distinct from the numeric hu_app_id launch parameter.
  // Keep the legacy non-numeric HU_APP_ID fallback so existing deployments
  // continue working until HU_CLIENT_ID is configured explicitly.
  const legacyClientId = configuredAppId && !/^\\d{1,20}$/.test(configuredAppId) ? configuredAppId : "";
  return {
    clientId: String(env.HU_CLIENT_ID || env.HUEVO_CLIENT_ID || legacyClientId).trim(),
    clientSecret: String(env.HU_SECRET || env.HUEVO_CLIENT_SECRET || "").trim(),
  };
}


function supportDbConfigured(env) {
  return Boolean(env.DB);
}

async function supportConfig(request, env) {
  const credentials = supportCredentials(env);
  const storageReady = await ensureSupportSchema(env);
  return jsonResponse(request, env, {
    enabled: Boolean(credentials.clientId && credentials.clientSecret && storageReady),
    amounts: SUPPORT_AMOUNTS,
    sdk_url: HUEVO_APPS_SDK,
    origins: ["huevo.su", "huevo.departament.site"],
  });
}

async function supportStats(request, env) {
  if (!env.DB) return jsonResponse(request, env, { supporters: 0, total: 0, enabled: false });
  try {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS supporters, COALESCE(SUM(amount), 0) AS total FROM support_payments WHERE status = 'succeeded' AND test = 0"
    ).first();
    return jsonResponse(request, env, {
      supporters: Number(row && row.supporters) || 0,
      total: Number(row && row.total) || 0,
      enabled: true,
    });
  } catch (_) {
    return jsonResponse(request, env, { supporters: 0, total: 0, enabled: false });
  }
}

async function callHuevoApps(env, method, path, body) {
  const credentials = supportCredentials(env);
  if (!credentials.clientId || !credentials.clientSecret) {
    return { status: 503, body: { error: { code: "support_not_configured" } } };
  }
  const headers = {
    "Authorization": "Basic " + btoa(credentials.clientId + ":" + credentials.clientSecret),
    "Accept": "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  try {
    const response = await fetch(HUEVO_APPS_API + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    try { data = await response.json(); } catch (_) {}
    return { status: response.status, body: data };
  } catch (_) {
    return { status: 502, body: { error: { code: "huevo_api_unavailable" } } };
  }
}

async function createSupportIntent(request, env) {
  const credentials = supportCredentials(env);
  if (!env.DB || !credentials.clientId || !credentials.clientSecret) {
    return jsonResponse(request, env, { ok: false, detail: "Поддержка автора пока не настроена." }, 503);
  }
  try {
    await env.DB.prepare("SELECT 1 FROM support_payments LIMIT 1").first();
  } catch (_) {
    return jsonResponse(request, env, { ok: false, detail: "Хранилище поддержки ещё не подготовлено; миграция не применена." }, 503);
  }
  const parsed = await readJsonBody(request, 10000);
  if (parsed.error) return jsonResponse(request, env, { ok: false, detail: parsed.error }, parsed.status);
  const payload = parsed.value;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return jsonResponse(request, env, { ok: false, detail: "Ожидается JSON-объект." }, 400);
  }
  const amount = payload.amount;
  if (!Number.isSafeInteger(amount) || amount < 5000 || amount > 100000) {
    return jsonResponse(request, env, { ok: false, detail: "Сумма должна быть целым числом от 5000 до 100000." }, 400);
  }
  const launch = await verifyHuevoLaunch(String(payload.launch_query || "").slice(0, 8192), credentials.clientSecret, 86400);
  if (!launch || !/^\d{1,20}$/.test(String(launch.hu_user_id || "")) || !Number.isSafeInteger(Number(launch.hu_user_id))) {
    return jsonResponse(request, env, { ok: false, detail: "Откройте AMNYAM MODE внутри huEVO: подпись запуска не подтверждена." }, 401);
  }
  const huUserId = String(launch.hu_user_id);
  const test = launch.hu_mode !== "live";
  const testFlag = test ? 1 : 0;

  // A pending intent is authoritative even when the browser's localStorage was
  // cleared or the request is repeated from another device. Reconcile it with
  // huEVO first; if the provider cannot be reached, keep the existing intent
  // instead of risking a second charge.
  let pending;
  try {
    pending = await env.DB.prepare(
      "SELECT intent_id, amount, test, status FROM support_payments " +
      "WHERE user_id = ? AND test = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1"
    ).bind(huUserId, testFlag).first();
  } catch (_) {
    return jsonResponse(request, env, { ok: false, detail: "Не удалось проверить существующий платёж. Повторную оплату пока не создавай." }, 503);
  }
  if (pending) {
    const remote = await callHuevoApps(env, "GET", "/payments/" + encodeURIComponent(String(pending.intent_id)));
    const remoteStatus = remote.body && String(remote.body.status || "");
    if (remote.status === 200 && SUPPORT_FINAL_STATUSES.has(remoteStatus)) {
      try {
        await env.DB.prepare(
          "UPDATE support_payments SET status = ?, error = ?, updated_at = ? WHERE intent_id = ? AND status = 'pending'"
        ).bind(
          remoteStatus,
          String(remote.body.error && (remote.body.error.message || remote.body.error.code) || "").slice(0, 500),
          new Date().toISOString(),
          String(pending.intent_id)
        ).run();
      } catch (_) {
        return jsonResponse(request, env, { ok: false, detail: "Не удалось обновить статус существующего платежа. Новый платёж не создан." }, 503);
      }
    } else {
      return jsonResponse(request, env, {
        ok: true,
        reused: true,
        status: "pending",
        intent_id: String(pending.intent_id),
        amount: Number(pending.amount),
        test: Boolean(pending.test),
      });
    }
  }

  // Derive the provider idempotency key from the latest stored intent and a
  // short time window. Concurrent requests from the same user therefore share
  // one key; after a completed intent is recorded, a later intentional payment
  // gets a new key.
  let previousIntentId = "first";
  try {
    const previous = await env.DB.prepare(
      "SELECT intent_id FROM support_payments WHERE user_id = ? AND test = ? ORDER BY created_at DESC LIMIT 1"
    ).bind(huUserId, testFlag).first();
    if (previous && previous.intent_id) previousIntentId = String(previous.intent_id);
  } catch (_) {
    return jsonResponse(request, env, { ok: false, detail: "Не удалось проверить историю платежей. Новый платёж не создан." }, 503);
  }
  const timeBucket = Math.floor(Date.now() / 60000);
  const idempotencyKey = "amnyam-" + (await sha256Hex(huUserId + "|" + testFlag + "|" + previousIntentId + "|" + timeBucket)).slice(0, 32);
  const response = await callHuevoApps(env, "POST", "/payments", {
    user_id: Number(huUserId),
    amount,
    description: "Поддержка автора AMNYAM MODE",
    idempotency_key: idempotencyKey,
    test,
  });
  if (response.status !== 200 || !response.body || !response.body.ok || !response.body.intent_id) {
    const error = response.body && response.body.error && response.body.error.code;
    return jsonResponse(request, env, { ok: false, detail: "huEVO не создал платёж (" + String(error || "нет ответа").slice(0, 80) + ")." }, 502);
  }
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO support_payments (intent_id, user_id, amount, test, status, created_at, updated_at, error) VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL)"
    ).bind(String(response.body.intent_id), huUserId, amount, testFlag, now, now).run();
  } catch (_) {
    return jsonResponse(request, env, { ok: false, detail: "Не удалось записать состояние платежа. Обратитесь к автору." }, 503);
  }
  return jsonResponse(request, env, { ok: true, intent_id: response.body.intent_id, amount, test });
}

async function getSupportPaymentStatus(request, env, intentId) {
  if (!/^pi_[A-Za-z0-9_-]{1,80}$/.test(intentId)) {
    return jsonResponse(request, env, { ok: false, detail: "Некорректный идентификатор платежа." }, 400);
  }
  if (!env.DB) return jsonResponse(request, env, { ok: false, detail: "Хранилище платежей пока не подключено." }, 503);
  let row;
  try {
    row = await env.DB.prepare(
      "SELECT intent_id, amount, test, status, created_at, updated_at FROM support_payments WHERE intent_id = ?"
    ).bind(intentId).first();
  } catch (_) {
    return jsonResponse(request, env, { ok: false, detail: "Хранилище платежей не готово." }, 503);
  }
  if (!row) return jsonResponse(request, env, { ok: false, detail: "Платёж не найден." }, 404);
  let status = String(row.status);
  const credentials = supportCredentials(env);
  if (status === "pending" && credentials.clientId && credentials.clientSecret) {
    const remote = await callHuevoApps(env, "GET", "/payments/" + encodeURIComponent(intentId));
    const remoteStatus = remote.body && remote.body.status;
    if (remote.status === 200 && SUPPORT_FINAL_STATUSES.has(remoteStatus)) {
      status = remoteStatus;
      await env.DB.prepare(
        "UPDATE support_payments SET status = ?, error = ?, updated_at = ? WHERE intent_id = ? AND status = 'pending'"
      ).bind(status, String(remote.body.error && (remote.body.error.message || remote.body.error.code) || "").slice(0, 500), new Date().toISOString(), intentId).run();
    }
  }
  return jsonResponse(request, env, { intent_id: intentId, amount: Number(row.amount), status, test: Boolean(row.test) });
}

async function supportCallback(request, env) {
  const credentials = supportCredentials(env);
  if (!env.DB || !credentials.clientSecret) {
    return jsonResponse(request, env, { ok: false, error: "not configured" }, 503);
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 20000) {
    return jsonResponse(request, env, { ok: false, error: "payload too large" }, 413);
  }
  const signature = String(request.headers.get("X-Huevo-Signature") || "").trim().toLowerCase();
  const expected = await supportHmac(credentials.clientSecret, raw);
  if (!signature || !constantTimeEqual(expected, signature)) {
    return jsonResponse(request, env, { ok: false, error: "bad signature" }, 401);
  }
  let data;
  try { data = JSON.parse(raw); } catch (_) {
    return jsonResponse(request, env, { ok: false, error: "bad payload" }, 400);
  }
  const intentId = String(data && data.intent_id || "");
  const status = String(data && data.status || "");
  if (!/^pi_[A-Za-z0-9_-]{1,80}$/.test(intentId) || !SUPPORT_FINAL_STATUSES.has(status)) {
    return jsonResponse(request, env, { ok: false, error: "bad payload" }, 400);
  }
  try {
    await env.DB.prepare(
      "UPDATE support_payments SET status = ?, error = ?, updated_at = ? WHERE intent_id = ? AND status = 'pending'"
    ).bind(status, String(data.error && (data.error.message || data.error.code) || "").slice(0, 500), new Date().toISOString(), intentId).run();
    return new Response(null, { status: 204, headers: responseHeaders(request, env) });
  } catch (_) {
    return jsonResponse(request, env, { ok: false, error: "storage unavailable" }, 503);
  }
}

function bridgePage(request, env) {
  // A same-origin transport page for the desktop bridge. Huevo's own CSP can block
  // cross-origin fetches, so the desktop app posts from this Worker origin instead.
  const headers = responseHeaders(request, env, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
  });
  headers.set(
    "Content-Security-Policy",
    "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  );
  return new Response(
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>Huevo Gift Bridge transport</title></head><body>Local Huevo Gift Bridge transport endpoint.</body></html>",
    { status: 200, headers }
  );
}

async function fetchHandler(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path.startsWith("/api/") && request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: responseHeaders(request, env) });
  }
  if (request.method === "GET" && path === "/api/bridge") return bridgePage(request, env);
  if (request.method === "POST" && path === "/api/auth/launch") return authenticateHuevoLaunch(request, env, jsonResponse);
  if (request.method === "GET" && path === "/api/me") return currentAccount(request, env, jsonResponse);
  if (request.method === "PUT" && path === "/api/me/profile") return saveAccountProfile(request, env, jsonResponse);
  if (request.method === "GET" && path === "/api/health") {
    return jsonResponse(request, env, { ok: true, ...(await getStorageHealth(env)) });
  }
  if (request.method === "GET" && path === "/api/push/config") return pushConfig(request, env);
  if (request.method === "GET" && path === "/api/push/status") return pushStatus(request, env);
  if (request.method === "POST" && path === "/api/push/subscribe") return savePushSubscription(request, env);
  if (request.method === "POST" && path === "/api/push/test") return pushTest(request, env);
  if (request.method === "POST" && path === "/api/push/unsubscribe") return removePushSubscriptions(request, env);
  if (request.method === "GET" && path === "/api/support/config") return supportConfig(request, env);
  if (request.method === "GET" && path === "/api/support/stats") return supportStats(request, env);
  if (request.method === "POST" && path === "/api/support/intent") return createSupportIntent(request, env);
  if (request.method === "POST" && path === "/api/support/callback") return supportCallback(request, env);
  const supportStatusMatch = path.match(new RegExp("^/api/support/status/(pi_[A-Za-z0-9_-]{1,80})$"));
  if (request.method === "GET" && supportStatusMatch) return getSupportPaymentStatus(request, env, supportStatusMatch[1]);
  if (request.method === "GET" && path === "/api/live/status") return liveStatus(request, env);
  if (request.method === "POST" && path === "/api/live/page") return ingestLivePage(request, env, ctx);
  if (request.method === "POST" && path === "/api/snapshot") return storeFullSnapshot(request, env, ctx);
  if (request.method === "GET" && path === "/data.json") return loadPublishedSnapshot(request, env);
  if (path.startsWith("/api/")) return jsonResponse(request, env, { ok: false, error: "not found" }, 404);
  if (!env.ASSETS) return jsonResponse(request, env, { ok: false, error: "static asset binding unavailable" }, 404);
  const response = await env.ASSETS.fetch(request);
  const headers = responseHeaders(request, env, Object.fromEntries(response.headers.entries()));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await fetchHandler(request, env, ctx);
    } catch (_) {
      return jsonResponse(request, env, { ok: false, error: "internal worker error" }, 500);
    }
  },
  async scheduled(controller, env, ctx) {
    if (!env.DB) return;
    const cutoff = new Date(Date.now() - retentionHours(env) * 3600_000).toISOString();
    ctx.waitUntil(Promise.all([
      env.DB.prepare("DELETE FROM live_price_history WHERE observed_at < ?").bind(cutoff).run().catch(() => undefined),
      purgeAuthRecords(env).catch(() => undefined)
    ]));
  },
};
