(() => {
"use strict";
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const num = v => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v))) ? null : Number(v);
const fmt = v => num(v) === null ? "—" : Number(v).toLocaleString("ru-RU", {maximumFractionDigits: 1});
const coin = v => num(v) === null ? "—" : fmt(v) + " ◉";
const dt = s => s ? String(s).replace("T", " ").slice(0, 16) + " UTC" : "—";
const ago = s => { if (!s) return ""; const m = Math.round((Date.now() - new Date(s)) / 60000); return m < 1 ? "только что" : m < 60 ? m + " мин назад" : m < 2880 ? Math.round(m / 60) + " ч назад" : Math.round(m / 1440) + " дн назад"; };
const lotUrl = x => x.lot_url || ("https://huevo.su/market/lot/" + encodeURIComponent(x.lot_id));
const safeHttps = u => /^https:\/\//i.test(u || "") ? u : "";
const pic = x => safeHttps(x.image_url) ? `<img loading="lazy" alt="" src="${esc(x.image_url)}" onerror="this.remove()">` : "🎁";

async function api(path, options) {
  const r = await fetch(path, options);
  let data = {};
  try { data = await r.json(); } catch (_) {}
  if (!r.ok) throw new Error(data.detail || ("HTTP " + r.status));
  return data;
}

// ---- per-viewer conveniences (never required for rendering)
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
};
let favs = store.get("huevo.favs", {});       // {lot_id: price when starred}
let lots = [], rowLimit = 200, adminToken = "";

// ---- tabs
const tabs = ["overview", "catalog", "deals", "analytics", "favorites", "collector", "support"];
function showTab(name) {
  if (!tabs.includes(name)) name = "overview";
  tabs.forEach(t => {
    $("tab-" + t).hidden = t !== name;
    $("tab-" + t).classList.toggle("on", t === name);
  });
  document.querySelectorAll("#tabs button").forEach(b => {
    const on = b.dataset.tab === name;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  if (location.hash.slice(1) !== name) history.replaceState(null, "", location.search + "#" + name);
}
document.querySelectorAll("#tabs button").forEach(b => b.addEventListener("click", () => showTab(b.dataset.tab)));
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));
document.addEventListener("keydown", e => {
  if (e.key === "/" && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); showTab("catalog"); $("q").focus(); }
});

function banner(msg, kind) { const b = $("banner"); b.textContent = msg; b.className = "banner" + (kind ? " " + kind : ""); }

// ---- token dialog (memory only)
function askToken() {
  return new Promise(resolve => {
    if (adminToken) return resolve(adminToken);
    const d = $("tokenDialog"), i = $("tokenInput"); i.value = "";
    d.addEventListener("close", () => { if (d.returnValue === "ok" && i.value.trim()) adminToken = i.value.trim(); i.value = ""; resolve(adminToken); }, {once: true});
    d.showModal();
  });
}
async function authed(path) {
  const t = await askToken();
  if (!t) throw new Error("Токен не введён");
  try { return await api(path, {method: "POST", headers: {Authorization: "Bearer " + t}}); }
  catch (e) { if (/токен/i.test(e.message)) adminToken = ""; throw e; }
}

