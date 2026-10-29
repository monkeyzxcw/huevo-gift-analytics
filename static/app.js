(() => {
"use strict";
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const num = v => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v))) ? null : Number(v);
const fmt = v => num(v) === null ? "—" : Number(v).toLocaleString("ru-RU", {maximumFractionDigits: 1});
const coin = v => num(v) === null ? "—" : fmt(v) + " ◉";
const pct = v => num(v) === null ? "Недостаточно данных" : (v > 0 ? "+" : "") + fmt(v) + "%";
const dt = s => s ? String(s).replace("T", " ").slice(0, 16) + " UTC" : "—";
const ago = s => { if (!s) return ""; const m = Math.round((Date.now() - new Date(s)) / 60000); return m < 1 ? "только что" : m < 60 ? m + " мин назад" : m < 2880 ? Math.round(m / 60) + " ч назад" : Math.round(m / 1440) + " дн назад"; };
const safeHttps = u => /^https:\/\//i.test(u || "") ? u : "";
const lotUrl = x => safeHttps(x.lot_url) || ("https://huevo.su/market/lot/" + encodeURIComponent(x.lot_id));
const pic = x => safeHttps(x.image_url) ? `<img loading="lazy" referrerpolicy="no-referrer" alt="" src="${esc(x.image_url)}">` : "🎁";
const ext = (url, label) => `<a class="btn mini" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;

async function api(path, options = {}, timeoutMs = 20000) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(path, {...options, signal: ctl.signal});
    let data = {};
    try { data = await r.json(); } catch (_) {}
    if (!r.ok) {
      const retry = r.headers.get("retry-after");
      throw new Error((typeof data.detail === "string" ? data.detail : "HTTP " + r.status) + (retry && r.status === 429 ? ` (повторить через ${Math.ceil(retry / 60)} мин)` : ""));
    }
    return data;
  } catch (e) {
    throw new Error(e.name === "AbortError" ? `Сервер не ответил за ${Math.round(timeoutMs / 1000)} секунд` : e.message);
  } finally { clearTimeout(timer); }
}
async function busy(btn, fn) {
  if (btn.disabled) return;
  btn.disabled = true; btn.setAttribute("aria-busy", "true");
  try { return await fn(); } finally { btn.disabled = false; btn.removeAttribute("aria-busy"); }
}
const kv = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
};
let favs = kv.get("huevo.favs", {});
if (!favs || typeof favs !== "object" || Array.isArray(favs)) favs = {};
let adminToken = "";
const banner = (msg, kind) => { const b = $("banner"); b.hidden = !msg; b.textContent = msg || ""; b.className = "banner" + (kind ? " " + kind : ""); };
const emptyBox = (text, retryId) => `<div class="empty">${esc(text)}${retryId ? `<div><button class="btn mini" data-retry="${retryId}" type="button">Повторить</button></div>` : ""}</div>`;

// broken images -> placeholder (inline onerror is blocked by CSP)
document.addEventListener("error", e => {
  if (e.target && e.target.tagName === "IMG") e.target.replaceWith(document.createTextNode("🎁"));
}, true);
document.addEventListener("click", e => {
  const r = e.target.closest("[data-retry]");
  if (r) ({overview: loadOverview, catalog: loadCatalog, deals: loadDeals, analytics: loadAnalytics, favorites: renderFavs}[r.dataset.retry] || (() => {}))();
});

// ---- tabs (roving tabindex + arrows)
const TABS = ["overview", "catalog", "deals", "analytics", "favorites", "collector", "support"];
const loaded = new Set();
function showTab(name, focus) {
  if (!TABS.includes(name)) name = "overview";
  TABS.forEach(t => { $("tab-" + t).hidden = t !== name; const b = $("t-" + t); b.setAttribute("aria-selected", t === name); b.tabIndex = t === name ? 0 : -1; });
  if (location.hash.slice(1) !== name) history.replaceState(null, "", location.search + "#" + name);
  if (focus) $("t-" + name).focus();
  try { $("t-" + name).scrollIntoView({inline: "center", block: "nearest"}); } catch (_) {}
  ({catalog: () => loaded.has("catalog") || loadCatalog(), deals: loadDeals, analytics: loadAnalytics, favorites: renderFavs, collector: renderStatus}[name] || (() => {}))();
}
$("tabs").addEventListener("click", e => { const b = e.target.closest("[data-tab]"); if (b) showTab(b.dataset.tab); });
$("tabs").addEventListener("keydown", e => {
  const i = TABS.indexOf(document.activeElement.dataset.tab); if (i < 0) return;
  const j = e.key === "ArrowRight" ? (i + 1) % TABS.length : e.key === "ArrowLeft" ? (i + TABS.length - 1) % TABS.length : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : -1;
  if (j >= 0) { e.preventDefault(); showTab(TABS[j], true); }
});
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));
document.addEventListener("keydown", e => {
  if (e.key === "/" && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); showTab("catalog"); $("q").focus(); }
});

// ---- admin token (memory only)
function askToken() {
  return new Promise(resolve => {
    if (adminToken) return resolve(adminToken);
    const d = $("tokenDialog"), i = $("tokenInput"); i.value = "";
    d.addEventListener("close", () => { if (d.returnValue === "ok" && i.value.trim()) adminToken = i.value.trim(); i.value = ""; resolve(adminToken); }, {once: true});
    d.showModal(); i.focus();
  });
}
async function authed(path, timeoutMs = 20000) {
  const t = await askToken();
  if (!t) throw new Error("Токен не введён");
  try { return await api(path, {method: "POST", headers: {Authorization: "Bearer " + t}}, timeoutMs); }
  catch (e) { if (/токен/i.test(e.message)) adminToken = ""; throw e; }
}

// ---- charts (no inline styles; colors via CSS variables)
function lineChart(svgId, points) {
  const el = $(svgId);
  if (points.length < 2) { el.innerHTML = '<text x="350" y="100" text-anchor="middle">Недостаточно данных для графика</text>'; return; }
  const W = 700, H = 200, P = 30;
  const ys = points.map(p => p.y), lo = Math.min(...ys), hi = Math.max(...ys), span = (hi - lo) || Math.max(1, Math.abs(hi) * .05);
  const xy = points.map((p, i) => [P + i * (W - 2 * P) / (points.length - 1), H - P - (p.y - lo) / span * (H - 2 * P)]);
  const line = xy.map(a => a[0].toFixed(1) + "," + a[1].toFixed(1)).join(" ");
  const dots = xy.map((a, i) => `<circle cx="${a[0].toFixed(1)}" cy="${a[1].toFixed(1)}" r="3.5" fill="var(--accent2)"><title>${esc(points[i].label)} · ${esc(fmt(points[i].y))}</title></circle>`).join("");
  el.innerHTML = `<line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" stroke="var(--line)"/>
    <text x="2" y="${P}">${esc(fmt(hi))}</text><text x="2" y="${H - P}">${esc(fmt(lo))}</text>
    <text x="${P}" y="${H - 8}">${esc(points[0].label)}</text><text x="${W - P}" y="${H - 8}" text-anchor="end">${esc(points[points.length - 1].label)}</text>
    <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>${dots}`;
}
function bars(el, entries, empty) {
  const max = Math.max(1, ...entries.map(e => e[1]));
  el.innerHTML = entries.length ? entries.map(([n, c]) => `<div class="bar"><span title="${esc(n)}">${esc(n)}</span><div class="track"><div class="fill" data-w="${Math.round(c / max * 100)}"></div></div><b>${esc(fmt(c))}</b></div>`).join("") : emptyBox(empty || "Нет данных");
  el.querySelectorAll(".fill").forEach(f => { f.style.width = f.dataset.w + "%"; });
}
async function trend() {
  const days = $("trendDays").value;
  try {
    const s = await api("/api/analytics/snapshots?days=" + days);
    const byDay = new Map();
    (s.points || []).forEach(p => { if (p.median_price != null) byDay.set(String(p.observed_at).slice(0, 10), p.median_price); });
    const pts = [...byDay.entries()].map(([d, y]) => ({label: d.slice(5), y}));
    lineChart("trend", pts); lineChart("trend2", pts);
    const note = pts.length >= 2 ? `Медиана цен активных предложений по полным проходам сбора (${pts.length} дн.). Не цены сделок.` : "Нужно минимум два полных прохода сбора в разные дни: пока показывать нечего.";
    $("trendNote").textContent = note; $("trend2Note").textContent = note;
  } catch (e) { $("trendNote").textContent = "Не удалось загрузить историю: " + e.message; }
}
$("trendDays").addEventListener("change", trend);

// ---- status pill / collector
let statusCache = null, diagCache = null;
async function renderStatus() {
  try {
    const [s, d] = await Promise.all([api("/api/status"), api("/api/diagnostics")]);
    statusCache = s; diagCache = d;
    const last = [s.last_ingest_at, s.last_crawl_at].filter(Boolean).sort().pop();
    const source = !last ? "" : (last === s.last_ingest_at ? "браузерный сбор" : "серверный сбор");
    let cls = "dot", text = "Сервер доступен";
    if (s.running) { cls += " live"; text = "Сбор идёт…"; }
    else if (s.blocked_until) { cls += " warn"; text = "Пауза: Huevo ограничил доступ"; }
    else if (s.last_crawl_status && !["ok", null].includes(s.last_crawl_status) && last === s.last_crawl_at) { cls += " error"; text = "Последний сбор не удался"; }
    else if (last) { cls += " live"; text = "Данные получены"; }
    $("dot").className = cls; $("statusText").textContent = text;
    $("freshness").textContent = last ? `· ${ago(last)} (${source})` : "";
    const p = d.persistence || {};
    $("statusBox").textContent = [s.message || "—", `Лотов в базе: ${d.lots_in_database} (активных ${d.active_lots})`, `Записей истории: ${d.price_history_rows} · снимков рынка: ${d.snapshots}`,
      "Токен импорта: " + (d.ingest_token_configured ? "настроен" : "НЕ настроен"), "Серверная сессия Huevo: " + (d.huevo_cookies_configured ? "задана" : "не задана"),
      s.last_ingest_at ? "Последний браузерный импорт: " + dt(s.last_ingest_at) : "Браузерных импортов ещё не было",
      s.last_crawl_at ? "Последний успешный серверный сбор: " + dt(s.last_crawl_at) : "", s.last_http_status ? "Последний статус блокировки: HTTP " + s.last_http_status : "",
      s.blocked_until ? "Пауза после ограничения до: " + dt(s.blocked_until) : "", p.ephemeral_warning ? "⚠ " + p.message : ""].filter(Boolean).join("\n");
    if (s.running) banner(`${s.message} · страница ${s.page}, найдено ${s.found}`);
    else if (s.blocked_until) banner(`Huevo ограничил доступ${s.last_http_status ? " (HTTP " + s.last_http_status + ")" : ""}. Запросы приостановлены до ${dt(s.blocked_until)} — это ограничение стороны Huevo, защита не обходится.`, "warn");
    else if (p.ephemeral_warning) banner(p.message, "warn");
    else banner("");
  } catch (e) { $("dot").className = "dot error"; $("statusText").textContent = "API недоступен"; banner("Не удалось связаться с API: " + e.message, "error"); }
}
$("refreshBtn").addEventListener("click", e => busy(e.currentTarget, async () => {
  try { const r = await authed("/api/crawl"); banner(r.message, "good"); await renderStatus(); }
  catch (err) { banner("Не удалось запустить сбор: " + err.message, "error"); }
}));
$("diagnostics").addEventListener("click", e => busy(e.currentTarget, renderStatus));
$("probeHuevo").addEventListener("click", e => busy(e.currentTarget, async () => {
  const p = $("diagBox"); p.hidden = false; p.textContent = "Проверяем…";
  try {
    const r = await authed("/api/diagnose-huevo", 90000);
    p.textContent = ["Проверка доступа к Huevo (" + r.base_url + ")", "Cookies на сервере: " + (r.cookies_configured ? "заданы" : "не заданы")]
      .concat((r.steps || []).map(x => `• ${x.step}: ${x.verdict}${x.http_status ? " · HTTP " + x.http_status + (x.status_source === "network" ? " (сеть)" : " (по тексту страницы)") : ""}${x.retry_after ? " · Retry-After " + x.retry_after + " с" : ""}${x.cards != null ? " · карточек: " + x.cards : ""}\n   ${x.hint || ""}`))
      .concat(r.error ? ["Ошибка: " + r.error] : []).join("\n");
    renderStatus();
  } catch (err) { p.textContent = "Проверка не выполнена: " + err.message; }
}));

// ---- overview
function spot(x, extra) {
  return `<div class="pic">${pic(x)}</div><div class="spot-info"><div class="t">${esc(x.title || "Без названия")}</div><div class="p">${coin(x.price)}</div><div class="m">#${esc(x.lot_id)} · ${esc(x.serial || "серия не указана")} · ${esc(x.rarity || "редкость не указана")}</div>${extra || ""}<div class="row">${ext(lotUrl(x), "Открыть лот ↗")}</div></div>`;
}
const noData = 'Пока нет данных. Загрузите лоты сборщиком (вкладка «Сборщик»).';
async function loadOverview() {
  const [h, a, d] = await Promise.allSettled([api("/api/highlights"), api("/api/analytics/summary"), api("/api/drops?limit=6")]);
  const body = (id) => $(id).querySelector(".spot-body");
  if (h.status === "fulfilled") {
    const v = h.value;
    body("spotLatest").innerHTML = v.latest ? spot(v.latest, `<div class="m">Замечен сборщиком: ${esc(dt(v.latest.first_seen))} (${esc(ago(v.latest.first_seen))})</div>`) : emptyBox(noData);
    $("latestNote").textContent = v.latest_note || "";
    const b = v.best;
    body("spotBest").innerHTML = b ? spot(b, `<div class="row"><span class="chip good">−${esc(b.discount_pct)}% к эталону</span><span class="chip">эталон ${esc(coin(b.reference))}</span>${b.suspicious ? '<span class="chip warn">возможна ошибка в цене</span>' : ""}</div><div class="m">Основа: ${b.basis === "gone" ? `${b.sample_size} ушедших с рынка лотов (вероятно проданы или сняты)` : `${b.sample_size} активных предложений`}</div>`)
      : emptyBox(v.data_state === "empty" ? noData : "Недостаточно данных: нужно минимум 3 сопоставимых лота (то же название и редкость).");
    $("bestNote").textContent = v.best_note || "";
  } else {
    document.querySelectorAll(".spot-body").forEach(n => n.innerHTML = emptyBox("Не удалось загрузить: " + h.reason.message, "overview"));
  }
  if (a.status === "fulfilled") {
    const s = a.value.summary, ch = a.value.changes || [];
    $("kCount").textContent = fmt(a.value.active_total); $("kCountSub").textContent = s.priced ? `с ценой: ${fmt(s.priced)}` : "цены не получены";
    $("kMedian").textContent = coin(s.median); $("kMin").textContent = coin(s.min); $("kMax").textContent = coin(s.max);
    const c7 = ch.find(c => c.days === 7);
    $("kMedianSub").textContent = c7 && c7.change_pct != null ? `за 7 дн.: ${pct(c7.change_pct)}` : "изменение: недостаточно данных";
  }
  $("drops").innerHTML = d.status === "fulfilled" ? (d.value.length ? d.value.map(x => `<a class="li" href="${esc(lotUrl(x))}" target="_blank" rel="noopener noreferrer"><span><b>${esc(x.title || "#" + x.lot_id)}</b><br><span class="muted">${esc(coin(x.previous_price))} → ${esc(coin(x.price))}</span></span><span class="chip good">−${esc(x.drop_pct)}%</span></a>`).join("") : emptyBox("Снижений цен пока не зафиксировано: нужны минимум два прохода сбора."))
    : emptyBox("Не удалось загрузить: " + d.reason.message, "overview");
  await trend();
}

