import { verifyHuevoLaunch } from "./huevo_launch.js";

const SESSION_COOKIE = "amnyam_session";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_PROFILE_BYTES = 220_000;
const DEFAULT_PROFILE = {
  favorites: [],
  targets: {},
  alertedTargets: [],
  savedFilters: [],
  preferences: {
    alertSound: false,
    appearance: { background: "cosmic", mascot: "omnom", motion: "normal", glass: true },
    seasonTheme: "default"
  }
};

function nowIso() {
  return new Date().toISOString();
}

function encodeBase64(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function encodeBase64Url(bytes) {
  return encodeBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64(value) {
  const padded = String(value || "") + "=".repeat((4 - String(value || "").length % 4) % 4);
  return Uint8Array.from(atob(padded.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function secureRandom(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function cookieValue(request) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index >= 0 && part.slice(0, index).trim() === SESSION_COOKIE) return part.slice(index + 1).trim();
  }
  return "";
}

// huEVO runs the app in a cross-site iframe. SameSite=None is required;
// Partitioned lets browsers with third-party-cookie blocking keep an app-scoped session.
function sessionCookie(token) {
  return SESSION_COOKIE + "=" + token + "; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=" + SESSION_TTL_SECONDS;
}

function expiredSessionCookie() {
  return SESSION_COOKIE + "=; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=0";
}

function sameOriginMutation(request) {
  const origin = request.headers.get("Origin");
  return Boolean(origin && origin === new URL(request.url).origin);
}

function credentials(env) {
  // hu_app_id is the numeric huEVO application ID from signed launch params.
  // client_id is a separate Apps API credential and must never be compared to hu_app_id.
  const configuredAppId = String(env.HU_APP_ID || "").trim();
  return {
    appId: /^\\d{1,20}$/.test(configuredAppId) ? configuredAppId : "",
    clientSecret: String(env.HU_SECRET || env.HUEVO_CLIENT_SECRET || "").trim()
  };
}

async function authSchemaReady(env) {
  if (!env.DB) return false;
  try {
    const result = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('user_accounts','user_sessions','user_profiles','auth_rate_limits')"
    ).all();
    const names = new Set((result.results || []).map((row) => row.name));
    return ["user_accounts", "user_sessions", "user_profiles", "auth_rate_limits"].every((name) => names.has(name));
  } catch (_) {
    return false;
  }
}

function cleanString(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function validLotId(value) {
  return /^\d{1,20}$/.test(String(value));
}

function safeAvatarUrl(value) {
  const raw = cleanString(value, 2048);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const allowed = host === "huevo.su" || host.endsWith(".huevo.su") ||
      host === "huevo.departament.site" || host.endsWith(".huevo.departament.site");
    return url.protocol === "https:" && allowed ? url.href : "";
  } catch (_) {
    return "";
  }
}

export function sanitiseProfile(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const profile = {
    favorites: [],
    targets: {},
    alertedTargets: [],
    savedFilters: [],
    preferences: {
      alertSound: false,
      appearance: { ...DEFAULT_PROFILE.preferences.appearance },
      seasonTheme: "default"
    }
  };
  if (Array.isArray(raw.favorites)) {
    profile.favorites = [...new Set(raw.favorites.map(String).filter(validLotId))].slice(0, 5000);
  }
  if (raw.targets && typeof raw.targets === "object" && !Array.isArray(raw.targets)) {
    for (const [id, rawPrice] of Object.entries(raw.targets).slice(0, 5000)) {
      const target = Number(rawPrice);
      if (validLotId(id) && Number.isFinite(target) && target > 0 && target <= 1e15) profile.targets[id] = Math.round(target);
    }
  }
  if (Array.isArray(raw.alertedTargets)) {
    profile.alertedTargets = [...new Set(raw.alertedTargets.map(String).filter(validLotId))].slice(0, 5000);
  }
  const allowedSortKeys = new Set(["title", "price", "rarity", "delta", "first_seen", "lot_count", "lot_id", "count", "min", "median", "max"]);
  if (Array.isArray(raw.savedFilters)) {
    profile.savedFilters = raw.savedFilters.slice(0, 25).map((item) => {
      if (!item || typeof item !== "object" || !item.filters || typeof item.filters !== "object") return null;
      const f = item.filters;
      const sort = (candidate) => {
        if (!candidate || typeof candidate !== "object" || !allowedSortKeys.has(candidate.key)) return null;
        return { key: candidate.key, dir: Number(candidate.dir) < 0 ? -1 : 1 };
      };
      return {
        name: cleanString(item.name, 40),
        filters: {
          search: cleanString(f.search, 160),
          rarity: cleanString(f.rarity, 80),
          status: cleanString(f.status, 80),
          pmin: cleanString(f.pmin, 24),
          pmax: cleanString(f.pmax, 24),
          mode: f.mode === "gifts" ? "gifts" : "lots",
          sort: sort(f.sort),
          groupSort: sort(f.groupSort)
        }
      };
    }).filter((item) => item && item.name);
  }
  const preferences = raw.preferences && typeof raw.preferences === "object" ? raw.preferences : {};
  const appearance = preferences.appearance && typeof preferences.appearance === "object" ? preferences.appearance : {};
  profile.preferences = {
    alertSound: preferences.alertSound === true,
    appearance: {
      background: ["cosmic", "liquid", "nebula", "minimal"].includes(appearance.background) ? appearance.background : "cosmic",
      mascot: appearance.mascot === "none" ? "none" : "omnom",
      motion: ["normal", "subtle", "off"].includes(appearance.motion) ? appearance.motion : "normal",
      glass: appearance.glass !== false
    },
    seasonTheme: ["default", "newyear", "halloween", "spring", "summer"].includes(preferences.seasonTheme) ? preferences.seasonTheme : "default"
  };
  return profile;
}

async function profileForUser(env, userId) {
  const row = await env.DB.prepare(
    "SELECT profile_json, updated_at FROM user_profiles WHERE user_id = ?"
  ).bind(userId).first();
  if (row && row.profile_json) {
    try {
      return { profile: sanitiseProfile(JSON.parse(row.profile_json)), updated_at: row.updated_at };
    } catch (_) {}
  }
  const profile = sanitiseProfile(DEFAULT_PROFILE);
  const updatedAt = nowIso();
  await env.DB.prepare(
    "INSERT INTO user_profiles (user_id, profile_json, updated_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(user_id) DO UPDATE SET profile_json=excluded.profile_json, updated_at=excluded.updated_at"
  ).bind(userId, JSON.stringify(profile), updatedAt).run();
  return { profile, updated_at: updatedAt };
}

async function authenticatedUser(request, env) {
  const token = cookieValue(request);
  if (!token || !/^[A-Za-z0-9_-]{40,60}$/.test(token) || !env.DB) return null;
  const sessionHash = await sha256Hex(token);
  return env.DB.prepare(
    "SELECT a.user_id, a.hu_user_id, a.hu_username, a.display_name, a.avatar_url, a.app_id, a.mode, a.created_at, s.expires_at " +
    "FROM user_sessions s JOIN user_accounts a ON a.user_id = s.user_id " +
    "WHERE s.session_hash = ? AND s.expires_at > ?"
  ).bind(sessionHash, nowIso()).first();
}

function userView(row) {
  return {
    id: String(row.user_id),
    hu_user_id: String(row.hu_user_id),
    username: row.hu_username || "",
    display_name: row.display_name || row.hu_username || "Пользователь huEVO",
    avatar_url: row.avatar_url || "",
    mode: row.mode || "live",
    created_at: row.created_at
  };
}

async function makeSession(env, userId) {
  const token = encodeBase64Url(secureRandom(32));
  const tokenHash = await sha256Hex(token);
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  await env.DB.prepare(
    "INSERT INTO user_sessions (session_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(tokenHash, userId, createdAt, expiresAt, createdAt).run();
  return token;
}

function json(jsonResponse, request, env, body, status = 200, headers = {}) {
  return jsonResponse(request, env, body, status, headers);
}

async function readBody(request) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > MAX_PROFILE_BYTES) return { error: "Слишком большой запрос.", status: 413 };
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_PROFILE_BYTES) return { error: "Слишком большой запрос.", status: 413 };
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "Ожидался JSON-объект.", status: 400 };
    return { value };
  } catch (_) {
    return { error: "Некорректный JSON.", status: 400 };
  }
}