// ---- charts
function lineChart(svg, points, opts = {}) {
  const el = typeof svg === "string" ? $(svg) : svg;
  if (!points.length) { el.innerHTML = '<text x="350" y="100" text-anchor="middle">Данных пока нет</text>'; return; }
  const W = 700, H = 200, P = 28;
  const ys = points.map(p => p.y), lo = Math.min(...ys), hi = Math.max(...ys), span = (hi - lo) || Math.max(1, Math.abs(hi) * .05);
  const xy = points.map((p, i) => [P + i * (W - 2 * P) / Math.max(1, points.length - 1), H - P - (p.y - lo) / span * (H - 2 * P)]);
  const line = xy.map(a => a[0].toFixed(1) + "," + a[1].toFixed(1)).join(" ");
  const area = `${P},${H - P} ${line} ${W - P},${H - P}`;
  const dots = xy.map((a, i) => `<circle cx="${a[0]}" cy="${a[1]}" r="3.4" fill="var(--gold)" stroke="#18160f" stroke-width="1.5"><title>${esc(points[i].label)} · ${esc(fmt(points[i].y))}</title></circle>`).join("");
  el.innerHTML = `<defs><linearGradient id="g${el.id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#efcb75" stop-opacity=".28"/><stop offset="1" stop-color="#efcb75" stop-opacity="0"/></linearGradient></defs>
    <line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" stroke="#3d3623"/>
    <text x="2" y="${P}">${esc(fmt(hi))}</text><text x="2" y="${H - P}">${esc(fmt(lo))}</text>
    <text x="${P}" y="${H - 6}">${esc(points[0].label)}</text><text x="${W - P}" y="${H - 6}" text-anchor="end">${esc(points[points.length - 1].label)}</text>
    <polygon points="${area}" fill="url(#g${el.id})"/><polyline points="${line}" fill="none" stroke="#efcb75" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>${dots}`;
}
async function renderTrend() {
  const days = $("trendDays").value;
  try {
    const s = await api("/api/analytics/snapshots?days=" + days);
    const byDay = new Map();
    (s.points || []).forEach(p => { if (p.median_price != null) byDay.set(String(p.observed_at).slice(0, 10), p); });
    if (byDay.size >= 2) {
      const pts = [...byDay.entries()].map(([d, p]) => ({label: d.slice(5), y: p.median_price}));
      lineChart("trend", pts); lineChart("trend2", pts);
      $("trendNote").textContent = "Медиана цены активных предложений по снимкам рынка (последний снимок дня).";
      $("trend2Note").textContent = byDay.size + " дней со снимками. Это текущие предложения, не завершённые сделки.";
      return;
    }
    const h = await api("/api/analytics/price-history?days=" + days);
    const pts = (h.points || []).map(p => ({label: String(p.day).slice(5), y: p.avg_price}));
    lineChart("trend", pts); lineChart("trend2", pts);
    $("trendNote").textContent = "Снимков рынка пока меньше двух: показано среднее по сохранённым изменениям цены.";
    $("trend2Note").textContent = $("trendNote").textContent;
  } catch (e) { $("trendNote").textContent = "Не удалось загрузить историю: " + e.message; }
}
$("trendDays").addEventListener("change", renderTrend);