// ---- catalog (server-side pagination and filters)
const PAGE = 24;
let cat = {offset: 0, total: 0}, catSeq = 0;
const isFav = id => Object.prototype.hasOwnProperty.call(favs, id);
function catParams(extra = {}) {
  const p = new URLSearchParams({sort: $("sort").value, limit: PAGE, offset: cat.offset, ...extra});
  [["q", "q"], ["status", "statusFilter"], ["rarity", "rarityFilter"], ["min_price", "minPrice"], ["max_price", "maxPrice"]].forEach(([k, id]) => { const v = $(id).value.trim(); if (v !== "") p.set(k, v); });
  return p;
}
function lotRow(x) {
  return `<div class="lot"><button class="star" type="button" data-star="${esc(x.lot_id)}" data-price="${esc(x.price ?? "")}" aria-pressed="${isFav(x.lot_id)}" aria-label="Избранное">★</button>
    <div class="thumb">${pic(x)}</div><div><div class="name">${esc(x.title || "Без названия")}</div><div class="m">#${esc(x.lot_id)} · ${esc(x.serial || "серия не указана")} · ${esc(x.rarity || "редкость не указана")} · ${esc(ago(x.last_seen))}</div></div>
    <div class="price">${coin(x.price)}<br><span class="chip">${esc(x.status || "Неизвестно")}</span></div>
    <div class="acts"><button class="btn mini" type="button" data-hist="${esc(x.lot_id)}">График</button>${ext(lotUrl(x), "Открыть ↗")}<button class="btn mini" type="button" data-copy="${esc(lotUrl(x))}">Копировать</button></div></div>`;
}
async function loadCatalog() {
  const seq = ++catSeq, box = $("lots");
  box.setAttribute("aria-busy", "true");
  if (!loaded.has("catalog")) box.innerHTML = '<div class="skeleton"></div>';
  try {
    const r = await api("/api/catalog?" + catParams());
    if (seq !== catSeq) return;
    loaded.add("catalog");
    cat.total = r.total;
    if (cat.offset >= r.total && r.total > 0) { cat.offset = Math.max(0, Math.floor((r.total - 1) / PAGE) * PAGE); return loadCatalog(); }
    box.innerHTML = r.items.length ? r.items.map(lotRow).join("") : emptyBox(r.total === 0 && !hasFilters() ? noData : "Лоты не найдены. Измените фильтры.");
    $("rowsCount").textContent = r.total ? `Показано ${cat.offset + 1}–${cat.offset + r.items.length} из ${r.total.toLocaleString("ru-RU")}` : "Нет лотов";
    $("pageInfo").textContent = r.total ? `стр. ${Math.floor(cat.offset / PAGE) + 1} из ${Math.ceil(r.total / PAGE)}` : "";
    $("prevPage").disabled = cat.offset <= 0; $("nextPage").disabled = cat.offset + PAGE >= r.total;
  } catch (e) {
    if (seq !== catSeq) return;
    box.innerHTML = emptyBox("Не удалось загрузить каталог: " + e.message, "catalog");
  } finally { if (seq === catSeq) box.setAttribute("aria-busy", "false"); }
}
const hasFilters = () => ["q", "statusFilter", "rarityFilter", "minPrice", "maxPrice"].some(id => $(id).value.trim() !== "");
async function loadFacets() {
  try {
    const f = await api("/api/facets");
    [["statusFilter", f.statuses, "Все статусы"], ["rarityFilter", f.rarities, "Любая редкость"]].forEach(([id, vals, all]) => {
      const el = $(id), cur = el.value;
      el.innerHTML = `<option value="">${all}</option>` + vals.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
      el.value = vals.includes(cur) ? cur : "";
    });
  } catch (_) { /* filters stay usable without facets */ }
}
let debounce;
const refilter = () => { cat.offset = 0; loadCatalog(); };
$("q").addEventListener("input", () => { clearTimeout(debounce); debounce = setTimeout(refilter, 300); });
["sort", "statusFilter", "rarityFilter", "minPrice", "maxPrice"].forEach(id => $(id).addEventListener("change", refilter));
$("filters").addEventListener("submit", e => { e.preventDefault(); refilter(); });
$("prevPage").addEventListener("click", () => { cat.offset = Math.max(0, cat.offset - PAGE); loadCatalog(); });
$("nextPage").addEventListener("click", () => { cat.offset += PAGE; loadCatalog(); });
$("resetFilters").addEventListener("click", () => { ["q", "statusFilter", "rarityFilter", "minPrice", "maxPrice"].forEach(id => $(id).value = ""); refilter(); });
$("exportCsv").addEventListener("click", e => busy(e.currentTarget, async () => {
  try {
    const rows = [];
    for (let off = 0; off < 1000; off += 200) {
      const r = await api("/api/catalog?" + catParams({limit: 200, offset: off}));
      rows.push(...r.items); if (rows.length >= r.total) break;
    }
    if (!rows.length) return banner("Нет данных для экспорта.", "error");
    const head = ["lot_id", "title", "serial", "rarity", "price", "status", "first_seen", "last_seen", "lot_url"];
    const q = v => { let s = String(v ?? ""); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };   // neutralize spreadsheet formulas
    const blob = new Blob(["﻿" + [head, ...rows.map(x => head.map(k => x[k] ?? ""))].map(r => r.map(q).join(";")).join("\r\n")], {type: "text/csv;charset=utf-8"});
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "huevo-gifts-" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    banner(`Экспортировано строк: ${rows.length}${rows.length >= 1000 ? " (лимит 1000)" : ""}`, "good");
  } catch (err) { banner("Экспорт не удался: " + err.message, "error"); }
}));
document.addEventListener("click", async e => {
  const star = e.target.closest("[data-star]"), hist = e.target.closest("[data-hist]"), cp = e.target.closest("[data-copy]"), un = e.target.closest("[data-unstar]");
  if (star) {
    const id = star.dataset.star;
    if (isFav(id)) delete favs[id]; else favs[id] = num(star.dataset.price);
    kv.set("huevo.favs", favs); star.setAttribute("aria-pressed", isFav(id));
  }
  if (un) { delete favs[un.dataset.unstar]; kv.set("huevo.favs", favs); renderFavs(); }
  if (hist) openHistory(hist.dataset.hist);
  if (cp) { try { await navigator.clipboard.writeText(cp.dataset.copy); cp.textContent = "Скопировано"; } catch (_) { cp.textContent = "Не удалось"; } setTimeout(() => { cp.textContent = "Копировать"; }, 1500); }
});
async function openHistory(id) {
  $("histTitle").textContent = "Лот #" + id; $("histNote").textContent = "Загрузка…"; $("histChart").innerHTML = "";
  $("histDialog").showModal();
  try {
    const h = await api("/api/history/" + encodeURIComponent(id));
    const pts = h.filter(r => num(r.price) !== null).map(r => ({label: String(r.observed_at).slice(5, 10), y: Number(r.price)}));
    lineChart("histChart", pts);
    $("histNote").textContent = pts.length < 2 ? "Цена пока не менялась: сохранено значений — " + pts.length : pts.length + " сохранённых значений (записываются при изменении цены).";
  } catch (e) { $("histNote").textContent = e.message; }
}
$("histClose").addEventListener("click", () => $("histDialog").close());