async function checkRateLimit(env, key, limit, windowMs) {
  const now = Date.now();
  const rateKey = await sha256Hex(key);
  const row = await env.DB.prepare(
    "SELECT attempts, window_started_at FROM auth_rate_limits WHERE rate_key = ?"
  ).bind(rateKey).first();
  const started = row ? Date.parse(row.window_started_at) : 0;
  if (!row || !Number.isFinite(started) || now - started >= windowMs) {
    await env.DB.prepare(
      "INSERT INTO auth_rate_limits (rate_key, attempts, window_started_at) VALUES (?, 1, ?) " +
      "ON CONFLICT(rate_key) DO UPDATE SET attempts=1, window_started_at=excluded.window_started_at"
    ).bind(rateKey, new Date(now).toISOString()).run();
    return true;
  }
  if (Number(row.attempts) >= limit) return false;
  await env.DB.prepare("UPDATE auth_rate_limits SET attempts = attempts + 1 WHERE rate_key = ?").bind(rateKey).run();
  return true;
}

function getClientKey(request) {
  return String(request.headers.get("CF-Connecting-IP") || "unknown").slice(0, 80);
}

export async function authenticateHuevoLaunch(request, env, jsonResponse) {
  if (!sameOriginMutation(request)) return json(jsonResponse, request, env, { ok: false, error: "Недопустимый источник запроса." }, 403);
  if (!(await authSchemaReady(env))) return json(jsonResponse, request, env, { ok: false, error: "Хранилище профилей ещё не настроено." }, 503);
  const configured = credentials(env);
  if (!configured.appId || !configured.clientSecret) {
    return json(jsonResponse, request, env, { ok: false, error: "Авторизация huEVO Apps не настроена на сервере." }, 503);
  }
  if (!(await checkRateLimit(env, "launch:" + getClientKey(request), 120, 15 * 60 * 1000))) {
    return json(jsonResponse, request, env, { ok: false, error: "Слишком много запусков. Попробуй позже." }, 429);
  }
  const parsed = await readBody(request);
  if (parsed.error) return json(jsonResponse, request, env, { ok: false, error: parsed.error }, parsed.status);
  const query = String(parsed.value.launch_query || "");
  const launch = await verifyHuevoLaunch(query, configured.clientSecret, 86400);
  if (!launch) return json(jsonResponse, request, env, { ok: false, error: "Подпись запуска huEVO недействительна или устарела. Открой приложение заново через huEVO." }, 401);
  const launchAppId = String(launch.hu_app_id || "");
  if (!/^\\d{1,20}$/.test(launchAppId)) {
    return json(jsonResponse, request, env, { ok: false, error: "В подписанном запуске huEVO отсутствует корректный hu_app_id." }, 401);
  }
  // The HMAC was verified with this app's client_secret above. Compare IDs only
  // when HU_APP_ID contains the actual numeric huEVO app ID. Older deployments
  // may have stored the alphanumeric Apps API client_id in HU_APP_ID; do not
  // compare that credential to hu_app_id.
  if (configured.appId && launchAppId !== configured.appId) {
    return json(jsonResponse, request, env, { ok: false, error: "Подпись принадлежит другому приложению huEVO." }, 401);
  }
  const huUserId = String(launch.hu_user_id || "");
  if (!/^\d{1,20}$/.test(huUserId)) {
    return json(jsonResponse, request, env, { ok: false, error: "В подписанном запуске не найден корректный hu_user_id." }, 401);
  }

  const username = cleanString(launch.hu_username, 128);
  const displayName = cleanString(launch.hu_display_name, 100) || username || "Пользователь huEVO";
  const avatarUrl = safeAvatarUrl(launch.hu_avatar);
  const mode = launch.hu_mode === "test" ? "test" : launch.hu_mode === "live" ? "live" : "";
  if (!mode) return json(jsonResponse, request, env, { ok: false, error: "Неизвестный режим запуска huEVO." }, 401);

  let userRow;
  try {
    userRow = await env.DB.prepare("SELECT user_id, hu_user_id FROM user_accounts WHERE hu_user_id = ?").bind(huUserId).first();
    if (!userRow) {
      const internalId = crypto.randomUUID();
      const createdAt = nowIso();
      const profile = sanitiseProfile(parsed.value.profile);
      try {
        await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO user_accounts (user_id, hu_user_id, hu_username, display_name, avatar_url, app_id, mode, created_at, updated_at, last_login_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
          ).bind(internalId, huUserId, username, displayName, avatarUrl, configured.appId, mode, createdAt, createdAt, createdAt),
          env.DB.prepare("INSERT INTO user_profiles (user_id, profile_json, updated_at) VALUES (?, ?, ?)").bind(internalId, JSON.stringify(profile), createdAt)
        ]);
        userRow = { user_id: internalId, hu_user_id: huUserId };
      } catch (_) {
        // A simultaneous first launch may have inserted the same hu_user_id.
        userRow = await env.DB.prepare("SELECT user_id, hu_user_id FROM user_accounts WHERE hu_user_id = ?").bind(huUserId).first();
        if (!userRow) throw new Error("account_insert_failed");
      }
    }
    const updatedAt = nowIso();
    await env.DB.prepare(
      "UPDATE user_accounts SET hu_username = ?, display_name = ?, avatar_url = ?, app_id = ?, mode = ?, updated_at = ?, last_login_at = ? WHERE user_id = ?"
    ).bind(username, displayName, avatarUrl, configured.appId, mode, updatedAt, updatedAt, userRow.user_id).run();

    const existing = await authenticatedUser(request, env);
    if (existing && (String(existing.hu_user_id) !== huUserId || String(existing.app_id) !== configured.appId) && cookieValue(request)) {
      await env.DB.prepare("DELETE FROM user_sessions WHERE session_hash = ?").bind(await sha256Hex(cookieValue(request))).run();
    }
    let token = cookieValue(request);
    let setCookie = {};
    if (!existing || String(existing.hu_user_id) !== huUserId || String(existing.app_id) !== configured.appId) {
      token = await makeSession(env, userRow.user_id);
      setCookie = { "Set-Cookie": sessionCookie(token) };
    } else {
      const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
      await env.DB.prepare("UPDATE user_sessions SET expires_at = ?, last_seen_at = ? WHERE session_hash = ?")
        .bind(expiresAt, updatedAt, await sha256Hex(token)).run();
      setCookie = { "Set-Cookie": sessionCookie(token) };
    }

    const stored = await profileForUser(env, userRow.user_id);
    const fullRow = await env.DB.prepare(
      "SELECT user_id, hu_user_id, hu_username, display_name, avatar_url, app_id, mode, created_at FROM user_accounts WHERE user_id = ?"
    ).bind(userRow.user_id).first();
    return json(jsonResponse, request, env, {
      ok: true, authenticated: true, user: userView(fullRow),
      profile: stored.profile, updated_at: stored.updated_at
    }, 200, setCookie);
  } catch (_) {
    return json(jsonResponse, request, env, { ok: false, error: "Не удалось создать профиль huEVO. Попробуй открыть приложение ещё раз." }, 503);
  }
}

