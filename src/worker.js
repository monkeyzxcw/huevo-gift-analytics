import { authenticateHuevoLaunch, currentAccount, saveAccountProfile, purgeAuthRecords, isHuevoOwner } from "./auth.js";
import { verifyHuevoLaunch } from "./huevo_launch.js";

const HUEVO_HOSTS = new Set(["huevo.su", "huevo.departament.site"]);
const MAX_LIVE_BODY_BYTES = 256_000;
const MAX_SNAPSHOT_BODY_BYTES = 12_000_000;
const MAX_COMPRESSED_SNAPSHOT_BODY_BYTES = 1_400_000;
const MAX_STORED_SNAPSHOT_BYTES = 1_850_000;
const COMPRESSED_SNAPSHOT_PREFIX = "gzip64:";
const LIVE_FRESH_SECONDS = 15;
const LIVE_MERGE_SECONDS = 60 * 60;
const DEFAULT_RETENTION_HOURS = 72;
let publishedSnapshotCache = null;
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
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  const pagePath = new URL(request.url).pathname;
  const supportsHuEvoSdk = pagePath === "/" || pagePath === "/index.html";
  const csp = supportsHuEvoSdk
    ? `default-src 'none'; script-src 'self' https://huevo.su; style-src 'self'; img-src 'self' https://huevo.su https://*.huevo.su https://huevo.departament.site data:; connect-src 'self' https://huevo.su https://*.huevo.su; base-uri 'none'; form-action 'none'; frame-ancestors ${FRAME_ANCESTORS}`
    : `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${FRAME_ANCESTORS}`;
  headers.set("Content-Security-Policy", csp);
  const origin = corsOrigin(request, env);
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
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

async function decompressGzip(bytes, maxBytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("decompressed body too large");
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    const slice = bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length));
    for (let i = 0; i < slice.length; i++) binary += String.fromCharCode(slice[i]);
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function readJsonBody(request, limit) {
  const encoding = String(request.headers.get("Content-Encoding") || "").trim().toLowerCase();
  const declared = Number(request.headers.get("Content-Length") || 0);

  if (encoding === "gzip") {
    if (declared > MAX_COMPRESSED_SNAPSHOT_BODY_BYTES) {
      return { error: "compressed request body too large", status: 413 };
    }
    let compressedBytes;
    let decodedBytes;
    try {
      compressedBytes = new Uint8Array(await request.arrayBuffer());
      if (compressedBytes.byteLength > MAX_COMPRESSED_SNAPSHOT_BODY_BYTES) {
        return { error: "compressed request body too large", status: 413 };
      }
      decodedBytes = await decompressGzip(compressedBytes, limit);
    } catch (error) {
      const tooLarge = String(error && error.message || "").includes("too large");
      return { error: tooLarge ? "decompressed request body too large" : "invalid gzip request body", status: tooLarge ? 413 : 400 };
    }
    try {
      return { value: JSON.parse(new TextDecoder().decode(decodedBytes)), compressedBytes };
    } catch (_) {
      return { error: "expected valid JSON", status: 400 };
    }
  }

  if (encoding && encoding !== "identity") {
    return { error: "unsupported content encoding", status: 415 };
  }
  if (declared > limit) return { error: "request body too large", status: 413 };
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > limit) return { error: "request body too large", status: 413 };
  try {
    return { value: JSON.parse(raw) };
  } catch (_) {
    return { error: "expected valid JSON", status: 400 };
  }
}