// ---- overview
function spot(x, extra) {
  if (!x) return '<div class="empty">Пока нет данных. Загрузите лоты сборщиком (вкладка «Сборщик»).</div>';
  return `<div class="pic">${pic(x)}</div><div class="spot-info"><div class="t">${esc(x.title || "Без названия")}</div><div class="p">${coin(x.price)}</div><div class="m">#${esc(x.lot_id)} · ${esc(x.serial || "серия не указана")} · ${esc(x.rarity || "редкость не указана")}</div>${extra || ""}<div style="margin-top:10px"><a class="btn mini" href="${esc(lotUrl(x))}" target="_blank" rel="noopener noreferrer">Открыть лот ↗</a></div></div>`;
}
async function renderHighlights() {
  try {
    const h = await api("/api/highlights");
    $("spotLatest").querySelector(".spot-body").innerHTML = spot(h.latest, h.latest ? `<div class="m">Замечен: ${esc(dt(h.latest.first_seen))} (${esc(ago(h.latest.first_seen))})</div>` : "");
    $("latestNote").textContent = h.latest_note || "";
    const b = h.best;
    const basis = b ? (b.basis === "gone" ? `по ${b.sample_size} ушедшим с рынка лотам` : `по ${b.sample_size} активным предложениям`) : "";
    $("spotBest").querySelector(".spot-body").innerHTML = b
      ? spot(b, `<div style="margin:6px 0"><span class="chip good">−${esc(b.discount_pct)}% к эталону</span> <span class="chip">эталон ${esc(coin(b.reference))}</span></div><div class="m">Основа: ${esc(basis)}${b.basis === "gone" ? " (вероятно проданы или сняты)" : ""}</div>`)
      : '<div class="empty">Нужно минимум 3 лота с одинаковым названием, чтобы сравнить с рынком.</div>';
    $("bestNote").textContent = h.best_note || "";
  } catch (e) {
    document.querySelectorAll(".spot-body").forEach(n => n.innerHTML = `<div class="empty">Не удалось загрузить: ${esc(e.message)}</div>`);
  }
}
async function renderDrops() {
  try {
    const d = await api("/api/drops?limit=6");
    $("drops").innerHTML = d.length ? d.map(x => `<a class="li" href="${esc(lotUrl(x))}" target="_blank" rel="noopener noreferrer"><span><b>${esc(x.title || "#" + x.lot_id)}</b><br><span class="muted">${esc(coin(x.previous_price))} → ${esc(coin(x.price))}</span></span><span class="chip good">−${esc(x.drop_pct)}%</span></a>`).join("") : '<div class="empty">Снижений цен пока не зафиксировано: нужны минимум два прохода сборщика.</div>';
  } catch (e) { $("drops").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
function renderKpis(stats) {
  $("kCount").textContent = fmt(stats.n);
  const prices = lots.map(l => num(l.price)).filter(p => p !== null).sort((a, b) => a - b);
  const med = prices.length ? (prices.length % 2 ? prices[(prices.length - 1) / 2] : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2) : null;
  $("kMedian").textContent = coin(med); $("kMin").textContent = coin(stats.minp); $("kMax").textContent = coin(stats.maxp);
}

// ---- catalog
const isFav = id => Object.prototype.hasOwnProperty.call(favs, id);
function filteredLots() {
  const q = $("q").value.trim().toLowerCase(), sf = $("statusFilter").value, rf = $("rarityFilter").value;
  const mn = parseFloat($("minPrice").value), mx = parseFloat($("maxPrice").value), sort = $("sort").value;
  let a = lots.filter(x => (`${x.title || ""} ${x.lot_id}`).toLowerCase().includes(q) && (!sf || x.status === sf) && (!rf || x.rarity === rf)
    && (isNaN(mn) || (x.price != null && x.price >= mn)) && (isNaN(mx) || (x.price != null && x.price <= mx)));
  const cmp = {
    price: (x, y) => (x.price ?? Infinity) - (y.price ?? Infinity),
    price_desc: (x, y) => (y.price ?? -1) - (x.price ?? -1),
    title: (x, y) => String(x.title).localeCompare(String(y.title), "ru"),
    recent: (x, y) => String(y.last_seen || "").localeCompare(String(x.last_seen || "")),
    new: (x, y) => String(y.first_seen || "").localeCompare(String(x.first_seen || "")) || (Number(y.lot_id) - Number(x.lot_id))
  }[sort];
  return a.sort(cmp);
}
function renderRows() {
  const all = filteredLots(), a = all.slice(0, rowLimit);
  $("rowsCount").textContent = all.length.toLocaleString("ru-RU") + " лотов" + (all.length > a.length ? ` (показано ${a.length})` : "");
  $("moreRows").classList.toggle("hidden", all.length <= a.length);
  $("rows").innerHTML = a.length ? a.map(x => `<tr><td><button class="star${isFav(x.lot_id) ? " on" : ""}" data-star="${esc(x.lot_id)}" aria-label="В избранное" aria-pressed="${isFav(x.lot_id)}">★</button></td>
    <td><div class="gift"><div class="thumb">${pic(x)}</div><div><div class="gname">${esc(x.title || "Без названия")}</div><div class="gmeta">#${esc(x.lot_id)} · ${esc(x.serial || "серия не указана")} · ${esc(x.rarity || "редкость не указана")}</div></div></div></td>
    <td class="price">${coin(x.price)}</td><td><span class="chip">${esc(x.status || "Неизвестно")}</span></td><td>${esc(dt(x.last_seen))}</td>
    <td><div class="row"><button class="btn mini" data-hist="${esc(x.lot_id)}">График</button><a class="btn mini" href="${esc(lotUrl(x))}" target="_blank" rel="noopener noreferrer">Открыть ↗</a></div></td></tr>`).join("")
    : '<tr><td colspan="6" class="empty">Лоты не найдены. Измените фильтры или загрузите данные.</td></tr>';
}
function fillFilters() {
  [["statusFilter", "status", "Все статусы"], ["rarityFilter", "rarity", "Любая редкость"]].forEach(([id, key, all]) => {
    const el = $(id), cur = el.value, vals = [...new Set(lots.map(x => x[key]).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), "ru"));
    el.innerHTML = `<option value="">${all}</option>` + vals.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join("");
    el.value = vals.includes(cur) ? cur : "";
  });
}
$("rows").addEventListener("click", e => {
  const star = e.target.closest("[data-star]"), hist = e.target.closest("[data-hist]");
  if (star) {
    const id = star.dataset.star;
    if (isFav(id)) delete favs[id]; else { const l = lots.find(x => x.lot_id === id); favs[id] = l ? l.price : null; }
    store.set("huevo.favs", favs); renderRows(); renderFavs();
  }
  if (hist) openHistory(hist.dataset.hist);
});
["q", "sort", "statusFilter", "rarityFilter", "minPrice", "maxPrice"].forEach(id => $(id).addEventListener("input", () => { rowLimit = 200; renderRows(); }));
$("moreRows").addEventListener("click", () => { rowLimit += 200; renderRows(); });
$("resetFilters").addEventListener("click", () => { ["q", "statusFilter", "rarityFilter", "minPrice", "maxPrice"].forEach(id => $(id).value = ""); rowLimit = 200; renderRows(); });
$("exportCsv").addEventListener("click", () => {
  const rows = filteredLots();
  if (!rows.length) return banner("Нет данных для экспорта.", "error");
  const head = ["lot_id", "title", "serial", "rarity", "price", "status", "first_seen", "last_seen", "lot_url"];
  const q = v => '"' + String(v ?? "").replace(/"/g, '""') + '"';
  const blob = new Blob(["﻿" + [head, ...rows.map(x => head.map(k => x[k] ?? ""))].map(r => r.map(q).join(";")).join("\r\n")], {type: "text/csv;charset=utf-8"});
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "huevo-gifts-" + new Date().toISOString().slice(0, 10) + ".csv";
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  banner("Экспортировано строк: " + rows.length, "good");
});
async function openHistory(id) {
  const l = lots.find(x => x.lot_id === id);
  $("histTitle").textContent = (l && l.title ? l.title : "Лот") + " · #" + id;
  $("histNote").textContent = "Загрузка…"; $("histChart").innerHTML = "";
  $("histDialog").showModal();
  try {
    const h = await api("/api/history/" + encodeURIComponent(id));
    const pts = h.filter(r => num(r.price) !== null).map(r => ({label: String(r.observed_at).slice(5, 10), y: Number(r.price)}));
    lineChart("histChart", pts);
    $("histNote").textContent = pts.length + " сохранённых значений цены (записываются при изменении).";
  } catch (e) { $("histNote").textContent = e.message; }
}
$("histClose").addEventListener("click", () => $("histDialog").close());

// ---- deals & favorites & analytics
async function renderDeals() {
  try {
    const r = await api("/api/deals?limit=30");
    $("deals").innerHTML = r.deals.length ? r.deals.map(d => `<a class="gcard" href="${esc(lotUrl(d))}" target="_blank" rel="noopener noreferrer"><span class="chip good badge">−${esc(d.discount_pct)}%</span><div class="t">${esc(d.title || "#" + d.lot_id)}</div><div class="p">${coin(d.price)}</div><div class="muted">медиана ${esc(coin(d.median))} · предложений ${esc(d.group_size)} · #${esc(d.lot_id)}</div></a>`).join("") : '<div class="empty">Пока нет групп из 3+ одинаковых предложений с заметной разницей в цене.</div>';
  } catch (e) { $("deals").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
function renderFavs() {
  const ids = Object.keys(favs);
  if (!ids.length) { $("favs").innerHTML = '<div class="empty">Пока пусто. Нажмите ★ рядом с лотом в каталоге.</div>'; return; }
  $("favs").innerHTML = ids.map(id => {
    const x = lots.find(l => l.lot_id === id);
    if (!x) return `<div class="gcard"><div class="t">#${esc(id)}</div><div class="muted">Лота нет на рынке (продан, снят или ещё не загружен).</div><div class="row" style="margin-top:8px"><button class="btn mini" data-unstar="${esc(id)}">Убрать</button></div></div>`;
    const was = num(favs[id]), now = num(x.price);
    const delta = was && now !== null ? Math.round((now / was - 1) * 100) : null;
    const chip = delta === null || delta === 0 ? "" : `<span class="chip ${delta < 0 ? "good" : "bad"} badge">${delta > 0 ? "+" : ""}${delta}%</span>`;
    return `<div class="gcard">${chip}<div class="t">${esc(x.title || "#" + id)}</div><div class="p">${coin(x.price)}</div><div class="muted">при добавлении: ${esc(coin(was))}</div><div class="row" style="margin-top:8px"><a class="btn mini" href="${esc(lotUrl(x))}" target="_blank" rel="noopener noreferrer">Открыть ↗</a><button class="btn mini" data-unstar="${esc(id)}">Убрать</button></div></div>`;
  }).join("");
}
$("favs").addEventListener("click", e => { const b = e.target.closest("[data-unstar]"); if (b) { delete favs[b.dataset.unstar]; store.set("huevo.favs", favs); renderFavs(); renderRows(); } });
function bars(el, entries) {
  const max = Math.max(1, ...entries.map(e => e[1]));
  el.innerHTML = entries.length ? entries.map(([n, c]) => `<div class="bar"><span title="${esc(n)}">${esc(n)}</span><div class="track"><div class="fill" style="width:${Math.round(c / max * 100)}%"></div></div><b>${c}</b></div>`).join("") : '<div class="empty">Нет данных</div>';
}
function renderAnalytics(stats) {
  const total = Number(stats.n_total || 0), priced = Number(stats.n || 0), pct = total ? Math.round(priced / total * 100) : 0;
  $("donut").style.background = `conic-gradient(var(--gold) 0 ${pct}%, #2c281d ${pct}% 100%)`;
  $("donutNum").textContent = total ? pct + "%" : "—";
  $("donutText").textContent = total ? `С ценой ${fmt(priced)} из ${fmt(total)} активных лотов` : "Каталог пуст";
  const vals = lots.map(l => num(l.price)).filter(v => v !== null).sort((a, b) => a - b);
  if (vals.length) {
    const lo = vals[0], hi = vals[vals.length - 1];
    const e = lo === hi ? [[fmt(lo), vals.length]] : [0, 1, 2, 3].map(i => {
      const a = lo + (hi - lo) * i / 4, b = lo + (hi - lo) * (i + 1) / 4;
      return [i === 0 ? "≤ " + fmt(b) : i === 3 ? "> " + fmt(a) : fmt(a) + "–" + fmt(b), vals.filter(v => i === 0 ? v <= b : i === 3 ? v > a : v > a && v <= b).length];
    });
    bars($("bins"), e);
  } else bars($("bins"), []);
  const g = new Map(); lots.forEach(l => g.set(l.rarity || "Не указана", (g.get(l.rarity || "Не указана") || 0) + 1));
  bars($("rarity"), [...g.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6));
}

// ---- collector
async function renderStatus() {
  try {
    const [s, d] = await Promise.all([api("/api/status"), api("/api/diagnostics")]);
    $("dot").className = "dot" + (s.running ? " live" : /ошибка|огранич/i.test(s.message || "") ? " error" : (s.last_ingest_at ? " live" : ""));
    $("statusText").textContent = s.running ? "Сбор идёт…" : s.last_ingest_at ? "Данные получены" : "Сервер доступен";
    $("freshness").textContent = s.last_ingest_at ? "Обновлено " + ago(s.last_ingest_at) : "";
    $("statusBox").textContent = [s.message || "—", "Лотов в базе: " + d.lots_in_database, "Записей истории: " + d.price_history_rows,
      "Токен импорта: " + (d.ingest_token_configured ? "настроен" : "НЕ настроен"), "Серверная сессия Huevo: " + (d.huevo_cookies_configured ? "задана" : "не задана"),
      s.last_ingest_at ? "Последний импорт: " + dt(s.last_ingest_at) : "Импортов ещё не было", s.blocked_until ? "Пауза после ограничения до: " + dt(s.blocked_until) : ""].filter(Boolean).join("\n");
    banner(s.running ? `${s.message || "Сбор"} · страница ${s.page}, найдено ${s.found}` : (s.message || "API подключён"), /ошибка|огранич/i.test(s.message || "") ? "error" : (s.last_ingest_at ? "good" : ""));
  } catch (e) { $("dot").className = "dot error"; $("statusText").textContent = "API недоступен"; banner("Не удалось связаться с API: " + e.message, "error"); }
}
$("refreshBtn").addEventListener("click", async () => {
  const b = $("refreshBtn"); b.disabled = true; b.textContent = "⟳ Запускаем…";
  try { await authed("/api/crawl"); await renderStatus(); } catch (e) { banner("Не удалось запустить сбор: " + e.message, "error"); }
  finally { b.disabled = false; b.textContent = "↻ Обновить рынок"; }
});
$("diagnostics").addEventListener("click", renderStatus);
$("probeHuevo").addEventListener("click", async () => {
  const b = $("probeHuevo"), p = $("diagBox"); b.disabled = true;
  try {
    const r = await authed("/api/diagnose-huevo");
    p.textContent = ["Проверка доступа к Huevo (" + r.base_url + ")", "Cookies на сервере: " + (r.cookies_configured ? "заданы" : "не заданы")]
      .concat((r.steps || []).map(x => `• ${x.step}: ${x.verdict}${x.final_host ? " · " + x.final_host : ""}${x.cards != null ? " · карточек: " + x.cards : ""}\n   ${x.hint || ""}`)).concat(r.error ? ["Ошибка: " + r.error] : []).join("\n");
  } catch (e) { p.textContent = "Проверка не выполнена: " + e.message; }
  p.classList.remove("hidden"); b.disabled = false;
});

// ---- support the author (huEVO Apps payments)
let supportCfg = null, inHuevo = false, sdkReady = false;
function supportMsg(text, kind) { const m = $("supportMsg"); m.hidden = !text; m.textContent = text || ""; m.className = "banner" + (kind ? " " + kind : ""); }
async function initSupport() {
  try { supportCfg = await api("/api/support/config"); } catch (_) { supportCfg = {enabled: false, amounts: [5, 10, 50, 100]}; }
  inHuevo = new URLSearchParams(location.search).has("hu_user_id");
  $("amounts").innerHTML = (supportCfg.amounts || []).map(a => `<button class="btn" data-amount="${a}">${a} ◉<small>монеток</small></button>`).join("");
  const hint = $("supportHint");
  if (!supportCfg.enabled) hint.textContent = "Приём поддержки ещё не настроен владельцем (HUEVO_CLIENT_ID / HUEVO_CLIENT_SECRET).";
  else if (!inHuevo) hint.textContent = "Кнопка работает, когда панель открыта как приложение внутри huEVO: только там известен ваш аккаунт и доступно окно подтверждения платежа.";
  else hint.textContent = "Платёж подтверждается в окне huEVO. Если приложение не опубликовано, работает тестовый режим: монетки не списываются.";
  try { const s = await api("/api/support/stats"); $("supCount").textContent = fmt(s.supporters); $("supTotal").textContent = fmt(s.total); } catch (_) {}
  if (supportCfg.enabled && inHuevo) {
    await new Promise(res => { const sc = document.createElement("script"); sc.src = supportCfg.sdk_url; sc.onload = res; sc.onerror = res; document.head.appendChild(sc); });
    try { await window.huevo.init({origins: supportCfg.origins}); sdkReady = true; } catch (e) { supportMsg("SDK huEVO не инициализирован: " + (e.code || e.message), "error"); }
  }
}
$("amounts").addEventListener("click", async e => {
  const btn = e.target.closest("[data-amount]"); if (!btn) return;
  if (!supportCfg.enabled) return supportMsg("Приём поддержки не настроен.", "error");
  if (!inHuevo || !sdkReady) return supportMsg("Откройте панель внутри huEVO как приложение, чтобы оплатить.", "error");
  document.querySelectorAll("#amounts .btn").forEach(b => b.disabled = true);
  try {
    supportMsg("Создаём платёж…");
    const it = await api("/api/support/intent", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({amount: Number(btn.dataset.amount), launch_query: location.search})});
    supportMsg("Подтвердите платёж в окне huEVO" + (it.test ? " (тестовый режим: монетки не списываются)…" : "…"));
    // The frontend result can be spoofed: it only drives the UI. The server decides via the API/callback.
    await window.huevo.confirmPayment(it.intent_id).catch(() => null);
    let st = "pending";
    for (let i = 0; i < 40 && st === "pending"; i++) { st = (await api("/api/support/status/" + it.intent_id)).status; if (st === "pending") await new Promise(r => setTimeout(r, 2000)); }
    if (st === "succeeded") supportMsg(it.test ? "Тестовый платёж прошёл. Спасибо!" : "Спасибо за поддержку! Платёж подтверждён сервером.", "good");
    else if (st === "pending") supportMsg("Платёж ещё не подтверждён. Если вы его оплатили, статус обновится автоматически.");
    else supportMsg("Платёж не завершён (" + st + ").", "error");
    api("/api/support/stats").then(s => { $("supCount").textContent = fmt(s.supporters); $("supTotal").textContent = fmt(s.total); }).catch(() => {});
  } catch (err) { supportMsg(err.message, "error"); }
  finally { document.querySelectorAll("#amounts .btn").forEach(b => b.disabled = false); }
});

// ---- boot
let loading = false;
async function loadAll() {
  if (loading) return; loading = true;
  try {
    const [stats, list] = await Promise.all([api("/api/stats"), api("/api/lots?limit=2000&sort=new")]);
    lots = Array.isArray(list) ? list : [];
    fillFilters(); renderRows(); renderKpis(stats); renderAnalytics(stats); renderFavs();
    await Promise.all([renderHighlights(), renderDrops(), renderDeals(), renderTrend(), renderStatus()]);
  } catch (e) { banner("Ошибка загрузки данных: " + e.message, "error"); }
  finally { loading = false; }
}
showTab(location.hash.slice(1));
loadAll(); initSupport();
setInterval(loadAll, 60000);
window.addEventListener("focus", loadAll);
})();