export async function currentAccount(request, env, jsonResponse) {
  if (!(await authSchemaReady(env))) return json(jsonResponse, request, env, {
    ok: true, authenticated: false, profiles_ready: false, user: null, profile: sanitiseProfile(DEFAULT_PROFILE), updated_at: null
  });
  try {
    const row = await authenticatedUser(request, env);
    if (!row) return json(jsonResponse, request, env, {
      ok: true, authenticated: false, profiles_ready: true, user: null, profile: sanitiseProfile(DEFAULT_PROFILE), updated_at: null
    });
    const stored = await profileForUser(env, row.user_id);
    return json(jsonResponse, request, env, {
      ok: true, authenticated: true, profiles_ready: true,
      user: userView(row), profile: stored.profile, updated_at: stored.updated_at
    });
  } catch (_) {
    return json(jsonResponse, request, env, { ok: false, error: "Не удалось загрузить профиль." }, 503);
  }
}

export async function saveAccountProfile(request, env, jsonResponse) {
  if (!sameOriginMutation(request)) return json(jsonResponse, request, env, { ok: false, error: "Недопустимый источник запроса." }, 403);
  if (!(await authSchemaReady(env))) return json(jsonResponse, request, env, { ok: false, error: "Хранилище профилей не настроено." }, 503);
  let row;
  try {
    row = await authenticatedUser(request, env);
  } catch (_) {
    return json(jsonResponse, request, env, { ok: false, error: "Сессия недоступна." }, 503);
  }
  if (!row) return json(jsonResponse, request, env, { ok: false, error: "Сеанс huEVO истёк. Открой приложение внутри huEVO снова." }, 401);
  const parsed = await readBody(request);
  if (parsed.error) return json(jsonResponse, request, env, { ok: false, error: parsed.error }, parsed.status);
  const profile = sanitiseProfile(parsed.value.profile);
  const updatedAt = nowIso();
  try {
    await env.DB.prepare(
      "INSERT INTO user_profiles (user_id, profile_json, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(user_id) DO UPDATE SET profile_json=excluded.profile_json, updated_at=excluded.updated_at"
    ).bind(row.user_id, JSON.stringify(profile), updatedAt).run();
    return json(jsonResponse, request, env, { ok: true, profile, updated_at: updatedAt });
  } catch (_) {
    return json(jsonResponse, request, env, { ok: false, error: "Не удалось сохранить профиль." }, 503);
  }
}


export async function purgeAuthRecords(env) {
  if (!env.DB) return;
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user_sessions WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM auth_rate_limits WHERE window_started_at < ?").bind(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
  ]);
}
