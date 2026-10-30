const SESSION_COOKIE = "amnyam_session";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const PASSWORD_ITERATIONS = 160000;
const MAX_PROFILE_BYTES = 200_000;

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
  const normal = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normal + "=".repeat((4 - normal.length % 4) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password, salt, iterations = PASSWORD_ITERATIONS) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(password)),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: decodeBase64(salt), iterations },
    material,
    256
  );
  return encodeBase64(new Uint8Array(derived));
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
    if (index < 0) continue;
    if (part.slice(0, index).trim() === SESSION_COOKIE) return part.slice(index + 1).trim();
  }
  return "";
}

function sessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

function expiredSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function sameOriginMutation(request) {
  const origin = request.headers.get("Origin");
  return Boolean(origin && origin === new URL(request.url).origin);
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

function normaliseUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function validUsername(value) {
  return /^[a-z0-9_.-]{3,24}$/.test(value);
}

function cleanString(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function validLotId(value) {
  return /^\d{1,20}$/.test(String(value));
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
      if (validLotId(id) && Number.isFinite(target) && target > 0 && target <= 1e15) {
        profile.targets[id] = Math.round(target);
      }
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
        const dir = Number(candidate.dir);
        return { key: candidate.key, dir: dir < 0 ? -1 : 1 };
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
    seasonTheme: ["default", "newyear", "halloween", "spring", "summer"].includes(preferences.seasonTheme)
      ? preferences.seasonTheme : "default"
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
    } catch (_) {
      // A damaged profile is replaced with safe defaults below.
    }
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
  const row = await env.DB.prepare(
    "SELECT a.user_id, a.username, a.display_name, a.created_at, s.expires_at " +
    "FROM user_sessions s JOIN user_accounts a ON a.user_id = s.user_id " +
    "WHERE s.session_hash = ? AND s.expires_at > ?"
  ).bind(sessionHash, nowIso()).first();
  return row || null;
}

function userView(row) {
  return {
    id: String(row.user_id),
    username: row.username,
    display_name: row.display_name,
    created_at: row.created_at
  };
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
  await env.DB.prepare(
    "UPDATE auth_rate_limits SET attempts = attempts + 1 WHERE rate_key = ?"
  ).bind(rateKey).run();
  return true;
}

function getClientKey(request) {
  return String(request.headers.get("CF-Connecting-IP") || "unknown").slice(0, 80);
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

export async function registerAccount(request, env, jsonResponse) {
  if (!sameOriginMutation(request)) return json(jsonResponse, request, env, { ok: false, error: "Недопустимый источник запроса." }, 403);
  if (!(await authSchemaReady(env))) return json(jsonResponse, request, env, { ok: false, error: "Хранилище профилей ещё не настроено. Повтори позже." }, 503);
  const clientKey = getClientKey(request);
  if (!(await checkRateLimit(env, "register:" + clientKey, 5, 60 * 60 * 1000))) {
    return json(jsonResponse, request, env, { ok: false, error: "Слишком много попыток регистрации. Попробуй позже." }, 429);
  }
  const parsed = await readBody(request);
  if (parsed.error) return json(jsonResponse, request, env, { ok: false, error: parsed.error }, parsed.status);
  const username = normaliseUsername(parsed.value.username);
  const password = String(parsed.value.password || "");
  const displayName = cleanString(parsed.value.display_name, 32) || username;
  if (!validUsername(username)) return json(jsonResponse, request, env, { ok: false, error: "Логин: 3–24 символа, латиница, цифры, точка, дефис или подчёркивание." }, 400);
  if (password.length < 12 || password.length > 128) return json(jsonResponse, request, env, { ok: false, error: "Пароль должен содержать от 12 до 128 символов." }, 400);
  if (displayName.length < 2) return json(jsonResponse, request, env, { ok: false, error: "Имя профиля должно содержать хотя бы 2 символа." }, 400);

  const salt = encodeBase64(secureRandom(16));
  const passwordHash = await hashPassword(password, salt);
  const userId = crypto.randomUUID();
  const createdAt = nowIso();
  const profile = sanitiseProfile(parsed.value.profile);
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO user_accounts (user_id, username, username_norm, display_name, password_hash, password_salt, password_iterations, created_at, updated_at, last_login_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(userId, username, username, displayName, passwordHash, salt, PASSWORD_ITERATIONS, createdAt, createdAt, createdAt),
      env.DB.prepare(
        "INSERT INTO user_profiles (user_id, profile_json, updated_at) VALUES (?, ?, ?)"
      ).bind(userId, JSON.stringify(profile), createdAt)
    ]);
  } catch (_) {
    return json(jsonResponse, request, env, { ok: false, error: "Такой логин уже занят или регистрация временно недоступна." }, 409);
  }
  const token = await makeSession(env, userId);
  return json(jsonResponse, request, env, {
    ok: true, authenticated: true,
    user: { id: userId, username, display_name: displayName, created_at: createdAt },
    profile, updated_at: createdAt
  }, 201, { "Set-Cookie": sessionCookie(token) });
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

export async function loginAccount(request, env, jsonResponse) {
  if (!sameOriginMutation(request)) return json(jsonResponse, request, env, { ok: false, error: "Недопустимый источник запроса." }, 403);
  if (!(await authSchemaReady(env))) return json(jsonResponse, request, env, { ok: false, error: "Хранилище профилей ещё не настроено. Повтори позже." }, 503);
  const parsed = await readBody(request);
  if (parsed.error) return json(jsonResponse, request, env, { ok: false, error: parsed.error }, parsed.status);
  const username = normaliseUsername(parsed.value.username);
  const password = String(parsed.value.password || "");
  if (!validUsername(username) || password.length > 128 || !password) {
    return json(jsonResponse, request, env, { ok: false, error: "Неверный логин или пароль." }, 401);
  }
  const clientKey = getClientKey(request);
  if (!(await checkRateLimit(env, "login:" + clientKey + ":" + username, 8, 15 * 60 * 1000))) {
    return json(jsonResponse, request, env, { ok: false, error: "Слишком много попыток входа. Подожди 15 минут." }, 429);
  }
  const row = await env.DB.prepare(
    "SELECT user_id, username, display_name, password_hash, password_salt, password_iterations, created_at " +
    "FROM user_accounts WHERE username_norm = ?"
  ).bind(username).first();
  const salt = row ? row.password_salt : encodeBase64(new Uint8Array(16));
  const expected = row ? row.password_hash : "";
  const iterations = row ? Number(row.password_iterations) : PASSWORD_ITERATIONS;
  const actual = await hashPassword(password, salt, iterations || PASSWORD_ITERATIONS);
  if (!row || actual !== expected) {
    return json(jsonResponse, request, env, { ok: false, error: "Неверный логин или пароль." }, 401);
  }

  const token = await makeSession(env, row.user_id);
  const now = nowIso();
  await env.DB.prepare("UPDATE user_accounts SET last_login_at = ? WHERE user_id = ?").bind(now, row.user_id).run();
  const stored = await profileForUser(env, row.user_id);
  return json(jsonResponse, request, env, {
    ok: true, authenticated: true, user: userView(row),
    profile: stored.profile, updated_at: stored.updated_at
  }, 200, { "Set-Cookie": sessionCookie(token) });
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
  if (!row) return json(jsonResponse, request, env, { ok: false, error: "Требуется вход в аккаунт." }, 401);
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

export async function logoutAccount(request, env, jsonResponse) {
  if (!sameOriginMutation(request)) return json(jsonResponse, request, env, { ok: false, error: "Недопустимый источник запроса." }, 403);
  const token = cookieValue(request);
  if (token && env.DB) {
    try {
      await env.DB.prepare("DELETE FROM user_sessions WHERE session_hash = ?").bind(await sha256Hex(token)).run();
    } catch (_) {}
  }
  return json(jsonResponse, request, env, { ok: true }, 200, { "Set-Cookie": expiredSessionCookie() });
}

export async function purgeAuthRecords(env) {
  if (!env.DB) return;
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user_sessions WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM auth_rate_limits WHERE window_started_at < ?").bind(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
  ]);
}
