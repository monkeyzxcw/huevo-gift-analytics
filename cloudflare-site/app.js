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
  function writeFavorites() {
    try { localStorage.setItem("amnyam.favorites", JSON.stringify(state.favorites)); } catch (_) {}
  }
  const state = {
    data: null, lots: [], view: [], page: 0,
    sort: { key: "price", dir: 1 }, changeKind: "new", liveFingerprint: null,
    activeView: "overview", favorites: readFavorites()
  };
  let livePollRunning = false;
  let lastSnapshotSignature = "";
  let supportConfig = { enabled: false, amounts: [5000, 10000, 25000, 50000, 100000] };
  let supportSdkReady = false;
  let supportInitRunning = false;

  // ---------- load & normalise (tolerates partial / old JSON) ----------
  function normalise(d) {
    const raw = d && typeof d === "object" && !Array.isArray(d) ? d : {};
    const lots = (Array.isArray(raw.lots) ? raw.lots : []).filter((l) => l && typeof l === "object" && l.lot_id != null).map((l) => {
      const hist = Array.isArray(l.history) ? l.history.filter((p) => p && isNum(p.price)) : [];
      let delta = null;
      if (hist.length > 1 && hist[hist.length - 2].price > 0) delta = (hist[hist.length - 1].price - hist[hist.length - 2].price) / hist[hist.length - 2].price * 100;
      return Object.assign({}, l, { price: isNum(l.price) ? l.price : null, _history: hist, _delta: delta, _text: [l.lot_id, l.title, l.serial, l.rarity, l.status].join(" ").toLocaleLowerCase("ru") });
    });
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
    rest = rest.replace(/\b(?:id:|#)([A-Za-z0-9_-]+)/gi, (_, id) => { rules.id = id; return " "; });
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
    const val = (l) => key === "price" ? l.price : key === "delta" ? l._delta : key === "first_seen" ? (l.first_seen ? Date.parse(l.first_seen) : null) : String(l[key] || "").toLocaleLowerCase("ru");
    rows.sort((a, b) => {
      const x = val(a), y = val(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === "string" ? x.localeCompare(y, "ru") : x - y) * dir;
    });
    state.view = rows;
    state.page = Math.min(state.page, Math.max(0, Math.ceil(rows.length / PAGE) - 1));
    renderRows();
    updateViewCounts();
  }
  function renderRows() {
    const body = clear($("rows")), total = state.view.length, pages = Math.max(1, Math.ceil(total / PAGE));
    $("rowCount").textContent = "Найдено лотов: " + fmt(total) + " из " + fmt(state.lots.length);
    $("pageInfo").textContent = "Страница " + (state.page + 1) + " из " + pages;
    $("prev").disabled = state.page === 0; $("next").disabled = state.page >= pages - 1;
    document.querySelectorAll("th[aria-sort]").forEach((th) => {
      const b = th.querySelector(".sort");
      th.setAttribute("aria-sort", b && b.dataset.key === state.sort.key ? (state.sort.dir > 0 ? "ascending" : "descending") : "none");
    });
    if (!total) { body.append(h("tr", {}, [h("td", { colspan: 6, class: "empty", text: "По вашим условиям лотов нет. Измените или сбросьте фильтры." })])); return; }
    state.view.slice(state.page * PAGE, (state.page + 1) * PAGE).forEach((l) => {
      const img = l.image_url && /^https:\/\//i.test(l.image_url) ? h("img", { class: "thumb", src: l.image_url, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }) : h("span", { class: "thumb", text: "🎁", "aria-hidden": "true" });
      img.addEventListener("error", () => img.replaceWith(h("span", { class: "thumb", text: "🎁", "aria-hidden": "true" })));
      const delta = l._delta == null ? h("span", { class: "muted", text: "—" }) : h("span", { class: l._delta < 0 ? "good" : "bad", text: (l._delta > 0 ? "+" : "") + fmt(l._delta) + "%" });
      const isFavorite = state.favorites.includes(String(l.lot_id));
      const watch = h("button", { class: "watch-btn", type: "button", "aria-pressed": String(isFavorite), "aria-label": (isFavorite ? "Убрать из избранного " : "Добавить в избранное ") + (l.title || l.lot_id), text: isFavorite ? "★" : "☆" });
      watch.addEventListener("click", () => toggleFavorite(l.lot_id));
      const btn = h("button", { class: "btn secondary", type: "button", "aria-label": "Подробнее о лоте " + (l.title || l.lot_id), text: "Подробнее" });
      btn.addEventListener("click", () => openDetail(l, btn));
      body.append(h("tr", {}, [
        h("td", {}, [h("div", { class: "lot" }, [img, h("div", {}, [h("strong", { text: l.title || "Без названия" }), h("small", { text: "#" + l.lot_id + (l.serial ? " · " + l.serial : "") })])])]),
        h("td", { class: "price", text: price(l.price) }),
        h("td", {}, [h("span", { class: "chip", text: l.rarity || "Не указана" }), h("div", { class: "muted", text: l.status || "" })]),
        h("td", {}, [delta]),
        h("td", { text: l.first_seen ? when(l.first_seen) : "—" }),
        h("td", {}, [btn, watch]),
      ]));
    });
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
      section.classList.toggle("hide", section.getAttribute("data-view-section") !== state.activeView);
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
    const list = clear($("favoritesList"));
    const ids = new Set(state.favorites.map(String));
    const found = state.lots.filter((lot) => ids.has(String(lot.lot_id)));
    $("favoritesCount").textContent = fmt(state.favorites.length) + " лотов";
    $("navFavoritesCount").textContent = fmt(state.favorites.length);
    if (!found.length) {
      list.append(h("li", { class: "empty", text: state.favorites.length ? "Сохранённые лоты не попали в текущий снимок. Они останутся в избранном и появятся при следующем обнаружении." : "Пока пусто. Нажми ☆ в каталоге, чтобы сохранить лот в этом браузере." }));
      return;
    }
    found.slice().sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity)).forEach((lot) => {
      const actions = h("div", { class: "deal-actions" }, [
        h("span", { class: "discount-tag", text: price(lot.price) }),
        h("button", { class: "btn secondary", type: "button", text: "Убрать ☆", "aria-label": "Убрать из избранного " + lot.title })
      ]);
      actions.querySelector("button").addEventListener("click", () => toggleFavorite(lot.lot_id));
      const row = lotItem(lot, actions, "#" + lot.lot_id + (lot.rarity ? " · " + lot.rarity : ""));
      row.classList.add("deal-row");
      list.append(row);
    });
  }

  function toggleFavorite(lotId) {
    const id = String(lotId);
    state.favorites = state.favorites.includes(id) ? state.favorites.filter((value) => value !== id) : [...state.favorites, id].slice(-5000);
    writeFavorites();
    renderFavorites();
    updateViewCounts();
    renderRows();
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
    renderDeals(); renderCheapest(); renderFavorites();
    renderCards(); renderCharts(); renderChanges(); renderTop(); renderSales(); fillFacets(); applyFilters();
    switchView(state.activeView);
  }

  // ---------- events ----------
  document.querySelectorAll("#mainNav [data-view]").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view, true));
  });
  document.querySelectorAll("[data-go-view]").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.goView, true));
  });
  $("globalSearch").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    $("search").value = $("globalSearch").value.trim();
    state.page = 0;
    switchView("market", true);
    applyFilters();
  });
  document.querySelectorAll("[data-search-token]").forEach((button) => {
    button.addEventListener("click", () => {
      const token = button.dataset.searchToken || "";
      const input = $("search");
      input.value = (input.value.trim() + " " + token).trim();
      $("globalSearch").value = input.value;
      state.page = 0;
      switchView("market", true);
      applyFilters();
    });
  });
  $("supportAmounts").addEventListener("click", (event) => {
    const button = event.target.closest("[data-amount]");
    if (button && !button.disabled) makeSupportPayment(button.dataset.amount);
  });
  ["search", "pmin", "pmax"].forEach((id) => $(id).addEventListener("input", () => { state.page = 0; $("globalSearch").value = $("search").value; applyFilters(); }));
  ["rarity", "status"].forEach((id) => $(id).addEventListener("change", () => { state.page = 0; applyFilters(); }));
  $("filters").addEventListener("submit", (e) => e.preventDefault());
  $("reset").addEventListener("click", () => { ["search", "pmin", "pmax", "rarity", "status", "globalSearch"].forEach((id) => { $(id).value = ""; }); state.page = 0; applyFilters(); });
  document.querySelectorAll(".sort").forEach((b) => b.addEventListener("click", () => {
    const key = b.dataset.key;
    state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : (key === "title" || key === "rarity" ? 1 : key === "price" ? 1 : -1) };
    state.page = 0; applyFilters();
  }));
  $("prev").addEventListener("click", () => { state.page = Math.max(0, state.page - 1); renderRows(); });
  $("next").addEventListener("click", () => { state.page += 1; renderRows(); });
  document.querySelectorAll(".tabs [role=tab]").forEach((t) => t.addEventListener("click", () => { state.changeKind = t.dataset.kind; renderChanges(); }));
  $("retry").addEventListener("click", load);
  $("dClose").addEventListener("click", () => $("detail").close());
  $("detail").addEventListener("close", () => { if (lastTrigger && document.contains(lastTrigger)) lastTrigger.focus(); });
  $("detail").addEventListener("click", (e) => { if (e.target === $("detail")) $("detail").close(); });
  load();
  initSupport();
  pollLive();
  window.setInterval(pollLive, 3000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { pollLive(); } });
})();