// ---- deals / favorites / analytics
async function loadDeals() {
  const box = $("deals"); if (!loaded.has("deals")) box.innerHTML = '<div class="skeleton"></div>';
  try {
    const r = await api("/api/deals?limit=30"); loaded.add("deals");
    $("dealsNote").textContent = r.note + " Метод: " + r.method + ".";
    box.innerHTML = r.deals.length ? r.deals.map(d => `<a class="gcard" href="${esc(lotUrl(d))}" target="_blank" rel="noopener noreferrer"><span class="chip ${d.suspicious ? "warn" : "good"} badge">−${esc(d.discount_pct)}%</span><div class="t">${esc(d.title || "#" + d.lot_id)}</div><div class="p">${coin(d.price)}</div><div class="m">медиана ${esc(coin(d.median))} · выборка ${esc(d.group_size)} · #${esc(d.lot_id)}${d.suspicious ? " · возможна ошибка в цене" : ""}</div></a>`).join("")
      : emptyBox("Недостаточно данных: нужны группы минимум из 3 предложений с заметной разницей в цене.");
  } catch (e) { box.innerHTML = emptyBox("Не удалось загрузить: " + e.message, "deals"); }
}
async function renderFavs() {
  const ids = Object.keys(favs).slice(0, 100), box = $("favs");
  if (!ids.length) { box.innerHTML = emptyBox("Пока пусто. Нажмите ★ рядом с лотом в каталоге."); return; }
  try {
    const items = (await api("/api/lots/by-ids?ids=" + ids.join(","))).items, byId = new Map(items.map(x => [x.lot_id, x]));
    box.innerHTML = ids.map(id => {
      const x = byId.get(id);
      if (!x) return `<div class="gcard"><div class="t">#${esc(id)}</div><div class="m">Лота нет в базе: ещё не загружен.</div><div class="row"><button class="btn mini" type="button" data-unstar="${esc(id)}">Убрать</button></div></div>`;
      const was = num(favs[id]), now = num(x.price), delta = was && now !== null ? Math.round((now / was - 1) * 100) : null;
      const chip = delta === null || delta === 0 ? "" : `<span class="chip ${delta < 0 ? "good" : "bad"} badge">${delta > 0 ? "+" : ""}${delta}%</span>`;
      return `<div class="gcard">${chip}<div class="t">${esc(x.title || "#" + id)}</div><div class="p">${coin(x.price)}</div><div class="m">${x.active ? "в продаже" : "ушёл с рынка (вероятно продан или снят)"} · при добавлении: ${esc(coin(was))}</div><div class="row">${ext(lotUrl(x), "Открыть ↗")}<button class="btn mini" type="button" data-unstar="${esc(id)}">Убрать</button></div></div>`;
    }).join("");
  } catch (e) { box.innerHTML = emptyBox("Не удалось загрузить избранное: " + e.message, "favorites"); }
}
async function loadAnalytics() {
  try {
    const a = await api("/api/analytics/summary"), s = a.summary;
    $("aKpis").innerHTML = [["Выборка", fmt(a.sample_size), "лотов с ценой"], ["Нижний квартиль", coin(s.p25), "25% дешевле"], ["Медиана", coin(s.median), "типичная цена"], ["Верхний квартиль", coin(s.p75), "25% дороже"]]
      .map(([t, v, n]) => `<div class="kpi"><span>${t}</span><b>${esc(v)}</b><small>${n}</small></div>`).join("");
    bars($("bins"), a.bins.map(b => [b.label, b.count]), "Недостаточно данных: нужно минимум 5 лотов с ценой.");
    $("binsNote").textContent = a.enough_data ? `Диапазоны по перцентилям 5–95%, чтобы выбросы не растягивали шкалу. Выборка: ${a.sample_size}.` : "";
    bars($("rarity"), a.rarities.map(r => [r.rarity, r.count]));
    $("changes").innerHTML = a.changes.map(c => `<div class="li"><span>За ${c.days} дн.<br><span class="muted">снимков: ${c.snapshots}</span></span><b>${esc(pct(c.change_pct))}</b></div>`).join("");
    $("method").textContent = a.method + " " + a.note;
    await trend();
  } catch (e) { $("aKpis").innerHTML = emptyBox("Не удалось загрузить аналитику: " + e.message, "analytics"); }
}