async function parseStoredSnapshot(value) {
  const stored = String(value || "");
  if (!stored.startsWith(COMPRESSED_SNAPSHOT_PREFIX)) return JSON.parse(stored);
  const compressed = base64ToBytes(stored.slice(COMPRESSED_SNAPSHOT_PREFIX.length));
  const decoded = await decompressGzip(compressed, MAX_SNAPSHOT_BODY_BYTES);
  return JSON.parse(new TextDecoder().decode(decoded));
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
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('full_snapshot','live_page_state','live_price_history','user_accounts','user_sessions','user_profiles','auth_rate_limits','owner_presence')"
    ).all();
    const names = new Set((result.results || []).map((row) => row.name));
    return {
      storage_configured: true,
      schema_ready: names.has("full_snapshot") && names.has("live_page_state") && names.has("live_price_history"),
      support_schema_ready: supportSchemaReady,
      accounts_schema_ready: ["user_accounts", "user_sessions", "user_profiles", "auth_rate_limits"].every((name) => names.has(name)),
      presence_schema_ready: names.has("owner_presence"),
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
      const row = await env.DB.prepare("SELECT data_json, updated_at, generated_at FROM full_snapshot WHERE id = 1").first();
      if (row && row.data_json) {
        const cacheKey = String(row.updated_at || row.generated_at || row.data_json);
        let base = null;
        if (publishedSnapshotCache && publishedSnapshotCache.key === cacheKey) {
          base = publishedSnapshotCache.data;
        } else {
          base = await parseStoredSnapshot(row.data_json);
          publishedSnapshotCache = { key: cacheKey, data: base };
        }
        // Only the top level and lots array are mutated below. Keep the cached
        // immutable source snapshot intact for subsequent requests in this isolate.
        data = { ...base, lots: Array.isArray(base.lots) ? base.lots.slice() : [] };
      }
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
  // This endpoint is polled every three seconds by the browser. Keep it deliberately
  // lightweight: never run getStorageHealth(), which also checks/creates support schema.
  if (!env.DB) {
    return jsonResponse(request, env, {
      enabled: false, storage_configured: false, schema_ready: false,
      fresh: false, last_poll_at: null, item_count: 0, items: []
    });
  }
  let live = null;
  try {
    live = await getLiveState(env);
  } catch (_) {
    return jsonResponse(request, env, {
      enabled: true, storage_configured: true, schema_ready: false,
      fresh: false, last_poll_at: null, item_count: 0, items: []
    }, 503);
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
  let storedValue;
  try {
    if (parsed.compressedBytes) {
      storedValue = COMPRESSED_SNAPSHOT_PREFIX + bytesToBase64(parsed.compressedBytes);
    } else {
      storedValue = JSON.stringify(data);
    }
    const storedBytes = new TextEncoder().encode(storedValue).byteLength;
    if (storedBytes > MAX_STORED_SNAPSHOT_BYTES) {
      return jsonResponse(request, env, {
        ok: false,
        error: "snapshot is larger than the safe D1 row limit after compression",
        stored_bytes: storedBytes,
        max_stored_bytes: MAX_STORED_SNAPSHOT_BYTES,
      }, 413);
    }
    await env.DB.prepare(
      "INSERT INTO full_snapshot (id, data_json, generated_at, updated_at) VALUES (1, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json, generated_at=excluded.generated_at, updated_at=excluded.updated_at"
    ).bind(storedValue, data.generated_at, writtenAt).run();
  } catch (_) {
    return jsonResponse(request, env, { ok: false, error: "could not store snapshot; check D1 migrations" }, 503);
  }
  publishedSnapshotCache = { key: writtenAt, data };
  return jsonResponse(request, env, {
    ok: true, stored_at: writtenAt, generated_at: data.generated_at, lots: data.lots.length,
    compressed: storedValue.startsWith(COMPRESSED_SNAPSHOT_PREFIX),
    stored_bytes: new TextEncoder().encode(storedValue).byteLength,
    collector_status: data.collector && data.collector.status || "unknown",
  });
}


async function getOwnerPresence(request, env) {
  const canManage = await isHuevoOwner(request, env);
  if (!env.DB) return jsonResponse(request, env, {
    configured: false, available: false, can_manage: canManage, updated_at: null
  });
  try {
    const row = await env.DB.prepare(
      "SELECT is_available, updated_at FROM owner_presence WHERE id = 1"
    ).first();
    return jsonResponse(request, env, {
      configured: Boolean(row),
      available: Boolean(row && Number(row.is_available) === 1),
      can_manage: canManage,
      updated_at: row ? row.updated_at : null
    });
  } catch (_) {
    return jsonResponse(request, env, {
      configured: false, available: false, can_manage: canManage, updated_at: null
    }, 503);
  }
}

async function setOwnerPresence(request, env) {
  if (!isSameOriginMutation(request)) {
    return jsonResponse(request, env, { ok: false, error: "same-origin request required" }, 403);
  }
  if (!(await isHuevoOwner(request, env))) {
    return jsonResponse(request, env, { ok: false, error: "Изменять статус может только владелец приложения." }, 403);
  }
  if (!env.DB) return jsonResponse(request, env, { ok: false, error: "D1 storage unavailable" }, 503);
  const parsed = await readJsonBody(request, 4000);
  if (parsed.error) return jsonResponse(request, env, { ok: false, error: parsed.error }, parsed.status);
  if (typeof parsed.value.available !== "boolean") {
    return jsonResponse(request, env, { ok: false, error: "available must be a boolean" }, 400);
  }
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      "INSERT INTO owner_presence (id, is_available, updated_at, updated_by_hu_user_id) " +
      "VALUES (1, ?, ?, '14188') ON CONFLICT(id) DO UPDATE SET " +
      "is_available=excluded.is_available, updated_at=excluded.updated_at, " +
      "updated_by_hu_user_id=excluded.updated_by_hu_user_id"
    ).bind(parsed.value.available ? 1 : 0, now).run();
    return jsonResponse(request, env, {
      ok: true, configured: true, available: parsed.value.available,
      can_manage: true, updated_at: now
    });
  } catch (_) {
    return jsonResponse(request, env, { ok: false, error: "Не удалось сохранить статус владельца." }, 503);
  }
}

function isSameOriginMutation(request) {
  const origin = request.headers.get("Origin");
  return Boolean(origin && origin === new URL(request.url).origin);
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
  if (request.method === "GET" && path === "/api/contact/status") return getOwnerPresence(request, env);
  if (request.method === "PUT" && path === "/api/contact/status") return setOwnerPresence(request, env);
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
