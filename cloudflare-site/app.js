"use strict";
(function () {
  const $ = (id) => document.getElementById(id);
  const SVG = "http://www.w3.org/2000/svg";
  const PAGE = 50;
  const STALE_HOURS = 24;
  const HUEVO_HOSTS = /^https:\/\/(huevo\.su|huevo\.departament\.site)\//i;

  // ---------- safe DOM helpers (no innerHTML anywhere: all text goes through textContent) ----------
  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    for (const k in attrs || {}) {
      if (k === "class") el.className = attrs[k];
      else if (k === "text") el.textContent = attrs[k];
      else el.setAttribute(k, attrs[k]);
    }
    for (const c of [].concat(children || [])) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  }
  function s(tag, attrs, children) {
    const el = document.createElementNS(SVG, tag);
    for (const k in attrs || {}) el.setAttribute(k, attrs[k]);
    for (const c of [].concat(children || [])) if (c != null) el.append(c);
    return el;
  }
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const fmt = (v) => isNum(v) ? v.toLocaleString("ru-RU", { maximumFractionDigits: 1 }) : "—";
  const price = (v) => isNum(v) ? fmt(v) + " ◉" : "—";
  const short = (v) => !isNum(v) ? "—" : Math.abs(v) >= 1e6 ? (v / 1e6).toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + " млн" : Math.abs(v) >= 1e3 ? (v / 1e3).toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + " тыс" : fmt(v);
  function when(value) {
    if (!value) return "—";
    const d = new Date(value);
    return isNaN(d) ? "—" : d.toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" });
  }
  function ago(value) {
    const d = new Date(value);
    if (!value || isNaN(d)) return "";
    const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
    if (mins < 60) return mins + " мин назад";
    if (mins < 48 * 60) return Math.round(mins / 60) + " ч назад";
    return Math.round(mins / 1440) + " дн назад";
  }
  const safeUrl = (u, id) => (typeof u === "string" && HUEVO_HOSTS.test(u)) ? u : "https://huevo.su/market/lot/" + encodeURIComponent(String(id));
  function median(values) {
    const a = values.slice().sort((x, y) => x - y);
    if (!a.length) return null;
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function quantile(sorted, q) {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  // ---------- state ----------
  function readFavorites() {
    try {
      const stored = JSON.parse(localStorage.getItem("amnyam.favorites") || "[]");
      return Array.isArray(stored) ? stored.map(String).filter((id) => /^\d{1,20}$/.test(id)).slice(0, 5000) : [];
    } catch (_) { return []; }
  }
  function writeFavorites() { try { localStorage.setItem("amnyam.favorites", JSON.stringify(state.favorites)); } catch (_) {} }
  function readTargets() {
    try { const x=JSON.parse(localStorage.getItem("amnyam.targets")||"{}"); return x&&typeof x==="object"&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).filter(([id,v])=>/^\\d{1,20}$/.test(id)&&isNum(v)&&v>0).slice(0,5000)):{}; } catch (_) { return {}; }
  }
  function writeTargets(){try{localStorage.setItem("amnyam.targets",JSON.stringify(state.targets));}catch(_){}}
  function readAlertedTargets(){try{const x=JSON.parse(localStorage.getItem("amnyam.alertedTargets")||"[]");return Array.isArray(x)?x.map(String).filter(id=>/^\\d{1,20}$/.test(id)).slice(0,5000):[];}catch(_){return [];}}
  function writeAlertedTargets(){try{localStorage.setItem("amnyam.alertedTargets",JSON.stringify(state.alertedTargets));}catch(_){}}
  function readSavedFilters(){try{const x=JSON.parse(localStorage.getItem("amnyam.savedFilters")||"[]");return Array.isArray(x)?x.filter(i=>i&&typeof i.name==="string"&&i.name.trim()&&i.filters&&typeof i.filters==="object").slice(0,25):[];}catch(_){return [];}}
  function writeSavedFilters(){try{localStorage.setItem("amnyam.savedFilters",JSON.stringify(state.savedFilters));}catch(_){}}
  const state = {
    data:null,lots:[],view:[],page:0,sort:{key:"price",dir:1},groupSort:{key:"count",dir:-1},catalogMode:"lots",
    changeKind:"new",liveFingerprint:null,compareIds:[],activeView:"overview",favorites:readFavorites(),
    targets:readTargets(),alertedTargets:readAlertedTargets(),savedFilters:readSavedFilters()
  };
  let livePollRunning = false;
  let lastSnapshotSignature = "";
  let supportConfig = { enabled: false, amounts: [5000, 10000, 25000, 50000, 100000] };
  let supportSdkReady = false;
  let supportInitRunning = false;

  // ---------- load & normalise (tolerates partial / old JSON) ----------
  const comparableKey = (lot) => JSON.stringify([
    String(lot.title || "").trim().toLocaleLowerCase("ru"),
    String(lot.rarity || "").trim().toLocaleLowerCase("ru")
  ]);

  function normalise(d) {
    const raw = d && typeof d === "object" && !Array.isArray(d) ? d : {};
    const lots = (Array.isArray(raw.lots) ? raw.lots : []).filter((l) => l && typeof l === "object" && l.lot_id != null).map((l) => {
      const hist = Array.isArray(l.history) ? l.history.filter((p) => p && isNum(p.price)) : [];
      let delta = null;
      if (hist.length > 1 && hist[hist.length - 2].price > 0) delta = (hist[hist.length - 1].price - hist[hist.length - 2].price) / hist[hist.length - 2].price * 100;
      return Object.assign({}, l, { price: isNum(l.price) ? l.price : null, _history: hist, _delta: delta, _lotCount: 0, _text: [l.lot_id, l.title, l.serial, l.rarity, l.status].join(" ").toLocaleLowerCase("ru") });
    });
    const groupCounts = new Map();
    lots.forEach((lot) => {
      if (lot.active === false || !isNum(lot.price) || lot.price <= 0) return;
      const key = comparableKey(lot);
      groupCounts.set(key, (groupCounts.get(key) || 0) + 1);
    });
    lots.forEach((lot) => { lot._lotCount = groupCounts.get(comparableKey(lot)) || 0; });
    return { raw, lots };
  }

  async function load() {
    show("loading");
    try {
      const response = await fetch("./data.json?_=" + Date.now(), { cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const json = await response.json();
      const n = normalise(json);
      state.data = n.raw; state.lots = n.lots;
      state.liveFingerprint = n.raw.live && n.raw.live.fingerprint ? String(n.raw.live.fingerprint) : null;
      lastSnapshotSignature = snapshotSignature(n.raw, n.lots);
      render();
    } catch (error) {
      $("errorText").textContent = "Не удалось загрузить data.json (" + (error && error.message ? error.message : "ошибка") + "). Данные могут быть ещё не опубликованы.";
      setBadge("err", "Данные недоступны");
      show("error");
    }
  }

  function snapshotSignature(raw, lots) {
    const live = raw && raw.live && typeof raw.live === "object" ? raw.live : {};
    const collector = raw && raw.collector && typeof raw.collector === "object" ? raw.collector : {};
    const lastSnapshot = Array.isArray(raw && raw.snapshots) ? raw.snapshots[raw.snapshots.length - 1] : null;
    const changes = raw && raw.changes && raw.changes.counts ? raw.changes.counts : null;
    // Ignore last_poll_at and per-lot last_seen: those timestamps move on every poll
    // even when the visible market values did not change.
    return JSON.stringify({
      collector: [collector.status, collector.message, collector.lots, collector.pages],
      live: [live.fingerprint, Number(live.item_count) || 0],
      lots: (lots || []).map((lot) => [
        String(lot.lot_id), lot.title, lot.serial, lot.rarity, lot.price, lot.status,
        lot.active !== false,
        Array.isArray(lot._history) && lot._history.length
          ? [lot._history.length, lot._history[lot._history.length - 1].observed_at, lot._history[lot._history.length - 1].price]
          : Array.isArray(lot.history) && lot.history.length
            ? [lot.history.length, lot.history[lot.history.length - 1].observed_at, lot.history[lot.history.length - 1].price]
            : []
      ]),
      stats: raw && raw.stats,
      snapshots: Array.isArray(raw && raw.snapshots) ? raw.snapshots.length : 0,
      lastSnapshot: lastSnapshot ? [lastSnapshot.observed_at, lastSnapshot.active_lots, lastSnapshot.median_price] : null,
      changes: changes ? [changes.new, changes.gone, changes.price_up, changes.price_down] : null
    });
  }

  async function pollLive() {
    // The dashboard polls the Worker's merged /data.json, not only the first-page
    // endpoint. This lets both the 3-second live stream and the 5-minute full snapshot
    // reach every panel without reloading the document.
    if (livePollRunning || !state.data || document.visibilityState !== "visible") return;
    livePollRunning = true;
    try {
      const response = await fetch("./data.json?_=" + Date.now(), {
        cache: "no-store",
        headers: { "Accept": "application/json" }
      });
      if (!response.ok) return;
      const json = await response.json();
      const n = normalise(json);
      const signature = snapshotSignature(n.raw, n.lots);
      const changed = signature !== lastSnapshotSignature;

      if (changed) {
        // Replace the in-memory snapshot only when actual visible data changed.
        // render() mutates the current DOM in place; no navigation or page reload occurs.
        const nextLiveFingerprint = n.raw.live && n.raw.live.fingerprint ? String(n.raw.live.fingerprint) : null;
        const liveChanged = Boolean(nextLiveFingerprint && nextLiveFingerprint !== state.liveFingerprint);
        state.data = n.raw;
        state.lots = n.lots;
        state.liveFingerprint = nextLiveFingerprint;
        if (liveChanged) {
          // Market-derived views must use newly refreshed first-page prices, not bins
          // and categories calculated from the previous full snapshot.
          state.data.price_bins = [];
          state.data.categories = [];
          state.data.top_expensive = n.lots.filter((lot) => isNum(lot.price)).sort((a, b) => b.price - a.price).slice(0, 10);
        }
        lastSnapshotSignature = signature;
        render();
      } else {
        // Update non-visual metadata (including last successful full-snapshot time) without
        // rebuilding cards, charts, rows, the active tab, or the search controls.
        state.data = n.raw;
        renderState();
      }
    } catch (_) {
      // Keep the last successfully rendered data if the Worker is temporarily unavailable.
    } finally {
      livePollRunning = false;
    }
  }

  function show(which) {
    ["loading", "error", "empty", "content"].forEach((id) => $(id).classList.toggle("hide", id !== which));
  }
  function setBadge(kind, text) { $("stateDot").className = "dot " + kind; $("stateText").textContent = text; }

  // ---------- header / data state ----------
  function renderState() {
    const d = state.data, c = d.collector && typeof d.collector === "object" ? d.collector : {};
    const live = d.live && typeof d.live === "object" ? d.live : {};
    const liveFresh = Boolean(live.enabled && live.fresh);
    const okAt = d.generated_at;
    $("lastOk").textContent = okAt ? when(okAt) + " (" + ago(okAt) + ")" : "—";
    $("lastTry").textContent = c.checked_at ? when(c.checked_at) + (c.status ? " · " + c.status : "") : "—";
    const notice = $("notice");
    notice.className = "notice hide";
    const parts = [];
    let kind = okAt ? "ok" : "";
    let label = okAt ? "Данные актуальны" : "Ожидает первого сбора";
    if (okAt && (Date.now() - new Date(okAt).getTime()) > STALE_HOURS * 3600e3) {
      if (liveFresh) {
        parts.push("В реальном времени обновляется первая страница; остальные лоты и графики используют последний полный снимок от " + when(okAt) + ".");
      } else {
        kind = ""; label = "Данные устарели";
        parts.push("Последний успешный полный сбор был больше " + STALE_HOURS + " ч назад.");
      }
    }
    if (liveFresh) {
      kind = "ok";
      label = "Live · первая страница";
      if (live.last_poll_at && !(okAt && (Date.now() - new Date(okAt).getTime()) > STALE_HOURS * 3600e3)) {
        parts.push("Первая страница обновлена " + when(live.last_poll_at) + "; полный каталог обновляется отдельно.");
      }
    } else if (live.enabled) {
      parts.push(live.last_poll_at
        ? "Live-опрос не обновлялся с " + when(live.last_poll_at) + "."
        : "Live-хранилище готово, но локальный опрос ещё не запущен.");
    } else {
      parts.push(live.message || "Live-хранилище Cloudflare пока не подключено; показывается опубликованный снимок.");
    }
    if (c.status && c.status !== "ok") {
      if (!liveFresh) {
        kind = "err"; label = c.status === "blocked" ? "Сбор на паузе" : "Последний сбор не удался";
      }
      parts.push("Последняя попытка полного сбора: " + (c.message || c.status) + (c.blocked_until ? " Пауза до " + when(c.blocked_until) + "." : "") + " Показан последний полный снимок.");
      notice.classList.add("bad");
    }
    setBadge(kind, label);
    if (parts.length) { notice.textContent = parts.join(" "); notice.classList.remove("hide"); }
  }

  // ---------- stat cards ----------
  function card(key, value, sub) { return h("div", { class: "card" }, [h("div", { class: "k", text: key }), h("div", { class: "v", text: value }), h("div", { class: "s", text: sub })]); }
  function stats() {
    const prices = state.lots.map((l) => l.price).filter((p) => isNum(p) && p > 0);
    prices.sort((a, b) => a - b);
    const sum = prices.reduce((a, b) => a + b, 0);
    return { total: state.lots.length, priced: prices.length, min: prices[0] ?? null, max: prices[prices.length - 1] ?? null, avg: prices.length ? sum / prices.length : null, median: median(prices), p25: quantile(prices, .25), p75: quantile(prices, .75) };
  }
  function renderCards() {
    const st = stats(), box = clear($("cards")), ch = state.data.changes && state.data.changes.counts;
    box.append(
      card("Активные лоты", fmt(st.total), "С ценой: " + fmt(st.priced)),
      card("Минимальная цена", price(st.min), "Среди текущих объявлений"),
      card("Медианная цена", price(st.median), st.p25 != null && st.priced >= 5 ? "Середина 50%: " + fmt(st.p25) + "–" + fmt(st.p75) : "Недостаточно лотов для квартилей"),
      card("Средняя цена", price(st.avg), "Сильно зависит от дорогих лотов"),
      card("Максимальная цена", price(st.max), "Самое дорогое объявление"),
    );
    if (ch) box.append(card("С прошлого снимка", "+" + fmt(ch.new) + " / −" + fmt(ch.gone), "Новых / не найдено; цена изменилась у " + fmt(ch.price_up + ch.price_down)));
    else box.append(card("С прошлого снимка", "—", "Сравнение появится после следующего сбора"));
  }

  // ---------- charts ----------
  function sparkline(history) {
    const values=(Array.isArray(history)?history:[]).filter(p=>p&&isNum(p.price)).slice(-10).map(p=>p.price);
    if(values.length<2)return null;
    const W=72,H=21,pad=2,min=Math.min(...values),max=Math.max(...values),span=max-min||Math.max(1,Math.abs(max)*.05);
    const points=values.map((v,i)=>(pad+i*(W-pad*2)/(values.length-1)).toFixed(1)+","+(pad+(max-v)/span*(H-pad*2)).toFixed(1)).join(" ");
    const direction=values[values.length-1]<values[0]?"down":values[values.length-1]>values[0]?"up":"flat";
    return s("svg",{class:"sparkline "+direction,viewBox:"0 0 "+W+" "+H,role:"img","aria-label":"История цены: "+direction},[s("polyline",{points})]);
  }

  function lineChart(el, points, ariaLabel, minNote) {
    clear(el);
    const pts = points.filter((p) => isNum(p.value));
    if (pts.length < 2) { el.append(h("div", { class: "empty", text: minNote || "Нужно минимум два снимка для графика." })); return; }
    const W = 640, H = 220, L = 50, R = 12, T = 12, B = 28;
    const vals = pts.map((p) => p.value), lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    const span = hi - lo || Math.max(1, Math.abs(hi) * .05);
    const x = (i) => L + i * (W - L - R) / (pts.length - 1), y = (v) => T + (hi - v) / span * (H - T - B);
    const svg = s("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": ariaLabel });
    svg.append(s("line", { class: "axis", x1: L, x2: W - R, y1: H - B, y2: H - B }), s("line", { class: "axis", x1: L, x2: L, y1: T, y2: H - B }));
    [[hi, T + 4], [lo, H - B]].forEach((t) => { const tx = s("text", { class: "tick", x: L - 6, y: t[1], "text-anchor": "end" }); tx.textContent = short(t[0]); svg.append(tx); });
    [0, pts.length - 1].forEach((i) => { const tx = s("text", { class: "tick", x: x(i), y: H - 8, "text-anchor": i ? "end" : "start" }); tx.textContent = pts[i].label; svg.append(tx); });
    svg.append(s("polyline", { class: "line", points: pts.map((p, i) => x(i).toFixed(1) + "," + y(p.value).toFixed(1)).join(" ") }));
    pts.forEach((p, i) => { const c = s("circle", { class: "pt", cx: x(i).toFixed(1), cy: y(p.value).toFixed(1), r: 3.5 }); const t = s("title"); t.textContent = p.label + ": " + fmt(p.value); c.append(t); svg.append(c); });
    el.append(svg);
  }
  const dayLabel = (v) => { const d = new Date(v); return isNaN(d) ? "?" : d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }); };

  function barChart(el, items, ariaLabel) {
    clear(el);
    if (!items.length) { el.append(h("div", { class: "empty", text: "Нет лотов с ценой." })); return; }
    const W = 640, H = 220, L = 34, B = 46, T = 12, max = Math.max.apply(null, items.map((i) => i.count)) || 1;
    const bw = (W - L - 8) / items.length;
    const svg = s("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": ariaLabel });
    svg.append(s("line", { class: "axis", x1: L, x2: W - 4, y1: H - B, y2: H - B }));
    const top = s("text", { class: "tick", x: L - 5, y: T + 8, "text-anchor": "end" }); top.textContent = fmt(max); svg.append(top);
    items.forEach((it, i) => {
      const hh = it.count / max * (H - B - T), x = L + i * bw + 4;
      const r = s("rect", { class: "bar", x: x, y: (H - B - hh).toFixed(1), width: Math.max(2, bw - 8).toFixed(1), height: hh.toFixed(1), rx: 3 });
      const t = s("title"); t.textContent = it.label + ": " + it.count + " лотов"; r.append(t); svg.append(r);
      const tx = s("text", { class: "tick", x: (x + (bw - 8) / 2).toFixed(1), y: H - B + 14, "text-anchor": "middle" }); tx.textContent = it.label; svg.append(tx);
    });
    el.append(svg);
  }

  function renderCharts() {
    const prices = state.lots.map((l) => l.price).filter((p) => isNum(p) && p > 0);
    // price distribution: from the file when present, otherwise computed from lots
    let bins = Array.isArray(state.data.price_bins) ? state.data.price_bins.filter((b) => b && isNum(b.count) && isNum(b.from) && isNum(b.to)) : [];
    if (!bins.length && prices.length) {
      const lo = Math.min.apply(null, prices), hi = Math.max.apply(null, prices), n = 6, step = (hi - lo) / n || 1;
      bins = Array.from({ length: n }, (_, i) => ({ from: lo + i * step, to: lo + (i + 1) * step, count: 0 }));
      prices.forEach((p) => { bins[Math.min(n - 1, Math.floor((p - lo) / step))].count++; });
    }
    $("binsNote").textContent = prices.length ? "лотов с ценой: " + fmt(prices.length) : "";
    barChart($("chartBins"), bins.map((b) => ({ label: short(b.from) + "–" + short(b.to), count: b.count })), "Распределение цен лотов");

    const cats = (Array.isArray(state.data.categories) && state.data.categories.length ? state.data.categories : (() => {
      const g = {}; state.lots.forEach((l) => { const k = l.rarity || "Не указано"; (g[k] = g[k] || []).push(l.price); });
      return Object.keys(g).map((k) => { const p = g[k].filter((v) => isNum(v) && v > 0); return { name: k, count: g[k].length, median: median(p) }; }).sort((a, b) => b.count - a.count);
    })()).filter((c) => c && isNum(c.count));
    const box = clear($("chartCats")), maxC = Math.max.apply(null, cats.map((c) => c.count).concat([1]));
    $("catNote").textContent = cats.length ? "категорий: " + cats.length : "";
    if (!cats.length) box.append(h("div", { class: "empty", text: "Нет данных о категориях." }));
    cats.forEach((c) => {
      const fill = h("div", { class: "fill" }); fill.style.width = (c.count / maxC * 100).toFixed(1) + "%";
      box.append(h("div", { class: "hbar" }, [h("span", { text: c.name }), h("div", { class: "track" }, [fill]), h("span", { class: "n", text: fmt(c.count) + (isNum(c.median) ? " · мед. " + short(c.median) : "") })]));
    });

    const snaps = (Array.isArray(state.data.snapshots) ? state.data.snapshots : []).filter((p) => p && p.observed_at);
    $("countNote").textContent = snaps.length + " снимков";
    $("medianNote").textContent = snaps.length + " снимков";
    lineChart($("chartCount"), snaps.map((p) => ({ label: dayLabel(p.observed_at), value: p.active_lots })), "Динамика числа активных лотов", "История накопится после двух и более сборов.");
    lineChart($("chartMedian"), snaps.map((p) => ({ label: dayLabel(p.observed_at), value: p.median_price })), "Динамика медианной цены", "История накопится после двух и более сборов.");
  }

  // ---------- changes + top ----------
  function lotItem(l, right, sub) {
    const img = l.image_url && /^https:\/\//i.test(l.image_url) ? h("img", { class: "thumb", src: l.image_url, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }) : h("span", { class: "thumb", text: "🎁", "aria-hidden": "true" });
    img.addEventListener && img.addEventListener("error", () => { img.replaceWith(h("span", { class: "thumb", text: "🎁", "aria-hidden": "true" })); });
    return h("li", { class: "li" }, [img, h("div", {}, [h("div", { class: "t", text: l.title || ("Лот #" + l.lot_id) }), h("div", { class: "m", text: sub })]), h("div", { class: "p" }, right)]);
  }
  function renderChanges() {
    const ch = state.data.changes, list = clear($("changeList"));
    document.querySelectorAll(".tabs [role=tab]").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.kind === state.changeKind)));
    if (!ch || !ch.counts) {
      $("changesNote").textContent = "";
      list.append(h("li", { class: "empty", text: "Сравнение со снимком появится после следующего успешного сбора." }));
      return;
    }
    $("changesNote").textContent = ch.since ? "относительно " + when(ch.since) : "";
    const k = state.changeKind;
    const rows = k === "new" ? ch.new : k === "gone" ? ch.gone : ch.price_changes;
    const total = k === "new" ? ch.counts.new : k === "gone" ? ch.counts.gone : ch.counts.price_up + ch.counts.price_down;
    if (!rows || !rows.length) { list.append(h("li", { class: "empty", text: k === "new" ? "Новых лотов нет." : k === "gone" ? "Исчезнувших лотов нет." : "Изменений цен нет." })); return; }
    rows.forEach((r) => {
      if (k === "price") {
        const up = r.to > r.from;
        list.append(lotItem(r, [h("span", { class: up ? "bad" : "good", text: fmt(r.from) + " → " + fmt(r.to) + " ◉" }), h("div", { class: "m", text: (r.pct != null ? (r.pct > 0 ? "+" : "") + fmt(r.pct) + "%" : "") })], "#" + r.lot_id));
      } else list.append(lotItem(r, price(r.price), "#" + r.lot_id + (r.rarity ? " · " + r.rarity : "")));
    });
    if (total > rows.length) list.append(h("li", { class: "m", text: "Показано " + rows.length + " из " + fmt(total) + "." }));
  }
  function renderTop() {
    const top = (Array.isArray(state.data.top_expensive) && state.data.top_expensive.length ? state.data.top_expensive : state.lots.filter((l) => isNum(l.price)).sort((a, b) => b.price - a.price).slice(0, 10));
    const list = clear($("topList"));
    if (!top.length) list.append(h("li", { class: "empty", text: "Нет лотов с ценой." }));
    top.forEach((l) => list.append(lotItem(l, price(l.price), "#" + l.lot_id + (l.rarity ? " · " + l.rarity : ""))));
  }

  // ---------- sales (only when the file really contains confirmed data) ----------
  function renderSales() {
    const sales = state.data.sales, panel = $("salesPanel");
    if (!sales || !sales.summary || !isNum(sales.summary.count) || sales.summary.count < 1) { panel.classList.add("hide"); return; }
    panel.classList.remove("hide");
    const sm = sales.summary, body = clear($("salesBody"));
    $("salesNote").textContent = "подтверждённых записей: " + fmt(sm.count);
    body.append(h("div", { class: "cards" }, [card("Продаж в базе", fmt(sm.count), "Цена неизвестна у " + fmt(sm.unknown || 0)), card("Медианная цена продажи", price(sm.median), sm.enough_data ? "Выборка достаточна" : "Выборка мала — ориентир"), card("Диапазон", sm.min != null ? short(sm.min) + "–" + short(sm.max) : "—", "Минимум–максимум")]));
    if (sm.note) body.append(h("p", { class: "muted foot", text: sm.note }));
  }

  // ---------- table ----------
  function fillFacets() {
    const fill = (id, values, label) => {
      const sel = $(id), old = sel.value;
      clear(sel).append(h("option", { value: "", text: label }));
      values.forEach((v) => sel.append(h("option", { value: v, text: v })));
      sel.value = values.indexOf(old) >= 0 ? old : "";
    };
    const uniq = (key) => Array.from(new Set(state.lots.map((l) => l[key]).filter(Boolean))).sort((a, b) => String(a).localeCompare(String(b), "ru"));
    fill("rarity", uniq("rarity"), "Все"); fill("status", uniq("status"), "Все");
  }
  function parseSmartQuery(value) {
    let rest = String(value || "").trim();
    const rules = { terms: [], min: null, max: null, rarity: "", status: "", id: "" };
    rest = rest.replace(/\bprice\s*(<=|>=|<|>)\s*([\d\s.,]+)/gi, (_, op, raw) => {
      const amount = Number(String(raw).replace(/[\s,]/g, ""));
      if (Number.isFinite(amount)) {
        if (op === "<") rules.max = Math.min(rules.max == null ? Infinity : rules.max, amount - Math.max(Number.EPSILON, Math.abs(amount) * Number.EPSILON * 2));
        if (op === "<=") rules.max = Math.min(rules.max == null ? Infinity : rules.max, amount);
        if (op === ">") rules.min = Math.max(rules.min == null ? -Infinity : rules.min, amount + Math.max(Number.EPSILON, Math.abs(amount) * Number.EPSILON * 2));
        if (op === ">=") rules.min = Math.max(rules.min == null ? -Infinity : rules.min, amount);
      }
      return " ";
    });
    rest = rest.replace(/(?:\bid:|#)([A-Za-z0-9_-]+)/gi, (_, id) => { rules.id = id; return " "; });
    rest = rest.replace(/\b(rarity|status)\s*:\s*("[^"]+"|'[^']+'|.+?)(?=\s+(?:rarity|status)\s*:|\s+price\s*(?:<=|>=|<|>)|\s+(?:id:|#)[A-Za-z0-9_-]+|$)/gi,
      (_, key, raw) => {
        const val = String(raw).replace(/^["']|["']$/g, "").trim();
        if (key.toLowerCase() === "rarity") rules.rarity = val;
        else rules.status = val;
        return " ";
      });
    rules.terms = rest.toLocaleLowerCase("ru").split(/\s+/).filter(Boolean);
    return rules;
  }

  function applyFilters() {
    const rawQuery = $("search").value.trim();
    const q = parseSmartQuery(rawQuery);
    const raritySelect = $("rarity").value, statusSelect = $("status").value;
    const inputMin = $("pmin").value === "" ? null : Number($("pmin").value);
    const inputMax = $("pmax").value === "" ? null : Number($("pmax").value);
    const lower = Math.max(inputMin == null || !Number.isFinite(inputMin) ? -Infinity : inputMin, q.min == null ? -Infinity : q.min);
    const upper = Math.min(inputMax == null || !Number.isFinite(inputMax) ? Infinity : inputMax, q.max == null ? Infinity : q.max);
    const wantedRarity = raritySelect || q.rarity;
    const wantedStatus = statusSelect || q.status;
    const { key, dir } = state.sort;
    let rows = state.lots.filter((l) => {
      const id = String(l.lot_id);
      const textMatch = q.terms.every((term) => l._text.includes(term));
      const idMatch = !q.id || id.toLowerCase().includes(q.id.toLowerCase());
      const rarityMatch = !wantedRarity || String(l.rarity || "").toLocaleLowerCase("ru").includes(wantedRarity.toLocaleLowerCase("ru"));
      const statusMatch = !wantedStatus || String(l.status || "").toLocaleLowerCase("ru").includes(wantedStatus.toLocaleLowerCase("ru"));
      return textMatch && idMatch && rarityMatch && statusMatch
        && (lower === -Infinity || (l.price != null && l.price >= lower))
        && (upper === Infinity || (l.price != null && l.price <= upper));
    });
    const val = (l) => key === "price" ? l.price
      : key === "lot_count" ? l._lotCount
      : key === "delta" ? l._delta
      : key === "first_seen" ? (l.first_seen && Number.isFinite(Date.parse(l.first_seen)) ? Date.parse(l.first_seen) : null)
      : key === "lot_id" ? String(l.lot_id || "")
      : String(l[key] || "").toLocaleLowerCase("ru");
    rows.sort((a, b) => {
      const x = val(a), y = val(b);
      if (x == null && y == null) return String(a.lot_id).localeCompare(String(b.lot_id), "ru", { numeric: true });
      if (x == null) return 1;
      if (y == null) return -1;
      const compare = (typeof x === "string" ? x.localeCompare(y, "ru", { numeric: true }) : x - y) * dir;
      return compare || String(a.lot_id).localeCompare(String(b.lot_id), "ru", { numeric: true });
    });
    state.view = rows;
    state.page = Math.min(state.page, Math.max(0, Math.ceil(rows.length / PAGE) - 1));
    renderRows();
    updateViewCounts();
  }
  function updateCompareButton(){const b=$("compareSelected");b.textContent="Сравнить ("+state.compareIds.length+"/4)";b.disabled=state.compareIds.length<2;}
  function renderRows(){
    if(state.catalogMode==="gifts"){renderGroupRows();return;}
    $("lotsMode").classList.remove("hide");$("groupsMode").classList.add("hide");
    const body=clear($("rows")),total=state.view.length,pages=Math.max(1,Math.ceil(total/PAGE));
    $("rowCount").textContent="Найдено лотов: "+fmt(total)+" из "+fmt(state.lots.length);
    $("pageInfo").textContent="Страница "+(state.page+1)+" из "+pages;
    $("prev").disabled=state.page===0;$("next").disabled=state.page>=pages-1;
    document.querySelectorAll("#lotsMode th[aria-sort]").forEach(th=>{const b=th.querySelector(".sort");th.setAttribute("aria-sort",b&&b.dataset.key===state.sort.key?(state.sort.dir>0?"ascending":"descending"):"none");});
    if(!total){body.append(h("tr",{},[h("td",{colspan:7,class:"empty",text:"По вашим условиям лотов нет. Измените или сбросьте фильтры."})]));updateCompareButton();return;}
    state.view.slice(state.page*PAGE,(state.page+1)*PAGE).forEach(l=>{
      const img=l.image_url&&/^https:\/\//i.test(l.image_url)?h("img",{class:"thumb",src:l.image_url,alt:"",loading:"lazy",referrerpolicy:"no-referrer"}):h("span",{class:"thumb",text:"🎁","aria-hidden":"true"});
      img.addEventListener("error",()=>img.replaceWith(h("span",{class:"thumb",text:"🎁","aria-hidden":"true"})));
      const delta=l._delta==null?h("span",{class:"muted",text:"—"}):h("span",{class:l._delta<0?"good":"bad",text:(l._delta>0?"+":"")+fmt(l._delta)+"%"});
      const fav=state.favorites.includes(String(l.lot_id));
      const watch=h("button",{class:"watch-btn",type:"button","aria-pressed":String(fav),"aria-label":(fav?"Убрать из избранного ":"Добавить в избранное ")+(l.title||l.lot_id),text:fav?"★":"☆"});
      watch.addEventListener("click",()=>toggleFavorite(l.lot_id));
      const detail=h("button",{class:"btn secondary",type:"button","aria-label":"Подробнее о лоте "+(l.title||l.lot_id),text:"Подробнее"});
      detail.addEventListener("click",()=>openDetail(l,detail));
      const compare=h("input",{class:"compare-check",type:"checkbox","data-compare-id":String(l.lot_id),"aria-label":"Добавить в сравнение: "+(l.title||l.lot_id)});
      compare.checked=state.compareIds.includes(String(l.lot_id));compare.disabled=!compare.checked&&state.compareIds.length>=4;compare.addEventListener("change",()=>toggleCompare(l.lot_id));
      const priceCell=h("td",{class:"price price-cell"},[h("span",{class:"price-value",text:price(l.price)})]);
      const mini=sparkline(l._history);if(mini)priceCell.append(mini);
      body.append(h("tr",{},[
        h("td",{},[h("div",{class:"lot"},[img,h("div",{},[h("strong",{text:l.title||"Без названия"}),h("small",{text:"#"+l.lot_id+(l.serial?" · "+l.serial:"")})])])]),
        priceCell,
        h("td",{},[h("span",{class:"count-pill",text:fmt(l._lotCount)}),h("div",{class:"muted count-sub",text:"той же серии"})]),
        h("td",{},[h("span",{class:"chip",text:l.rarity||"Не указана"}),h("div",{class:"muted",text:l.status||""})]),
        h("td",{},[delta]),h("td",{text:l.first_seen?when(l.first_seen):"—"}),
        h("td",{},[h("div",{class:"lot-actions"},[compare,detail,watch])])
      ]));
    });
    updateCompareButton();
  }

  function buildGiftGroups(rows){
    const groups=new Map();
    (rows||[]).forEach(l=>{
      if(!l||l.active===false||!isNum(l.price)||l.price<=0)return;
      const key=comparableKey(l);
      if(!groups.has(key))groups.set(key,{key,title:String(l.title||"Без названия").trim()||"Без названия",rarity:String(l.rarity||"Не указана"),lots:[],prices:[]});
      const g=groups.get(key);g.lots.push(l);g.prices.push(l.price);
    });
    return Array.from(groups.values()).map(g=>({...g,count:g.prices.length,min:Math.min(...g.prices),median:median(g.prices),max:Math.max(...g.prices)}));
  }

  function renderGroupRows(){
    $("lotsMode").classList.add("hide");$("groupsMode").classList.remove("hide");
    const body=clear($("groupsRows")),groups=buildGiftGroups(state.view),{key,dir}=state.groupSort;
    const value=g=>key==="count"?g.count:key==="min"?g.min:key==="median"?g.median:key==="max"?g.max:String(g[key]||"").toLocaleLowerCase("ru");
    groups.sort((a,b)=>{const x=value(a),y=value(b),cmp=typeof x==="string"?x.localeCompare(y,"ru",{numeric:true}):x-y;return cmp*dir||a.title.localeCompare(b.title,"ru");});
    const pages=Math.max(1,Math.ceil(groups.length/PAGE));
    $("rowCount").textContent="Найдено типов подарков: "+fmt(groups.length)+" · лотов по фильтрам: "+fmt(state.view.length);
    $("pageInfo").textContent="Страница "+(state.page+1)+" из "+pages;$("prev").disabled=state.page===0;$("next").disabled=state.page>=pages-1;
    document.querySelectorAll("#groupsMode th[aria-sort]").forEach(th=>{const b=th.querySelector(".group-sort");th.setAttribute("aria-sort",b&&b.dataset.groupKey===key?(dir>0?"ascending":"descending"):"none");});
    if(!groups.length){body.append(h("tr",{},[h("td",{colspan:7,class:"empty",text:"Под текущие фильтры не попали группы с активными ценами. Попробуй расширить диапазон."})]));updateCompareButton();return;}
    groups.slice(state.page*PAGE,(state.page+1)*PAGE).forEach(g=>{
      const lowest=g.lots.slice().sort((a,b)=>a.price-b.price)[0];
      const gift=h("div",{class:"group-gift"},[h("strong",{text:g.title}),h("small",{text:g.count+" активных лотов"})]);
      if(lowest&&lowest.image_url&&/^https:\/\//i.test(lowest.image_url))gift.prepend(h("img",{class:"thumb group-thumb",src:lowest.image_url,alt:"",loading:"lazy",referrerpolicy:"no-referrer"}));
      const open=h("button",{class:"btn secondary",type:"button","data-group-open":g.key,text:"Показать лоты"});
      open.addEventListener("click",()=>{
        $("search").value=g.title;$("globalSearch").value=g.title;
        $("rarity").value=Array.from($("rarity").options).some(o=>o.value===g.rarity)?g.rarity:"";
        $("status").value="";$("pmin").value="";$("pmax").value="";
        switchCatalogMode("lots");state.page=0;applyFilters();
      });
      body.append(h("tr",{},[
        h("td",{},[gift]),h("td",{},[h("span",{class:"count-pill",text:fmt(g.count)})]),
        h("td",{class:"price",text:price(g.min)}),h("td",{class:"price group-median",text:price(g.median)}),h("td",{class:"price",text:price(g.max)}),
        h("td",{},[h("span",{class:"chip",text:g.rarity})]),h("td",{},[open])
      ]));
    });
    updateCompareButton();
  }

  function switchCatalogMode(mode){
    state.catalogMode=mode==="gifts"?"gifts":"lots";
    document.querySelectorAll("[data-catalog-mode]").forEach(b=>{const active=b.dataset.catalogMode===state.catalogMode;b.classList.toggle("active",active);b.setAttribute("aria-pressed",String(active));});
    setSortMenuOptions();renderRows();
  }

  function setSortMenuOptions(){
    const select=$("sortBy"),keep=state.catalogMode==="gifts"?"group_"+state.groupSort.key+":"+state.groupSort.dir:state.sort.key+":"+state.sort.dir;
    const options=state.catalogMode==="gifts"
      ?[["group_count:-1","Больше лотов в группе"],["group_count:1","Меньше лотов в группе"],["group_min:1","Мин. цена: дешевле"],["group_min:-1","Мин. цена: дороже"],["group_median:1","Медиана: дешевле"],["group_median:-1","Медиана: дороже"],["group_max:1","Макс. цена: дешевле"],["group_max:-1","Макс. цена: дороже"],["group_title:1","Название: А → Я"],["group_title:-1","Название: Я → А"],["group_rarity:1","Редкость: А → Я"],["group_rarity:-1","Редкость: Я → А"]]
      :[["price:1","Цена: дешевле сначала"],["price:-1","Цена: дороже сначала"],["lot_count:-1","Больше похожих лотов"],["lot_count:1","Меньше похожих лотов"],["delta:1","Сильнее подешевели"],["delta:-1","Сильнее подорожали"],["first_seen:-1","Сначала новые"],["first_seen:1","Сначала старые"],["title:1","Название: А → Я"],["title:-1","Название: Я → А"],["rarity:1","Редкость: А → Я"],["rarity:-1","Редкость: Я → А"],["lot_id:-1","ID лота: новые ID"],["lot_id:1","ID лота: старые ID"]];
    clear(select);options.forEach(([value,label])=>select.append(h("option",{value,text:label})));
    if(!options.some(([value])=>value===keep))select.value=options[0][0];else select.value=keep;
  }

  function toggleCompare(lotId){
    const id=String(lotId);
    if(state.compareIds.includes(id))state.compareIds=state.compareIds.filter(x=>x!==id);
    else if(state.compareIds.length<4)state.compareIds.push(id);
    renderRows();
  }

  function openComparison(){
    const lots=state.compareIds.map(id=>state.lots.find(l=>String(l.lot_id)===id)).filter(Boolean);
    if(lots.length<2||lots.length>4)return;
    const body=clear($("compareBody")),headers=[h("th",{scope:"col",text:"Параметр"}),...lots.map(l=>h("th",{scope:"col",text:(l.title||"Лот")+" #"+l.lot_id}))],tbody=h("tbody");
    const fields=[
      ["Цена",l=>price(l.price)],["Редкость",l=>l.rarity||"—"],["Серия",l=>l.serial||"—"],["Статус",l=>l.status||"—"],
      ["Активные аналоги",l=>fmt(l._lotCount)],["Целевая цена",l=>state.targets[String(l.lot_id)]?price(state.targets[String(l.lot_id)]):"Не задана"],
      ["Изменение цены",l=>l._delta==null?"—":(l._delta>0?"+":"")+fmt(l._delta)+"%"]
    ];
    fields.forEach(([label,get])=>tbody.append(h("tr",{},[h("th",{scope:"row",text:label}),...lots.map(l=>h("td",{text:get(l)}))])));
    tbody.append(h("tr",{},[h("th",{scope:"row",text:"История цены"}),...lots.map(l=>{const td=h("td"),mini=sparkline(l._history);td.append(mini||h("span",{class:"muted",text:"Мало данных"}));return td;})]));
    body.append(h("div",{class:"table-wrap comparison-wrap"},[h("table",{class:"comparison-table"},[h("caption",{class:"sr",text:"Сравнение выбранных лотов"}),h("thead",{},[h("tr",{},headers)]),tbody])]));
    const dialog=$("compareDialog");if(typeof dialog.showModal==="function")dialog.showModal();else dialog.setAttribute("open","");
  }

    // ---------- lot detail ----------
  let lastTrigger = null;
  function openDetail(l, trigger) {
    lastTrigger = trigger;
    $("dTitle").textContent = l.title || ("Лот #" + l.lot_id);
    const body = clear($("dBody"));
    const img = l.image_url && /^https:\/\//i.test(l.image_url) ? h("img", { class: "thumb", src: l.image_url, alt: "", referrerpolicy: "no-referrer" }) : h("span", { class: "thumb", text: "🎁", "aria-hidden": "true" });
    body.append(h("div", { class: "dl-top" }, [img, h("div", {}, [h("div", { class: "price", text: price(l.price) }), h("div", { class: "muted", text: "Цена объявления, не цена сделки" })])]));
    // comparable group: same title & rarity, only when big enough
    const group = state.lots.filter((x) => x.title === l.title && x.rarity === l.rarity && isNum(x.price)).map((x) => x.price).sort((a, b) => a - b);
    let cmp = "Недостаточно сопоставимых лотов (" + group.length + " из 5 нужных)";
    if (group.length >= 5 && isNum(l.price)) { const m = median(group); cmp = "Медиана группы " + fmt(m) + " ◉ (" + group.length + " лотов); этот лот " + (l.price < m ? "дешевле" : l.price > m ? "дороже" : "равен") + " медианы на " + fmt(Math.abs(l.price - m) / m * 100) + "%"; }
    const kv = [["ID", "#" + l.lot_id], ["Серия", l.serial || "—"], ["Редкость", l.rarity || "—"], ["Статус", l.status || "—"], ["Впервые замечен", when(l.first_seen)], ["Последний раз виден", when(l.last_seen)], ["Сравнение с аналогами", cmp]];
    body.append(h("dl", { class: "kv" }, kv.map((p) => h("div", {}, [h("dt", { text: p[0] }), h("dd", { text: p[1] })]))));
    const watch=h("div",{class:"detail-watch"});
    const fav=h("button",{class:"btn secondary",type:"button",text:state.favorites.includes(String(l.lot_id))?"★ В избранном":"☆ В избранное"});
    fav.addEventListener("click",()=>{toggleFavorite(l.lot_id);fav.textContent=state.favorites.includes(String(l.lot_id))?"★ В избранном":"☆ В избранное";});
    const target=h("input",{class:"input target-input",type:"number",min:"1",step:"1",inputmode:"numeric",placeholder:"Целевая цена","aria-label":"Целевая цена для "+(l.title||l.lot_id)});
    target.value=state.targets[String(l.lot_id)]?String(state.targets[String(l.lot_id)]):"";
    const save=h("button",{class:"btn",type:"button",text:"Сохранить цену-цель"});
    save.addEventListener("click",()=>{if(saveTarget(l.lot_id,target.value))save.textContent=target.value.trim()?"Цена-цель сохранена":"Цель удалена";});
    watch.append(fav,target,save);body.append(watch);
    body.append(h("h4", { text: "История цены" }));
    const hist = l._history, chart = h("div", { class: "chart" });
    body.append(chart);
    if (hist.length < 2) chart.append(h("div", { class: "empty", text: hist.length ? "Цена пока не менялась с первого наблюдения: " + price(hist[0].price) + " (" + when(hist[0].observed_at) + ")." : "История цены ещё не накоплена." }));
    else {
      lineChart(chart, hist.map((p) => ({ label: dayLabel(p.observed_at), value: p.price })), "История цены лота");
      const tbl = h("table", { class: "hist" }, [h("caption", { class: "sr", text: "История цены" }), h("tbody", {}, hist.slice().reverse().map((p) => h("tr", {}, [h("td", { text: when(p.observed_at) }), h("td", { class: "price", text: price(p.price) })])))]);
      body.append(tbl);
    }
    body.append(h("p", {}, [h("a", { class: "btn", href: safeUrl(l.lot_url, l.lot_id), target: "_blank", rel: "noopener noreferrer", text: "Открыть лот на Huevo ↗" })]));
    const dlg = $("detail");
    if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
  }

  function switchView(view, focusSearch) {
    const allowed = new Set(["overview", "market", "deals", "cheap", "analytics", "favorites", "support"]);
    state.activeView = allowed.has(view) ? view : "overview";
    document.querySelectorAll("[data-view-section]").forEach((section) => {
      section.classList.toggle("view-hidden", section.getAttribute("data-view-section") !== state.activeView);
    });
    document.querySelectorAll("#mainNav [data-view]").forEach((button) => {
      button.setAttribute("aria-selected", String(button.dataset.view === state.activeView));
      button.tabIndex = button.dataset.view === state.activeView ? 0 : -1;
    });
    if (focusSearch && state.activeView === "market") $("search").focus({ preventScroll: true });
    updateViewCounts();
  }

  function updateViewCounts() {
    const set = (id, value) => { const el = $(id); if (el) el.textContent = value; };
    set("navMarketCount", fmt(state.lots.length));
    set("navDealsCount", fmt(buildDealSignals().length));
    set("navCheapCount", fmt(state.lots.filter((lot) => isNum(lot.price) && lot.price > 0).length));
    set("navFavoritesCount", fmt(state.favorites.length));
    set("favoritesCount", fmt(state.favorites.length) + " лотов");
    set("cheapCount", fmt(state.lots.filter((lot) => isNum(lot.price) && lot.price > 0).length) + " лотов");
    set("marketStat", fmt(state.lots.length) + " лотов");
    set("dealsCount", fmt(buildDealSignals().length) + " сигналов");
    set("belowStat", fmt(buildDealSignals().length) + " сигналов");
  }

  function buildDealSignals() {
    const groups = new Map();
    const active = state.lots.filter((lot) => lot && lot.active !== false && isNum(lot.price) && lot.price > 0 && String(lot.title || "").trim());
    for (const lot of active) {
      const title = String(lot.title || "").trim().toLocaleLowerCase("ru").replace(/\s+/g, " ");
      const rarity = String(lot.rarity || "").trim().toLocaleLowerCase("ru");
      const key = title + "\u0000" + rarity;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(lot);
    }
    const signals = [];
    for (const group of groups.values()) {
      if (group.length < 3) continue;
      const reference = median(group.map((lot) => lot.price));
      if (!isNum(reference) || reference <= 0) continue;
      for (const lot of group) {
        if (lot.price >= reference * 0.85) continue;
        const discount = Math.round((1 - lot.price / reference) * 1000) / 10;
        signals.push({
          ...lot,
          reference_price: reference,
          discount_pct: discount,
          sample_size: group.length,
          basis: "active",
        });
      }
    }
    signals.sort((a, b) => b.discount_pct - a.discount_pct || a.price - b.price || String(a.title).localeCompare(String(b.title), "ru"));
    return signals;
  }

  function compactSignalItem(lot, sub, badge, linkLabel) {
    const badgeEl = h("span", { class: "discount-tag", text: badge || price(lot.price) });
    const actions = h("div", { class: "deal-actions" }, [
      badgeEl,
      h("a", { class: "btn secondary", href: safeUrl(lot.lot_url, lot.lot_id), target: "_blank", rel: "noopener noreferrer", text: linkLabel || "Открыть ↗" })
    ]);
    const row = lotItem(lot, actions, sub);
    row.classList.add("deal-row");
    return row;
  }

  function renderDeals() {
    const deals = buildDealSignals();
    const best = deals[0] || null;
    const list = clear($("dealsList"));
    $("dealsCount").textContent = fmt(deals.length) + " сигналов";
    $("dealsNote").textContent = deals.length ? "Сравнение с медианой аналогов" : "Пока нет подтверждённой группы аналогов";
    $("belowBest").classList.toggle("hide", !best);
    if (best) {
      $("belowBestTitle").textContent = best.title || ("Лот #" + best.lot_id);
      $("belowBestPrice").textContent = price(best.price);
      $("belowBestMeta").textContent = "На " + fmt(best.discount_pct) + "% ниже медианы " + price(best.reference_price) + " · " + fmt(best.sample_size) + " похожих лотов · #" + best.lot_id;
      $("belowBestOpen").href = safeUrl(best.lot_url, best.lot_id);
      $("overviewPickHint").textContent = "Лучшее текущее отклонение от медианы аналогов: −" + fmt(best.discount_pct) + "%.";
      const pick = clear($("overviewPickLot"));
      if (best.image_url && /^https:\/\//i.test(best.image_url)) {
        const img = h("img", { class: "pick-img", src: best.image_url, alt: "", loading: "lazy", referrerpolicy: "no-referrer" });
        img.addEventListener("error", () => img.replaceWith(h("span", { class: "pick-img", text: "🎁" })));
        pick.append(img);
      }
      pick.append(h("div", {}, [
        h("strong", { text: best.title || ("Лот #" + best.lot_id) }),
        h("span", { class: "pick-price", text: price(best.price) }),
        h("small", { text: "−" + fmt(best.discount_pct) + "% к медиане похожих лотов · #" + best.lot_id })
      ]));
      deals.slice(1, 31).forEach((lot) => list.append(compactSignalItem(
        lot,
        "#" + lot.lot_id + (lot.rarity ? " · " + lot.rarity : "") + " · ориентир " + price(lot.reference_price),
        "−" + fmt(lot.discount_pct) + "%",
        "Лот ↗"
      )));
    } else {
      $("belowBestTitle").textContent = "Пока нет уверенного кандидата";
      $("belowBestPrice").textContent = "—";
      $("belowBestMeta").textContent = "Нужно минимум три похожих активных предложения и разница не менее 15%.";
      $("belowBestOpen").href = "https://huevo.su/market/gifts";
      $("overviewPickHint").textContent = "Когда в каталоге появится группа сопоставимых лотов, здесь отобразится лучший текущий ценовой разрыв.";
      const pick = clear($("overviewPickLot"));
      pick.append(h("span", { class: "muted", text: "Пока нет группы аналогов для честного сравнения." }));
      list.append(h("li", { class: "empty", text: "Нет лотов, цена которых минимум на 15% ниже медианы трёх или более похожих активных предложений." }));
    }
    updateViewCounts();
  }

  function renderCheapest() {
    const list = clear($("cheapestList"));
    const cheap = state.lots.filter((lot) => lot && lot.active !== false && isNum(lot.price) && lot.price > 0)
      .slice().sort((a, b) => a.price - b.price || String(a.title).localeCompare(String(b.title), "ru")).slice(0, 60);
    $("cheapCount").textContent = fmt(cheap.length) + " показано";
    if (!cheap.length) list.append(h("li", { class: "empty", text: "В снимке пока нет лотов с ценой." }));
    cheap.forEach((lot, index) => list.append(compactSignalItem(
      lot,
      "#" + lot.lot_id + (lot.rarity ? " · " + lot.rarity : ""),
      "#" + (index + 1) + " · " + price(lot.price),
      "Открыть ↗"
    )));
  }

  function renderFavorites() {
    const list=clear($("favoritesList")),ids=new Set(state.favorites.map(String)),found=state.lots.filter(l=>ids.has(String(l.lot_id)));
    $("favoritesCount").textContent=fmt(state.favorites.length)+" лотов";$("navFavoritesCount").textContent=fmt(state.favorites.length);
    const targets=Object.keys(state.targets).filter(id=>ids.has(id)).length;
    const reached=found.filter(l=>isNum(state.targets[String(l.lot_id)])&&isNum(l.price)&&l.active!==false&&l.price<=state.targets[String(l.lot_id)]).length;
    $("notificationHint").textContent=targets?targets+" целевых цен сохранено"+(reached?" · цель достигнута у "+reached+" лотов":"")+". Проверяем при обновлении данных.":"Добавь лот в избранное и задай цену, при которой хочешь получить сигнал.";
    updateNotificationButton();
    if(!found.length){list.append(h("li",{class:"empty",text:state.favorites.length?"Сохранённые лоты не попали в текущий снимок. Они останутся в избранном и появятся при следующем обнаружении.":"Пока пусто. Нажми ☆ в каталоге, чтобы сохранить лот в этом браузере."}));return;}
    found.slice().sort((a,b)=>(a.price??Infinity)-(b.price??Infinity)).forEach(lot=>{
      const id=String(lot.lot_id),target=state.targets[id];
      const actions=h("div",{class:"deal-actions"},[
        h("span",{class:"discount-tag",text:price(lot.price)}),
        h("button",{class:"btn secondary",type:"button",text:"Убрать ☆","aria-label":"Убрать из избранного "+lot.title})
      ]);
      actions.querySelector("button").addEventListener("click",()=>toggleFavorite(lot.lot_id));
      const row=lotItem(lot,actions,"#"+lot.lot_id+(lot.rarity?" · "+lot.rarity:""));row.classList.add("deal-row");
      const input=h("input",{class:"input target-input",type:"number",min:"1",step:"1",inputmode:"numeric",placeholder:"Цена-цель","aria-label":"Целевая цена для "+(lot.title||lot.lot_id)});
      input.value=target?String(target):"";
      const save=h("button",{class:"btn secondary target-save",type:"button",text:target?"Обновить цель":"Задать цель"});
      save.addEventListener("click",()=>saveTarget(lot.lot_id,input.value));
      const status=h("small",{class:"target-status",text:target?(lot.active!==false&&isNum(lot.price)&&lot.price<=target?"ЦЕЛЬ ДОСТИГНУТА":"Цель: "+price(target)):"Целевой цены нет"});
      row.children[1].append(h("div",{class:"target-editor"},[input,save,status]));list.append(row);
    });
  }

  function updateNotificationButton(){
    const b=$("enableNotifications");
    if(!("Notification" in window)){b.disabled=true;b.textContent="Уведомления недоступны";return;}
    b.disabled=Notification.permission==="granted";
    b.textContent=Notification.permission==="granted"?"Уведомления включены":Notification.permission==="denied"?"Разреши в настройках браузера":"Включить уведомления";
  }

  function showWatchAlert(lot){
    const text=(lot.title||("Лот #"+lot.lot_id))+" достиг целевой цены: "+price(lot.price)+" (цель "+price(state.targets[String(lot.lot_id)])+").";
    $("watchAlertText").textContent=text;$("watchAlert").classList.remove("hide");
    if("Notification" in window&&Notification.permission==="granted"){try{new Notification("AMNYAM MODE · цена-цель",{body:text,tag:"amnyam-target-"+lot.lot_id});}catch(_){}}
  }

  function checkTargetAlerts(){
    let changed=false;
    Object.entries(state.targets).forEach(([id,target])=>{
      const lot=state.lots.find(l=>String(l.lot_id)===id);if(!lot||lot.active===false||!isNum(lot.price))return;
      const already=state.alertedTargets.includes(id);
      if(lot.price>target){if(already){state.alertedTargets=state.alertedTargets.filter(v=>v!==id);changed=true;}}
      else if(!already){state.alertedTargets.push(id);changed=true;showWatchAlert(lot);}
    });
    if(changed)writeAlertedTargets();
  }

  function saveTarget(lotId,raw){
    const id=String(lotId),value=String(raw||"").trim()===""?null:Number(raw);
    if(value!==null&&(!Number.isFinite(value)||value<=0)){$("watchAlertText").textContent="Введи целевую цену больше нуля.";$("watchAlert").classList.remove("hide");return false;}
    if(value===null){delete state.targets[id];state.alertedTargets=state.alertedTargets.filter(v=>v!==id);}
    else{state.targets[id]=Math.round(value);if(!state.favorites.includes(id))state.favorites=[...state.favorites,id].slice(-5000);}
    writeTargets();writeAlertedTargets();writeFavorites();checkTargetAlerts();renderFavorites();renderRows();updateViewCounts();return true;
  }

  function toggleFavorite(lotId){
    const id=String(lotId);
    if(state.favorites.includes(id)){state.favorites=state.favorites.filter(v=>v!==id);delete state.targets[id];state.alertedTargets=state.alertedTargets.filter(v=>v!==id);writeTargets();writeAlertedTargets();}
    else state.favorites=[...state.favorites,id].slice(-5000);
    writeFavorites();renderFavorites();updateViewCounts();renderRows();
  }

  function renderSavedFilters(){
    const sel=$("savedFilterSelect"),old=sel.value;clear(sel);sel.append(h("option",{value:"",text:state.savedFilters.length?"Выбери сохранённый набор":"Нет сохранённых наборов"}));
    state.savedFilters.forEach((item,index)=>sel.append(h("option",{value:String(index),text:item.name})));
    if(state.savedFilters.some((item,index)=>String(index)===old))sel.value=old;
    $("applyPreset").disabled=!state.savedFilters.length||sel.value==="";$("deletePreset").disabled=!state.savedFilters.length||sel.value==="";
  }
  function captureFilters(name){return{name,filters:{search:$("search").value,rarity:$("rarity").value,status:$("status").value,pmin:$("pmin").value,pmax:$("pmax").value,mode:state.catalogMode,sort:{...state.sort},groupSort:{...state.groupSort}}};}
  function saveFilterPreset(){
    const name=$("presetName").value.trim();if(!name){$("presetStatus").textContent="Введи название набора.";return;}
    const same=state.savedFilters.findIndex(item=>item.name.toLocaleLowerCase("ru")===name.toLocaleLowerCase("ru")),item=captureFilters(name);
    if(same>=0)state.savedFilters[same]=item;else if(state.savedFilters.length<25)state.savedFilters.push(item);else{$("presetStatus").textContent="Можно сохранить до 25 наборов.";return;}
    writeSavedFilters();renderSavedFilters();$("savedFilterSelect").value=String(same>=0?same:state.savedFilters.length-1);
    $("applyPreset").disabled=false;$("deletePreset").disabled=false;$("presetStatus").textContent="Набор «"+name+"» сохранён.";
  }
  function applyFilterPreset(){
    const index=Number($("savedFilterSelect").value),item=state.savedFilters[index];if(!item)return;
    const f=item.filters||{};$("search").value=f.search||"";$("globalSearch").value=f.search||"";
    $("rarity").value=Array.from($("rarity").options).some(o=>o.value===(f.rarity||""))?(f.rarity||""):"";
    $("status").value=Array.from($("status").options).some(o=>o.value===(f.status||""))?(f.status||""):"";
    $("pmin").value=f.pmin||"";$("pmax").value=f.pmax||"";
    if(f.sort&&typeof f.sort.key==="string"&&Number.isFinite(f.sort.dir))state.sort={key:f.sort.key,dir:f.sort.dir};
    if(f.groupSort&&typeof f.groupSort.key==="string"&&Number.isFinite(f.groupSort.dir))state.groupSort={key:f.groupSort.key,dir:f.groupSort.dir};
    state.page=0;switchCatalogMode(f.mode==="gifts"?"gifts":"lots");setSortMenuOptions();applyFilters();$("presetStatus").textContent="Применён набор «"+item.name+"».";$("presetName").value=item.name;
  }
  function deleteFilterPreset(){
    const index=Number($("savedFilterSelect").value);if(!Number.isInteger(index)||!state.savedFilters[index])return;
    const name=state.savedFilters[index].name;state.savedFilters.splice(index,1);writeSavedFilters();renderSavedFilters();$("presetStatus").textContent="Набор «"+name+"» удалён.";
  }

  async function requestSupportApi(path, options) {
    const response = await fetch(path, { cache: "no-store", ...(options || {}) });
    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error(data.detail || data.error || ("HTTP " + response.status));
    return data;
  }

  function supportMessage(message, kind) {
    const box = $("supportMsg");
    box.textContent = message || "";
    box.hidden = !message;
    box.className = "support-message" + (kind ? " " + kind : "");
  }

  function renderSupportLevels() {
    const box = clear($("supportAmounts"));
    const labels = {
      5000: "SCOUT",
      10000: "BUILDER",
      25000: "WORKER",
      50000: "HARD MODE",
      100000: "AMNYAM OG"
    };
    (supportConfig.amounts || [5000, 10000, 25000, 50000, 100000]).forEach((amount, index) => {
      const button = h("button", { class: "support-level", type: "button", "data-amount": String(amount) }, [
        h("span", { class: "support-tier-num", text: "LEVEL / 0" + (index + 1) }),
        h("b", { text: fmt(amount) + " ◉" }),
        h("small", { text: labels[amount] || "SUPPORT" })
      ]);
      box.append(button);
    });
  }

  async function initSupport() {
    if (supportInitRunning) return;
    supportInitRunning = true;
    renderSupportLevels();
    const inHuevo = new URLSearchParams(location.search).has("hu_user_id");
    try {
      supportConfig = await requestSupportApi("./api/support/config");
    } catch (_) {
      supportConfig = { enabled: false, amounts: [5000, 10000, 25000, 50000, 100000], origins: ["https://huevo.su", "https://huevo.departament.site"] };
    }
    renderSupportLevels();
    try {
      const stats = await requestSupportApi("./api/support/stats");
      $("supporters").textContent = fmt(Number(stats.supporters) || 0);
      $("supportTotal").textContent = fmt(Number(stats.total) || 0);
    } catch (_) {
      $("supporters").textContent = "—";
      $("supportTotal").textContent = "—";
    }
    if (!supportConfig.enabled) {
      $("supportHint").textContent = "Поддержка временно недоступна: проверь настройки huEVO Apps и миграцию support_payments.";
    } else if (!inHuevo) {
      $("supportHint").textContent = "Выбери уровень поддержки, когда AMNYAM MODE открыт внутри huEVO как приложение. Только там доступен подтверждённый аккаунт и официальное окно платежа.";
    } else {
      $("supportHint").textContent = "Платёж будет создан на сервере и подтверждён официальным окном huEVO. Выбирай уровень ниже.";
      try {
        if (!window.huevo) {
          await new Promise((resolve) => {
            const script = document.createElement("script");
            script.src = supportConfig.sdk_url || "https://huevo.su/static/js/huevo-apps-v1.js";
            script.onload = resolve;
            script.onerror = resolve;
            document.head.appendChild(script);
          });
        }
        if (window.huevo && typeof window.huevo.init === "function") {
          await window.huevo.init({ origins: supportConfig.origins || ["https://huevo.su", "https://huevo.departament.site"] });
          supportSdkReady = true;
        }
        if (!supportSdkReady) $("supportHint").textContent = "Не удалось подключить SDK huEVO. Открой панель через huEVO и попробуй ещё раз.";
      } catch (_) {
        $("supportHint").textContent = "Не удалось подключить SDK huEVO. Открой панель через huEVO и попробуй ещё раз.";
      }
    }
    supportInitRunning = false;
  }

  async function makeSupportPayment(amount) {
    const inHuevo = new URLSearchParams(location.search).has("hu_user_id");
    if (!supportConfig.enabled) return supportMessage("Приём поддержки не настроен. Проверь настройки huEVO Apps.", "error");
    if (!inHuevo || !supportSdkReady || !window.huevo) return supportMessage("Для оплаты открой AMNYAM MODE внутри huEVO как приложение.", "error");
    const buttons = Array.from(document.querySelectorAll("#supportAmounts [data-amount]"));
    buttons.forEach((button) => { button.disabled = true; });
    try {
      supportMessage("Создаём запрос на поддержку…");
      const intent = await requestSupportApi("./api/support/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ amount: Number(amount), launch_query: location.search })
      });
      supportMessage("Подтверди платёж в официальном окне huEVO" + (intent.test ? " (тестовый режим)." : "."));
      try { await window.huevo.confirmPayment(intent.intent_id); } catch (_) {}
      let status = "pending";
      for (let attempt = 0; attempt < 40 && status === "pending"; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const result = await requestSupportApi("./api/support/status/" + encodeURIComponent(intent.intent_id));
        status = result.status;
      }
      if (status === "succeeded") supportMessage(intent.test ? "Тестовый платёж подтверждён. Спасибо!" : "Поддержка подтверждена сервером. Спасибо!", "good");
      else if (status === "pending") supportMessage("Платёж пока не подтверждён. Статус проверяется отдельно; проверь окно huEVO.");
      else supportMessage("Платёж завершился со статусом: " + status + ".", "error");
      const stats = await requestSupportApi("./api/support/stats");
      $("supporters").textContent = fmt(Number(stats.supporters) || 0);
      $("supportTotal").textContent = fmt(Number(stats.total) || 0);
    } catch (error) {
      supportMessage(error && error.message ? error.message : "Не удалось создать платёж.", "error");
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  // ---------- main render ----------
  function render() {
    renderState();
    if (!state.lots.length) {
      const c = state.data.collector || {};
      $("emptyText").textContent = c.status && c.status !== "ok"
        ? "Каталог пуст: " + (c.message || c.status) + ". Статистика не показывается, чтобы не выдавать пустые значения за реальные."
        : "Первый полный сбор ещё не опубликован. Статистика не показывается, чтобы не выдавать пустые значения за реальные.";
      show("empty");
      switchView(state.activeView);
      return;
    }
    show("content");
    checkTargetAlerts();
    renderDeals(); renderCheapest(); renderFavorites();
    renderCards(); renderCharts(); renderChanges(); renderTop(); renderSales(); fillFacets();
    renderSavedFilters();setSortMenuOptions();applyFilters();
    switchView(state.activeView);
  }

  // ---------- events ----------
  document.querySelectorAll("#mainNav [data-view]").forEach(button=>button.addEventListener("click",()=>switchView(button.dataset.view,true)));
  document.querySelectorAll("[data-go-view]").forEach(button=>button.addEventListener("click",()=>switchView(button.dataset.goView,true)));
  $("globalSearch").addEventListener("keydown",event=>{if(event.key!=="Enter")return;event.preventDefault();$("search").value=$("globalSearch").value.trim();state.page=0;switchView("market",true);applyFilters();});
  document.querySelectorAll("[data-search-token]").forEach(button=>button.addEventListener("click",()=>{
    const token=button.dataset.searchToken||"",input=$("search");input.value=(input.value.trim()+" "+token).trim();$("globalSearch").value=input.value;state.page=0;switchView("market",true);applyFilters();
  }));
  $("supportAmounts").addEventListener("click",event=>{const b=event.target.closest("[data-amount]");if(b&&!b.disabled)makeSupportPayment(b.dataset.amount);});
  document.querySelectorAll("[data-catalog-mode]").forEach(b=>b.addEventListener("click",()=>switchCatalogMode(b.dataset.catalogMode)));
  ["search","pmin","pmax"].forEach(id=>$(id).addEventListener("input",()=>{state.page=0;$("globalSearch").value=$("search").value;applyFilters();}));
  ["rarity","status"].forEach(id=>$(id).addEventListener("change",()=>{state.page=0;applyFilters();}));
  $("filters").addEventListener("submit",e=>e.preventDefault());
  $("reset").addEventListener("click",()=>{["search","pmin","pmax","rarity","status","globalSearch"].forEach(id=>{$(id).value="";});state.sort={key:"price",dir:1};state.groupSort={key:"count",dir:-1};state.page=0;setSortMenuOptions();applyFilters();renderRows();});
  $("sortBy").addEventListener("change",()=>{
    const [rawKey,rawDir]=$("sortBy").value.split(":"),dir=Number(rawDir)||1;
    if(state.catalogMode==="gifts"){state.groupSort={key:rawKey.replace(/^group_/,""),dir};renderRows();}
    else{state.sort={key:rawKey,dir};state.page=0;applyFilters();}
  });
  document.querySelectorAll("#lotsMode .sort").forEach(b=>b.addEventListener("click",()=>{
    const key=b.dataset.key,defaults={title:1,price:1,rarity:1,delta:1,first_seen:-1,lot_count:-1,lot_id:-1};
    state.sort={key,dir:state.sort.key===key?-state.sort.dir:defaults[key]};$("sortBy").value=key+":"+state.sort.dir;state.page=0;applyFilters();
  }));
  document.querySelectorAll("#groupsMode .group-sort").forEach(b=>b.addEventListener("click",()=>{
    const key=b.dataset.groupKey,defaults={title:1,count:-1,min:1,median:1,max:1,rarity:1};
    state.groupSort={key,dir:state.groupSort.key===key?-state.groupSort.dir:defaults[key]};$("sortBy").value="group_"+key+":"+state.groupSort.dir;state.page=0;renderRows();
  }));
  $("prev").addEventListener("click",()=>{state.page=Math.max(0,state.page-1);renderRows();});
  $("next").addEventListener("click",()=>{state.page+=1;renderRows();});
  document.querySelectorAll(".tabs [role=tab]").forEach(t=>t.addEventListener("click",()=>{state.changeKind=t.dataset.kind;renderChanges();}));
  $("retry").addEventListener("click",load);
  $("dClose").addEventListener("click",()=>$("detail").close());
  $("detail").addEventListener("close",()=>{if(lastTrigger&&document.contains(lastTrigger))lastTrigger.focus();});
  $("detail").addEventListener("click",e=>{if(e.target===$("detail"))$("detail").close();});
  $("savePreset").addEventListener("click",saveFilterPreset);$("applyPreset").addEventListener("click",applyFilterPreset);$("deletePreset").addEventListener("click",deleteFilterPreset);
  $("savedFilterSelect").addEventListener("change",()=>{
    const index=Number($("savedFilterSelect").value),item=state.savedFilters[index];$("applyPreset").disabled=!item;$("deletePreset").disabled=!item;if(item)$("presetName").value=item.name;
  });
  $("enableNotifications").addEventListener("click",async()=>{
    if(!("Notification" in window))return;try{await Notification.requestPermission();}catch(_){}
    updateNotificationButton();$("notificationHint").textContent=Notification.permission==="granted"?"Браузерные уведомления разрешены; цели проверяются при обновлении данных.":Notification.permission==="denied"?"Разрешение запрещено. Включи уведомления для сайта в настройках браузера.":"Разрешение не получено; сообщения остаются внутри приложения.";
  });
  $("closeWatchAlert").addEventListener("click",()=>$("watchAlert").classList.add("hide"));
  $("compareSelected").addEventListener("click",openComparison);$("compareClose").addEventListener("click",()=>$("compareDialog").close());
  $("compareDialog").addEventListener("click",e=>{if(e.target===$("compareDialog"))$("compareDialog").close();});
  load();
  initSupport();
  pollLive();
  window.setInterval(pollLive, 3000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { pollLive(); } });
})();