// ---- support the author (huEVO Apps payments)
let supportCfg = null, inHuevo = false, sdkReady = false;
function supportMsg(text, kind) { const m = $("supportMsg"); m.hidden = !text; m.textContent = text || ""; m.className = "banner" + (kind ? " " + kind : ""); }
async function initSupport() {
  try { supportCfg = await api("/api/support/config"); } catch (_) { supportCfg = {enabled: false, amounts: [5, 10, 50, 100]}; }
  inHuevo = new URLSearchParams(location.search).has("hu_user_id");
  $("amounts").innerHTML = (supportCfg.amounts || []).map(a => `<button class="btn" type="button" data-amount="${a}"><b>${a} ◉</b><small>монеток</small></button>`).join("");
  $("supportHint").textContent = !supportCfg.enabled ? "Приём поддержки ещё не настроен владельцем (HUEVO_CLIENT_ID / HUEVO_CLIENT_SECRET)."
    : !inHuevo ? "Кнопка работает, когда панель открыта как приложение внутри huEVO: только там известен ваш аккаунт и доступно окно подтверждения платежа."
    : "Платёж подтверждается в окне huEVO. Пока приложение не опубликовано, работает тестовый режим: монетки не списываются.";
  try { const s = await api("/api/support/stats"); $("supCount").textContent = fmt(s.supporters); $("supTotal").textContent = fmt(s.total); } catch (_) {}
  if (supportCfg.enabled && inHuevo) {
    await new Promise(res => { const sc = document.createElement("script"); sc.src = supportCfg.sdk_url; sc.onload = res; sc.onerror = res; document.head.appendChild(sc); });
    try { await window.huevo.init({origins: supportCfg.origins}); sdkReady = true; } catch (e) { supportMsg("SDK huEVO не инициализирован: " + (e.code || e.message), "error"); }
  }
}
$("amounts").addEventListener("click", async e => {
  const btn = e.target.closest("[data-amount]"); if (!btn || btn.disabled) return;
  if (!supportCfg.enabled) return supportMsg("Приём поддержки не настроен.", "error");
  if (!inHuevo || !sdkReady) return supportMsg("Откройте панель внутри huEVO как приложение, чтобы оплатить.", "error");
  const all = document.querySelectorAll("#amounts .btn"); all.forEach(b => b.disabled = true);
  try {
    supportMsg("Создаём платёж…");
    const it = await api("/api/support/intent", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({amount: Number(btn.dataset.amount), launch_query: location.search})});
    supportMsg("Подтвердите платёж в окне huEVO" + (it.test ? " (тестовый режим: монетки не списываются)…" : "…"));
    await window.huevo.confirmPayment(it.intent_id).catch(() => null);          // UI hint only; the server decides
    let st = "pending";
    for (let i = 0; i < 40 && st === "pending"; i++) { st = (await api("/api/support/status/" + it.intent_id)).status; if (st === "pending") await new Promise(r => setTimeout(r, 2000)); }
    if (st === "succeeded") supportMsg(it.test ? "Тестовый платёж прошёл. Спасибо!" : "Спасибо за поддержку! Платёж подтверждён сервером.", "good");
    else if (st === "pending") supportMsg("Платёж ещё не подтверждён. Если вы его оплатили, статус обновится автоматически.");
    else supportMsg("Платёж не завершён (" + st + ").", "error");
    api("/api/support/stats").then(s => { $("supCount").textContent = fmt(s.supporters); $("supTotal").textContent = fmt(s.total); }).catch(() => {});
  } catch (err) { supportMsg(err.message, "error"); }
  finally { all.forEach(b => b.disabled = false); }
});

// ---- boot
let refreshing = false;
async function refresh() {
  if (refreshing || document.hidden) return; refreshing = true;
  try { await Promise.all([loadOverview(), renderStatus()]); } finally { refreshing = false; }
}
showTab(location.hash.slice(1));
loadFacets(); refresh(); initSupport();
setInterval(refresh, 60000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
})();
