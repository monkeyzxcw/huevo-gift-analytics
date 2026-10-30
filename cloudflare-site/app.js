"use strict";
(function () {
  const $ = (id) => document.getElementById(id);
  const SVG = "http://www.w3.org/2000/svg";
  const PAGE = 50;
  const STALE_HOURS = 24;
  const HUEVO_HOSTS = /^https:\/\/(huevo\.su|huevo\.departament\.site)\//i;

  const ACCOUNT_PROFILE_URL = "./api/me";
  let accountState = {
    user: null, profilesReady: false, updatedAt: null, dirty: false, hydrating: false,
    revision: 0, saving: false, saveTimer: null, pollTimer: null
  };

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
  function writeFavorites() { if (accountState.user) { if (!accountState.hydrating) queueProfileSave(); return; } try { localStorage.setItem("amnyam.favorites", JSON.stringify(state.favorites)); } catch (_) {} }
  function readTargets() {
    try { const x=JSON.parse(localStorage.getItem("amnyam.targets")||"{}"); return x&&typeof x==="object"&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).filter(([id,v])=>/^\d{1,20}$/.test(id)&&isNum(v)&&v>0).slice(0,5000)):{}; } catch (_) { return {}; }
  }
  function writeTargets(){if(accountState.user){if(!accountState.hydrating)queueProfileSave();return;}try{localStorage.setItem("amnyam.targets",JSON.stringify(state.targets));}catch(_){}}
  function readAlertedTargets(){try{const x=JSON.parse(localStorage.getItem("amnyam.alertedTargets")||"[]");return Array.isArray(x)?x.map(String).filter(id=>/^\d{1,20}$/.test(id)).slice(0,5000):[];}catch(_){return [];}}
  function writeAlertedTargets(){if(accountState.user){if(!accountState.hydrating)queueProfileSave();return;}try{localStorage.setItem("amnyam.alertedTargets",JSON.stringify(state.alertedTargets));}catch(_){}}
  function readSavedFilters(){try{const x=JSON.parse(localStorage.getItem("amnyam.savedFilters")||"[]");return Array.isArray(x)?x.filter(i=>i&&typeof i.name==="string"&&i.name.trim()&&i.filters&&typeof i.filters==="object").slice(0,25):[];}catch(_){return [];}}
  function writeSavedFilters(){if(accountState.user){if(!accountState.hydrating)queueProfileSave();return;}try{localStorage.setItem("amnyam.savedFilters",JSON.stringify(state.savedFilters));}catch(_){}}
  const state = {
    data:null,lots:[],view:[],page:0,sort:{key:"price",dir:1},groupSort:{key:"count",dir:-1},catalogMode:"lots",
    changeKind:"new",liveFingerprint:null,compareIds:[],activeView:"overview",favorites:readFavorites(),
    targets:readTargets(),alertedTargets:readAlertedTargets(),savedFilters:readSavedFilters()
  };
  let livePollRunning = false;
  let pollFailureCount = 0;
  let pollBackoffUntil = 0;
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
      dismissPremiumSplash();
    } catch (error) {
      $("errorText").textContent = "Не удалось загрузить data.json (" + (error && error.message ? error.message : "ошибка") + "). Данные могут быть ещё не опубликованы.";
      setBadge("err", "Данные недоступны");
      show("error");
      dismissPremiumSplash();
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
        lot.gift_details && [lot.gift_details.checked_at, lot.gift_details.attributes],
        Array.isArray(lot._history) && lot._history.length
          ? [lot._history.length, lot._history[lot._history.length - 1].observed_at, lot._history[lot._history.length - 1].price]
          : Array.isArray(lot.history) && lot.history.length
            ? [lot.history.length, lot.history[lot.history.length - 1].observed_at, lot.history[lot.history.length - 1].price]
            : []
      ]),
      stats: raw && raw.stats,
      sales: raw && raw.sales ? [raw.sales.generated_at, raw.sales.summary, Array.isArray(raw.sales.by_title) ? raw.sales.by_title.length : 0] : null,
      snapshots: Array.isArray(raw && raw.snapshots) ? raw.snapshots.length : 0,
      lastSnapshot: lastSnapshot ? [lastSnapshot.observed_at, lastSnapshot.active_lots, lastSnapshot.median_price] : null,
      changes: changes ? [changes.new, changes.gone, changes.price_up, changes.price_down] : null
    });
  }

  async function pollLive() {
    // The dashboard polls the Worker's merged /data.json, not only the first-page
    // endpoint. This lets both the 3-second live stream and the 5-minute full snapshot
    // reach every panel without reloading the document.
    if (livePollRunning || !state.data || document.visibilityState !== "visible" || Date.now() < pollBackoffUntil) return;
    livePollRunning = true;
    try {
      const response = await fetch("./data.json?_=" + Date.now(), {
        cache: "no-store",
        headers: { "Accept": "application/json" }
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const json = await response.json();
      if (!json || typeof json !== "object" || !Array.isArray(json.lots)) throw new Error("Некорректный снимок рынка");
      pollFailureCount = 0;
      pollBackoffUntil = 0;
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
      // Preserve the last valid snapshot and back off network requests on intermittent failures.
      pollFailureCount = Math.min(pollFailureCount + 1, 5);
      const delays = [3000, 6000, 12000, 20000, 30000];
      pollBackoffUntil = Date.now() + delays[pollFailureCount - 1];
      const dot = $("stateDot"), label = $("stateText");
      if (dot && label && state.data) {
        dot.className = "dot warn";
        label.textContent = "Связь восстанавливается";
      }
    } finally {
      livePollRunning = false;
    }
  }

  // ---------- optional target-price sound ----------
  const ALERT_SOUND_KEY = "amnyam.alertSound.v1";
  let alertSoundEnabled = false;
  let alertAudioContext = null;
  try { alertSoundEnabled = localStorage.getItem(ALERT_SOUND_KEY) === "on"; } catch (_) {}
  function updateAlertSoundControls() {
    const toggle = $("toggleAlertSound"), hint = $("alertSoundHint");
    if (toggle) {
      toggle.textContent = "Звук: " + (alertSoundEnabled ? "включён" : "выключен");
      toggle.setAttribute("aria-pressed", String(alertSoundEnabled));
    }
    if (hint) hint.textContent = alertSoundEnabled
      ? "Короткий сигнал прозвучит при достижении целевой цены. Вкладка должна быть открыта."
      : "Звуковые сигналы отключены. Уведомления браузера работают отдельно.";
  }
  function playAlertSound(force) {
    if (!force && !alertSoundEnabled) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      const hint = $("alertSoundHint");
      if (hint) hint.textContent = "В этом браузере звуковой сигнал недоступен.";
      return;
    }
    try {
      if (!alertAudioContext) alertAudioContext = new AudioContextClass();
      const context = alertAudioContext;
      if (context.state === "suspended") context.resume().catch(() => {});
      [880, 1174].forEach((frequency, index) => {
        const start = context.currentTime + index * 0.16;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.055, start + 0.025);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(start);
        oscillator.stop(start + 0.24);
      });
    } catch (_) {
      const hint = $("alertSoundHint");
      if (hint) hint.textContent = "Не удалось запустить звук. Проверь разрешения и настройки браузера.";
    }
  }
  function initAlertSoundControls() {
    updateAlertSoundControls();
    $("toggleAlertSound").addEventListener("click", () => {
      alertSoundEnabled = !alertSoundEnabled;
      if (accountState.user) { if (!accountState.hydrating) queueProfileSave(); } else { try { localStorage.setItem(ALERT_SOUND_KEY, alertSoundEnabled ? "on" : "off"); } catch (_) {} }
      updateAlertSoundControls();
      if (alertSoundEnabled) playAlertSound(true);
    });
    $("testAlertSound").addEventListener("click", () => playAlertSound(true));
  }

  function show(which) {
    ["loading", "error", "empty", "content"].forEach((id) => $(id).classList.toggle("hide", id !== which));
  }
  function setBadge(kind, text) { $("stateDot").className = "dot " + kind; $("stateText").textContent = text; }

  // ---------- decorative atmosphere (kept separate from market interactions) ----------
  let mascotMoodTimer = null;
  const seasonKey = "amnyam.season.v1";
  function setMascotMood(mood, message, resetAfter) {
    const mascot = $("amnyamMascot");
    if (!mascot) return;
    mascot.dataset.mood = mood || "neutral";
    $("mascotSpeech").textContent = message || "На страже выгодных лотов";
    if (mascotMoodTimer) window.clearTimeout(mascotMoodTimer);
    if (resetAfter) mascotMoodTimer = window.setTimeout(() => {
      mascot.dataset.mood = "neutral";
      $("mascotSpeech").textContent = "На страже выгодных лотов";
    }, resetAfter);
  }
  function applySeasonTheme(value, persist) {
    const allowed = ["default", "newyear", "halloween", "spring", "summer"];
    const theme = allowed.includes(value) ? value : "default";
    document.body.dataset.season = theme;
    $("seasonTheme").value = theme;
    if (persist) { if (accountState.user) queueProfileSave(); else { try { localStorage.setItem(seasonKey, theme); } catch (_) {} } }
  }
  function initAmbience() {
    let savedTheme = "default";
    try { savedTheme = localStorage.getItem(seasonKey) || "default"; } catch (_) {}
    applySeasonTheme(savedTheme, false);
    $("seasonTheme").addEventListener("change", () => applySeasonTheme($("seasonTheme").value, true));

    const decorative = ".top .brand,.hero,.day-picks > .panel-head,.overview-pick .pick-stamp,.deal-hero .deal-hero-stamp";
    document.addEventListener("pointermove", (event) => {
      const overDecoration = event.target && event.target.closest && event.target.closest(decorative);
      if (!overDecoration) { document.body.classList.remove("cursor-glow-active"); return; }
      document.body.classList.add("cursor-glow-active");
      document.documentElement.style.setProperty("--mouse-x", event.clientX + "px");
      document.documentElement.style.setProperty("--mouse-y", event.clientY + "px");
      $("cursorGlow").style.left = event.clientX + "px";
      $("cursorGlow").style.top = event.clientY + "px";
    }, { passive: true });
    document.addEventListener("pointerout", (event) => {
      if (!event.relatedTarget || !(event.relatedTarget.closest && event.relatedTarget.closest(decorative))) document.body.classList.remove("cursor-glow-active");
    }, { passive: true });

    const ambient = $("ambientLayer");
    const reduced = (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) || document.body.dataset.motion === "off";
    if (!reduced) {
      const dropGift = () => {
        if (document.hidden) { window.setTimeout(dropGift, 12000); return; }
        const gift = h("span", { class: "falling-gift", text: Math.random() > .5 ? "🎁" : "🎀", "aria-hidden": "true" });
        gift.style.left = (7 + Math.random() * 86) + "vw";
        gift.style.setProperty("--gift-duration", (7 + Math.random() * 3) + "s");
        ambient.append(gift);
        window.setTimeout(() => gift.remove(), 11000);
        const subtle = document.body.dataset.motion === "subtle";
        window.setTimeout(dropGift, (subtle ? 42000 : 26000) + Math.random() * 22000);
      };
      window.setTimeout(dropGift, 16000 + Math.random() * 12000);
    }
  }
  const splashStartedAt = Date.now();
  function dismissPremiumSplash() {
    const splash = $("premiumSplash");
    if (!splash || splash.dataset.dismissed) return;
    splash.dataset.dismissed = "1";
    window.setTimeout(() => {
      splash.classList.add("is-hidden");
      window.setTimeout(() => splash.remove(), 650);
    }, Math.max(0, 720 - (Date.now() - splashStartedAt)));
  }

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
    const raw = state.data && state.data.changes;
    const list = clear($("changeList"));
    document.querySelectorAll(".tabs [role=tab]").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.kind === state.changeKind)));

    // Worker responses can be older or partial while the live snapshot is being refreshed.
    // Normalize optional arrays and fall back to the snapshot's own gone-lot/history data.
    const ch = raw && typeof raw === "object" ? raw : {};
    const counts = ch.counts && typeof ch.counts === "object" ? ch.counts : {};
    const goneFallback = Array.isArray(state.data.gone_lots) ? state.data.gone_lots : [];
    const newRows = Array.isArray(ch.new) ? ch.new : [];
    const goneRows = Array.isArray(ch.gone) ? ch.gone : goneFallback;
    let priceRows = Array.isArray(ch.price_changes) ? ch.price_changes : [];
    if (!priceRows.length) {
      priceRows = state.lots.flatMap((lot) => {
        const history = Array.isArray(lot._history) ? lot._history : (Array.isArray(lot.history) ? lot.history : []);
        if (history.length < 2) return [];
        const from = Number(history[history.length - 2].price), to = Number(history[history.length - 1].price);
        if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0 || from === to) return [];
        return [{ ...lot, from, to, pct: (to - from) / from * 100 }];
      });
    }
    const available = Boolean(raw && (raw.counts || raw.new || raw.gone || raw.price_changes)) ||
      goneFallback.length > 0 || priceRows.length > 0 || (Array.isArray(state.data.snapshots) && state.data.snapshots.length > 1);
    if (!available) {
      $("changesNote").textContent = "";
      list.append(h("li", { class: "empty", text: "Пока нет данных для сравнения. После двух успешных снимков здесь появятся новые, исчезнувшие лоты и изменения цен." }));
      return;
    }
    $("changesNote").textContent = ch.since ? "относительно " + when(ch.since) : (Array.isArray(state.data.snapshots) && state.data.snapshots.length > 1 ? "по последним снимкам" : "история каталога");
    const k = state.changeKind;
    const rows = k === "new" ? newRows : k === "gone" ? goneRows : priceRows;
    const inferredNew = k === "new" && !Array.isArray(ch.new);
    const total = k === "new" ? (Number.isFinite(Number(counts.new)) ? Number(counts.new) : rows.length)
      : k === "gone" ? (Number.isFinite(Number(counts.gone)) ? Number(counts.gone) : rows.length)
      : (Number.isFinite(Number(counts.price_up)) || Number.isFinite(Number(counts.price_down))
        ? (Number(counts.price_up) || 0) + (Number(counts.price_down) || 0) : rows.length);
    if (!rows.length) {
      const message = k === "new" ? (inferredNew ? "Список новых лотов отсутствует в ответе источника." : "Новых лотов не обнаружено.")
        : k === "gone" ? "Исчезнувших лотов нет в текущем сравнении."
        : "Изменений цен по доступной истории нет.";
      list.append(h("li", { class: "empty", text: message }));
      return;
    }
    rows.slice(0, 50).forEach((r) => {
      if (k === "price") {
        const up = Number(r.to) > Number(r.from);
        list.append(lotItem(r, [h("span", { class: up ? "bad" : "good", text: fmt(r.from) + " → " + fmt(r.to) + " ◉" }), h("div", { class: "m", text: (r.pct != null ? (r.pct > 0 ? "+" : "") + fmt(r.pct) + "%" : "") })], "#" + r.lot_id));
      } else list.append(lotItem(r, price(r.price), "#" + r.lot_id + (r.rarity ? " · " + r.rarity : "")));
    });
    if (total > rows.length) list.append(h("li", { class: "m", text: "Показано " + Math.min(rows.length, 50) + " из " + fmt(total) + "." }));
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
    if (!sales || !sales.summary || !isNum(sales.summary.count) || sales.summary.count < 1) {
      panel.classList.add("hide"); return;
    }
    panel.classList.remove("hide");
    const sm = sales.summary, body = clear($("salesBody"));
    $("salesNote").textContent = "подтверждённых записей: " + fmt(sm.count);
    body.append(h("div", { class: "cards" }, [
      card("Продаж в базе", fmt(sm.count), "Цена неизвестна у " + fmt(sm.unknown || 0)),
      card("Медианная цена продажи", price(sm.median), sm.enough_data ? "Основной ориентир оценки" : "Выборка мала — только подсказка"),
      card("Диапазон", sm.min != null ? short(sm.min) + "–" + short(sm.max) : "—", "Минимум–максимум")
    ]));
    if (sm.note) body.append(h("p", { class: "muted foot", text: sm.note }));
    const profiles = Array.isArray(sales.by_title) ? sales.by_title.filter(x => x && typeof x.title === "string" && isNum(x.median)) : [];
    if (!profiles.length) {
      body.append(h("div", { class: "empty", text: "Группы подарков появятся, когда накопится минимум 3 сделки с известной ценой для одного названия." }));
      return;
    }
    const wrap = h("div", { class: "sale-history-browser" });
    const label = h("label", { class: "f sale-history-select" }, [
      h("span", { text: "Подарок" }),
      h("select", { class: "select", id: "giftSalesSelect" },
        profiles.slice().sort((a,b) => b.count-a.count).map((profile,index) =>
          h("option", { value: profile.title, text: profile.title + " · " + fmt(profile.count) + " продаж" })))
    ]);
    const detail = h("div", { id: "giftSalesProfile", class: "gift-sales-profile" });
    wrap.append(label, detail);
    body.append(wrap);
    const draw = (title) => {
      const profile = profiles.find(item => item.title === title) || profiles[0];
      clear(detail);
      detail.append(h("div", { class: "cards" }, [
        card("Медиана продаж", price(profile.median), fmt(profile.count) + " завершённых сделок"),
        card("P25 – P75", isNum(profile.p25)&&isNum(profile.p75)?price(profile.p25)+" – "+price(profile.p75):"—", "Центральные 50% цен"),
        card("Нижняя / верхняя", price(profile.min)+" / "+price(profile.max), "Все цены в выборке")
      ]));
      const dated = Array.isArray(profile.history) ? profile.history : [];
      if (dated.length >= 2) {
        const chart = h("div", { class: "chart sale-history-chart" });
        lineChart(chart, dated.map(point => ({ label: dayLabel(point.date), value: point.median })),
          "Медиана подтверждённых продаж подарка " + profile.title);
        detail.append(chart);
      } else {
        detail.append(h("div", { class: "empty", text: "Для этих сделок Huevo не передал надёжную календарную дату. Медиана и диапазон рассчитаны по подтверждённым ценам, но временную линию без даты мы не выдумываем." }));
      }
    };
    draw(profiles.slice().sort((a,b)=>b.count-a.count)[0].title);
    $("giftSalesSelect").addEventListener("change", event => draw(event.target.value));
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
    const groupLots = state.lots.filter((x) => x.title === l.title && x.rarity === l.rarity && isNum(x.price));
    const group = groupLots.map((x) => x.price).sort((a, b) => a - b);
    const salesProfile = salesProfileForGift(l);
    let cmp = "Недостаточно данных: нужны 5 сопоставимых продаж или устойчивых объявлений.";
    if (salesProfile && salesProfile.count >= 5 && isNum(l.price)) {
      cmp = "Медиана подтверждённых продаж по названию: " + price(salesProfile.median) +
        " (" + fmt(salesProfile.count) + " продаж). Объявления продавцов не используются как цена сделки.";
    } else {
      const offerProfile = robustOfferReference(group);
      if (offerProfile && !offerProfile.ambiguous && offerProfile.dispersion <= .65) {
        cmp = "Предварительный ориентир объявлений: " + price(offerProfile.reference) +
          " (" + fmt(offerProfile.sample_size) + " из " + fmt(offerProfile.raw_size) +
          " объявлений; исключено выбросов: " + fmt(offerProfile.excluded) + "). Это не цена продажи.";
      } else if (offerProfile && offerProfile.ambiguous) {
        cmp = "Цены объявлений разделены на разные ценовые группы. Надёжный ориентир не рассчитан.";
      }
    }
    const kv = [["ID", "#" + l.lot_id], ["Серия", l.serial || "—"], ["Редкость", l.rarity || "—"], ["Статус", l.status || "—"], ["Впервые замечен", when(l.first_seen)], ["Последний раз виден", when(l.last_seen)], ["Сравнение с аналогами", cmp]];
    body.append(h("dl", { class: "kv" }, kv.map((p) => h("div", {}, [h("dt", { text: p[0] }), h("dd", { text: p[1] })]))));
    const attributes = l.gift_details && l.gift_details.attributes && typeof l.gift_details.attributes === "object"
      ? Object.entries(l.gift_details.attributes).filter(([key,value]) => /^[a-z_]{2,30}$/.test(key) && typeof value === "string" && value.trim())
      : [];
    body.append(h("h4", { text: "Характеристики подарка" }));
    if (attributes.length) {
      const labels = { model:"Модель", backdrop:"Фон", symbol:"Символ", pattern:"Узор", rarity:"Редкость", serial:"Номер", supply:"Тираж", collection:"Коллекция" };
      body.append(h("dl", { class: "kv gift-attributes" }, attributes.map(([key,value]) =>
        h("div", {}, [h("dt", { text: labels[key] || key }), h("dd", { text: value })]))));
      body.append(h("p", { class: "muted foot", text: "Характеристики извлечены из карточки подарка Huevo. Не распознанные поля и данные владельца не сохраняются." }));
    } else {
      body.append(h("div", { class: "empty", text: l.gift_details ? "Карточка проверена, но её характеристики пока не удалось распознать. Мы не подставляем догадки." : "Карточка подарка ещё не проанализирована сборщиком." }));
    }

    const watch=h("div",{class:"detail-watch"});
    const fav=h("button",{class:"btn secondary",type:"button",text:state.favorites.includes(String(l.lot_id))?"★ В избранном":"☆ В избранное"});
    fav.addEventListener("click",()=>{toggleFavorite(l.lot_id);fav.textContent=state.favorites.includes(String(l.lot_id))?"★ В избранном":"☆ В избранное";});
    const target=h("input",{class:"input target-input",type:"number",min:"1",step:"1",inputmode:"numeric",placeholder:"Целевая цена","aria-label":"Целевая цена для "+(l.title||l.lot_id)});
    target.value=state.targets[String(l.lot_id)]?String(state.targets[String(l.lot_id)]):"";
    const save=h("button",{class:"btn",type:"button",text:"Сохранить цену-цель"});
    save.addEventListener("click",()=>{if(saveTarget(l.lot_id,target.value))save.textContent=target.value.trim()?"Цена-цель сохранена":"Цель удалена";});
    watch.append(fav,target,save);body.append(watch);
    body.append(h("h4", { text: "История цены объявления" }));
    body.append(h("p", { class: "muted foot", text: "Это история изменения цены именно этого лота; она не равна цене завершённых продаж." }));

    const hist = l._history, chart = h("div", { class: "chart" });
    body.append(chart);
    if (hist.length < 2) chart.append(h("div", { class: "empty", text: hist.length ? "Цена пока не менялась с первого наблюдения: " + price(hist[0].price) + " (" + when(hist[0].observed_at) + ")." : "История цены ещё не накоплена." }));
    else {
      lineChart(chart, hist.map((p) => ({ label: dayLabel(p.observed_at), value: p.price })), "История цены лота");
      const tbl = h("table", { class: "hist" }, [h("caption", { class: "sr", text: "История цены" }), h("tbody", {}, hist.slice().reverse().map((p) => h("tr", {}, [h("td", { text: when(p.observed_at) }), h("td", { class: "price", text: price(p.price) })])))]);
      body.append(tbl);
    }
    body.append(h("h4", { text: "История продаж такого подарка" }));
    const saleChart = h("div", { class: "chart" });
    body.append(saleChart);
    if (salesProfile && salesProfile.count >= 3) {
      saleChart.append(h("div", { class: "cards" }, [
        card("Продаж в выборке", fmt(salesProfile.count), "Подтверждённые записи Huevo"),
        card("Медиана продаж", price(salesProfile.median), "Главный ценовой ориентир"),
        card("Диапазон 25–75%", isNum(salesProfile.p25)&&isNum(salesProfile.p75)?price(salesProfile.p25)+" – "+price(salesProfile.p75):"—", "Центральная половина продаж")
      ]));
      const dated = Array.isArray(salesProfile.history) ? salesProfile.history : [];
      if (dated.length >= 2) {
        const datedChart = h("div", { class: "chart" });
        lineChart(datedChart, dated.map(point => ({ label: dayLabel(point.date), value: point.median })),
          "Медианная цена подтверждённых продаж подарка");
        saleChart.append(datedChart);
        saleChart.append(h("p", { class: "muted foot", text: "График строится только по сделкам с точной датой и часовым поясом, указанными Huevo." }));
      } else {
        saleChart.append(h("div", { class: "empty", text: "Huevo показывает время без даты для части сделок. Поэтому хронологический график не строится наугад; ниже остаётся проверенный диапазон и медиана." }));
      }
    } else {
      saleChart.append(h("div", { class: "empty", text: "В локальной базе пока нет достаточного числа подтверждённых продаж этого подарка. Будут показаны данные, когда накопится минимум 3 записи." }));
    }
    body.append(h("p", {}, [h("a", { class: "btn", href: safeUrl(l.lot_url, l.lot_id), target: "_blank", rel: "noopener noreferrer", text: "Открыть лот на Huevo ↗" })]));
    const dlg = $("detail");
    if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
  }

  function switchView(view, focusSearch) {
    const allowed = new Set(["overview", "market", "deals", "cheap", "analytics", "favorites", "support", "appearance"]);
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

  function normaliseSaleTitle(value) {
    return String(value || "").trim().toLocaleLowerCase("ru")
      .replace(/\s*#\s*\d+.*$/, "").replace(/\s+/g, " ").trim();
  }

  function salesProfileForGift(lot) {
    const list = state.data && state.data.sales && Array.isArray(state.data.sales.by_title)
      ? state.data.sales.by_title : [];
    const title = normaliseSaleTitle(lot && lot.title);
    return list.find(item => normaliseSaleTitle(item.title) === title && isNum(item.median) && item.median > 0) || null;
  }

  function robustOfferReference(prices) {
    const values = (prices || []).filter(v => isNum(v) && v > 0).slice().sort((a,b) => a-b);
    if (values.length < 5) return null;
    for (let i=3; i<values.length-2; i++) {
      const ratio = values[i-1] > 0 ? values[i]/values[i-1] : 0;
      if (ratio >= 2.5) return { reference:null, sample_size:values.length, raw_size:values.length,
        excluded:0, p25:quantile(values,.25), p75:quantile(values,.75), dispersion:ratio, ambiguous:true };
    }
    const q1 = quantile(values, .25), q3 = quantile(values, .75), iqr = q3 - q1;
    const core = iqr > 0 ? values.filter(v => v >= q1 - 1.5 * iqr && v <= q3 + 1.5 * iqr) : values;
    if (core.length < 5) return null;
    const mid = median(core), low = quantile(core, .25), high = quantile(core, .75);
    const dispersion = mid > 0 ? (high - low) / mid : Infinity;
    return { reference:mid, sample_size:core.length, raw_size:values.length,
      excluded:values.length-core.length, p25:low, p75:high, dispersion, ambiguous:false };
  }

  function buildDealSignals() {
    const groups = new Map();
    const active = state.lots.filter(lot => lot && lot.active !== false && isNum(lot.price) &&
      lot.price > 0 && String(lot.title || "").trim());
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
      const sales = salesProfileForGift(group[0]);
      const offers = robustOfferReference(group.map(lot => lot.price));
      let reference, basis, sampleSize, p25, p75, dispersion, excluded;
      if (sales && sales.count >= 5) {
        reference = sales.median; basis = "sales"; sampleSize = sales.count;
        p25 = isNum(sales.p25) ? sales.p25 : null;
        p75 = isNum(sales.p75) ? sales.p75 : null;
        dispersion = p25 != null && p75 != null && reference > 0 ? (p75-p25)/reference : null;
        excluded = 0;
      } else {
        // Asking prices are not transaction prices. Use them only when the distribution
        // has a sufficiently large, non-dispersed core; otherwise suppress the deal signal.
        if (!offers || offers.ambiguous || offers.dispersion > 1.0) continue;
        reference = offers.reference; basis = "active"; sampleSize = offers.sample_size;
        p25 = offers.p25; p75 = offers.p75; dispersion = offers.dispersion; excluded = offers.excluded;
      }
      if (!isNum(reference) || reference <= 0) continue;
      for (const lot of group) {
        if (lot.price >= reference * 0.85) continue;
        const discount = Math.round((1 - lot.price / reference) * 1000) / 10;
        signals.push({
          ...lot, reference_price: reference, discount_pct: discount, sample_size: sampleSize,
          basis, reference_p25: p25, reference_p75: p75, dispersion, excluded_outliers: excluded,
          confidence: basis === "sales" ? (sampleSize >= 20 ? "high" : "medium") : "low",
          suspicious: discount > 80,
        });
      }
    }
    signals.sort((a,b) => (a.suspicious === b.suspicious ? 0 : a.suspicious ? 1 : -1) ||
      (a.basis === b.basis ? 0 : a.basis === "sales" ? -1 : 1) ||
      b.discount_pct-a.discount_pct || a.price-b.price ||
      String(a.title).localeCompare(String(b.title), "ru"));
    return signals;
  }

  function compactSignalItem(lot, sub, badge, linkLabel) {
    const badgeEl = h("span", { class: "discount-tag", text: badge || price(lot.price) });
    const actions = h("div", { class: "deal-actions" }, [
      badgeEl,
      h("button", { class: "btn secondary deal-detail", type: "button", text: "Анализ" }),
      h("a", { class: "btn secondary", href: safeUrl(lot.lot_url, lot.lot_id), target: "_blank", rel: "noopener noreferrer", text: linkLabel || "Открыть ↗" })
    ]);
    actions.querySelector(".deal-detail").addEventListener("click", event => openDetail(lot, event.currentTarget));
    const row = lotItem(lot, actions, sub);
    row.classList.add("deal-row");
    return row;
  }

  function renderDealCard(lot,label,dayPick){
    const id=String(lot.lot_id),saved=isNum(lot.reference_price)?Math.max(0,lot.reference_price-lot.price):null;
    const histValues=(Array.isArray(lot._history)?lot._history:[]).filter(p=>isNum(p.price)).map(p=>p.price);
    const histLow=histValues.length>=2?Math.min(...histValues):null;
    const badgeText=isNum(lot.discount_pct)?"−"+fmt(lot.discount_pct)+"%":(label||"Рыночный лот");
    const fav=state.favorites.includes(id);
    const actions=h("div",{class:"deal-actions"},[
      h("span",{class:"discount-tag deal-discount",text:badgeText}),
      h("button",{class:"btn secondary deal-detail",type:"button",text:"Анализ","aria-label":"Анализировать "+(lot.title||id)}),
      h("a",{class:"btn secondary",href:safeUrl(lot.lot_url,lot.lot_id),target:"_blank",rel:"noopener noreferrer",text:"Открыть ↗"}),
      ...(dayPick ? [h("button",{class:"btn purchase-confirm",type:"button",text:"Куплено ✓","aria-label":"Подтвердить успешную покупку лота "+(lot.title||id)})] : []),
      h("button",{class:"watch-btn deal-watch",type:"button","aria-pressed":String(fav),"aria-label":(fav?"Убрать из избранного ":"Добавить в избранное ")+(lot.title||id),text:fav?"★":"☆"})
    ]);
    actions.querySelector(".deal-detail").addEventListener("click",event=>openDetail(lot,event.currentTarget));
    actions.querySelector(".deal-watch").addEventListener("click",()=>toggleFavorite(lot.lot_id));
    const purchased = actions.querySelector(".purchase-confirm");
    if (purchased) purchased.addEventListener("click", () => {
      purchased.disabled = true;
      purchased.textContent = "Отмечено ✓";
      setMascotMood("happy", "Ура! Лот куплен! 🎉", 9000);
    });
    const row=lotItem(lot,actions,"#"+id+(lot.serial?" · "+lot.serial:"")+(lot.rarity?" · "+lot.rarity:""));
    row.classList.add("deal-row","deal-card-rich");if(dayPick)row.classList.add("day-pick-card");
    const metrics=h("div",{class:"deal-metrics"});
    metrics.append(
      h("span",{class:"deal-metric ask"},[h("small",{text:"ЦЕНА ЛОТА"}),h("b",{text:price(lot.price)})]),
      h("span",{class:"deal-metric"},[h("small",{text:lot.basis==="sales"?"МЕДИАНА ПРОДАЖ":"МЕДИАНА ОБЪЯВЛЕНИЙ"}),h("b",{text:isNum(lot.reference_price)?price(lot.reference_price):"Нет ориентира"})]),
      h("span",{class:"deal-metric saving"},[h("small",{text:"РАЗНИЦА"}),h("b",{text:isNum(saved)?price(saved)+" ниже":"Не рассчитана"})]),
      h("span",{class:"deal-metric"},[h("small",{text:lot.basis==="sales"?"СОВЕРШЁННЫЕ ПРОДАЖИ":"АКТИВНЫЕ ОБЪЯВЛЕНИЯ"}),h("b",{text:isNum(lot.sample_size)&&lot.sample_size>0?fmt(lot.sample_size)+" записей":"Мало данных"})])
    );
    if(histLow!==null)metrics.append(h("span",{class:"deal-metric history-low"},[h("small",{text:"МИНИМУМ В ИСТОРИИ"}),h("b",{text:price(histLow)})]));
    const mini=sparkline(lot._history);
    if(mini)metrics.append(h("div",{class:"deal-sparkline"},[mini,h("small",{text:"История цены"})]));
    row.children[1].append(metrics);
    const target=h("input",{class:"input target-input deal-target-input",type:"number",min:"1",step:"1",inputmode:"numeric",placeholder:"Желаемая цена","aria-label":"Цена-цель для "+(lot.title||id)});
    target.value=state.targets[id]?String(state.targets[id]):"";
    const save=h("button",{class:"btn target-save",type:"button",text:state.targets[id]?"Обновить уведомление":"Уведомить при цене"});
    save.addEventListener("click",()=>{saveTarget(lot.lot_id,target.value);});
    const quick=h("button",{class:"btn secondary target-quick",type:"button",text:"Цель −10%"});
    quick.addEventListener("click",()=>{target.value=String(Math.max(1,Math.floor(lot.price*.9)));saveTarget(lot.lot_id,target.value);});
    const status=h("small",{class:"target-status",text:state.targets[id]?(lot.active!==false&&isNum(lot.price)&&lot.price<=state.targets[id]?"✓ Цель достигнута":"Цель "+price(state.targets[id])):"Цель не задана"});
    row.children[1].append(h("div",{class:"deal-target-row"},[target,save,quick,status]));
    return row;
  }

  function renderDeals(){
    const signals=buildDealSignals(),best=signals[0]||null;
    let deals=signals.slice(),sortBy=$("dealSort").value||"discount";
    if(sortBy==="price")deals.sort((a,b)=>a.price-b.price||b.discount_pct-a.discount_pct);
    else if(sortBy==="savings")deals.sort((a,b)=>(b.reference_price-b.price)-(a.reference_price-a.price)||b.discount_pct-a.discount_pct);
    else if(sortBy==="sample")deals.sort((a,b)=>b.sample_size-a.sample_size||b.discount_pct-a.discount_pct);
    else if(sortBy==="historical")deals.sort((a,b)=>{
      const gap=lot=>{const v=(lot._history||[]).filter(p=>isNum(p.price)).map(p=>p.price);if(v.length<2)return Infinity;const low=Math.min(...v);return low>0?lot.price/low-1:Infinity;};
      return gap(a)-gap(b)||b.discount_pct-a.discount_pct;
    });
    else deals.sort((a,b)=>b.discount_pct-a.discount_pct||a.price-b.price);
    const list=clear($("dealsList"));
    $("dealsCount").textContent=fmt(signals.length)+" сигналов";
    $("dealsNote").textContent=signals.length?"Сначала история продаж; без неё — только устойчивый разброс минимум 5 объявлений.":"Нет достаточных продаж или устойчивой группы объявлений";
    $("belowBest").classList.toggle("hide",!best);
    if (!best) setMascotMood("sad", "Пока нет выгодных лотов… Сканирую дальше");
    else if ($("amnyamMascot").dataset.mood !== "happy") setMascotMood("neutral", "Нашёл выгодные предложения!");
    if(best){
      state._belowBestId=String(best.lot_id);
      $("belowBestTitle").textContent=best.title||("Лот #"+best.lot_id);
      $("belowBestPrice").textContent=price(best.price);
      $("belowBestMeta").textContent="На "+fmt(best.discount_pct)+"% ниже "+(best.basis==="sales"?"медианы подтверждённых продаж":"устойчивой медианы объявлений")+" · разница "+price(Math.max(0,best.reference_price-best.price))+" · "+fmt(best.sample_size)+(best.basis==="sales"?" продаж":" лотов")+" · "+(best.confidence==="high"?"высокая выборка":best.confidence==="medium"?"средняя выборка":"низкая уверенность")+" · #"+best.lot_id;
      $("belowBestOpen").href=safeUrl(best.lot_url,best.lot_id);
      const bestImage=$("belowBestImage"),bestArt=$("belowBestArt");
      const imageUrl=typeof best.image_url==="string"&&best.image_url.startsWith("https://")&&(best.image_url.includes("huevo.su/")||best.image_url.includes("huevo.departament.site/"))?best.image_url:"";
      bestArt.classList.toggle("has-image",!!imageUrl);
      bestImage.hidden=!imageUrl;
      bestImage.onerror=()=>{bestArt.classList.remove("has-image");bestImage.hidden=true;};
      if(imageUrl&&bestImage.src!==imageUrl)bestImage.src=imageUrl;
      if(!imageUrl)bestImage.removeAttribute("src");
      $("belowBestTarget").value=state.targets[String(best.lot_id)]?String(state.targets[String(best.lot_id)]):"";
      $("overviewPickHint").textContent="Лучший текущий дисконт: −"+fmt(best.discount_pct)+"% от "+(best.basis==="sales"?"медианы подтверждённых продаж":"устойчивого диапазона объявлений")+". "+(best.confidence==="low"?"Ориентир предварительный.":"");
      const pick=clear($("overviewPickLot"));
      if(best.image_url&&/^https:\/\//i.test(best.image_url)){const img=h("img",{class:"pick-img",src:best.image_url,alt:"",loading:"lazy",referrerpolicy:"no-referrer"});img.addEventListener("error",()=>img.replaceWith(h("span",{class:"pick-img",text:"🎁"})));pick.append(img);}
      pick.append(h("div",{},[h("strong",{text:best.title||("Лот #"+best.lot_id)}),h("span",{class:"pick-price",text:price(best.price)}),h("small",{text:"−"+fmt(best.discount_pct)+"% к "+(best.basis==="sales"?"продажам":"объявлениям")+" · разница "+price(best.reference_price-best.price)})]));
      deals.slice(0,30).forEach((lot,index)=>list.append(renderDealCard(lot,"#"+(index+1),false)));
    }else{
      state._belowBestId=null;
      $("belowBestTitle").textContent="Пока нет уверенного кандидата";$("belowBestPrice").textContent="—";
      $("belowBestMeta").textContent="Нужны минимум 5 сопоставимых записей о продажах или 5 объявлений с достаточно узким диапазоном цен. Слишком разрозненные цены не считаем ориентиром.";
      $("belowBestOpen").href="https://huevo.su/market/gifts";$("belowBestTarget").value="";
      $("overviewPickHint").textContent="Когда появится сопоставимая группа, здесь будет показан лучший текущий дисконт.";
      const pick=clear($("overviewPickLot"));pick.append(h("span",{class:"muted",text:"Пока нет группы аналогов для честного сравнения."}));
      list.append(h("li",{class:"empty",text:"Нет лотов на 15% дешевле медианы трёх или более похожих активных предложений."}));
    }
    updateViewCounts();
  }

  function renderDayPicks(){
    const box=clear($("dayPicks")),signals=buildDealSignals(),chosen=[],seen=new Set();
    const add=(lot,tag,description)=>{if(!lot||seen.has(String(lot.lot_id))||chosen.length>=3)return;seen.add(String(lot.lot_id));chosen.push({lot,tag,description});};
    if(signals.length){
      add(signals[0],"ЛУЧШИЙ ДИСКОНТ","Самое сильное отличие от медианы аналогов");
      add(signals.slice().sort((a,b)=>a.price-b.price||b.discount_pct-a.discount_pct)[0],"НИЗКАЯ ЦЕНА","Самая низкая цена среди лотов ниже рынка");
      add(signals.slice().sort((a,b)=>b.sample_size-a.sample_size||b.discount_pct-a.discount_pct)[0],"БОЛЬШЕ АНАЛОГОВ","Самая широкая выборка похожих предложений");
    }
    const fallback=state.lots.filter(l=>l&&l.active!==false&&isNum(l.price)&&l.price>0).slice().sort((a,b)=>a.price-b.price);
    for(const lot of fallback)add(lot,"ДОСТУПНАЯ ЦЕНА","Бюджетный лот; дисконт к медиане не подтверждён");
    $("dayPicksNote").textContent=chosen.length===3?"3 кандидата · по текущему снимку":fmt(chosen.length)+" кандидата";
    if(!chosen.length){box.append(h("div",{class:"empty",text:"Появятся после первого успешного снимка цен."}));return;}
    chosen.forEach((item,index)=>{
      const lot={...item.lot,reference_price:isNum(item.lot.reference_price)?item.lot.reference_price:null,discount_pct:isNum(item.lot.discount_pct)?item.lot.discount_pct:null,sample_size:isNum(item.lot.sample_size)?item.lot.sample_size:0};
      const card=renderDealCard(lot,item.tag,true);
      card.prepend(h("div",{class:"day-pick-label"},[h("span",{text:"0"+(index+1)}),h("b",{text:item.tag}),h("small",{text:item.description})]));
      box.append(card);
    });
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
    $("watchAlertText").textContent=text;$("watchAlertOpen").href=safeUrl(lot.lot_url,lot.lot_id);$("watchAlert").classList.remove("hide");
    playAlertSound(false);
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
    writeTargets();writeAlertedTargets();writeFavorites();checkTargetAlerts();renderFavorites();renderRows();renderDeals();renderDayPicks();updateViewCounts();return true;
  }

  function toggleFavorite(lotId){
    const id=String(lotId);
    if(state.favorites.includes(id)){state.favorites=state.favorites.filter(v=>v!==id);delete state.targets[id];state.alertedTargets=state.alertedTargets.filter(v=>v!==id);writeTargets();writeAlertedTargets();}
    else state.favorites=[...state.favorites,id].slice(-5000);
    writeFavorites();renderFavorites();updateViewCounts();renderRows();renderDeals();renderDayPicks();
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

  // ---------- command center / market pulse ----------
  function renderCommandCenter() {
    const st = stats();
    const deals = buildDealSignals();
    const best = deals[0] || null;
    const setText = (id, value) => { const el = $(id); if (el) el.textContent = value; };
    setText("pulseLots", fmt(st.total));
    setText("pulseMedian", price(st.median));
    setText("pulseDeals", fmt(deals.length));
    setText("pulseWatchlist", fmt(state.favorites.length));
    setText("pulseWatchlistNote", fmt(Object.keys(state.targets).length) + " целевых цен · " + fmt(state.favorites.length) + " в избранном");
    setText("pulseBestTitle", best ? (best.title || ("Лот #" + best.lot_id)) : "Пока нет подтверждённой сделки");
    setText("pulseBestNote", best ? ("Лот #" + best.lot_id + " · " + price(best.price) + " вместо медианы " + price(best.reference_price) + " · " + fmt(best.sample_size) + " аналогов") : "Нужно минимум 3 сопоставимых лота и цена минимум на 15% ниже медианы.");
    setText("pulseBestDiscount", best ? "−" + fmt(best.discount_pct) + "%" : "—");
  }

  function openCommandPalette() {
    const dialog = $("commandPalette");
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    $("commandPaletteInput").value = "";
    filterCommandPalette("");
    window.setTimeout(() => $("commandPaletteInput").focus(), 0);
  }
  function closeCommandPalette() {
    const dialog = $("commandPalette");
    if (dialog && dialog.open) dialog.close();
  }
  function filterCommandPalette(query) {
    const q = String(query || "").trim().toLocaleLowerCase("ru");
    document.querySelectorAll("[data-command-item]").forEach(button => {
      button.hidden = !!q && !button.textContent.toLocaleLowerCase("ru").includes(q);
    });
  }
  function runCommand(button) {
    if (!button) return;
    const view = button.dataset.commandView;
    const command = button.dataset.command;
    closeCommandPalette();
    if (view) switchView(view, true);
    if (command === "search") {
      switchView("market", true);
      $("search").focus({ preventScroll: true });
    }
  }


  // ---------- account + cross-device profile sync ----------
  function profilePayload() {
    return {
      favorites: state.favorites.slice(0, 5000),
      targets: { ...state.targets },
      alertedTargets: state.alertedTargets.slice(0, 5000),
      savedFilters: state.savedFilters.slice(0, 25),
      preferences: {
        alertSound: Boolean(alertSoundEnabled),
        appearance: { ...appearance },
        seasonTheme: document.body.dataset.season || "default"
      }
    };
  }

  function applyAccountProfile(profile) {
    accountState.hydrating = true;
    const p = profile && typeof profile === "object" ? profile : {};
    state.favorites = Array.isArray(p.favorites) ? [...new Set(p.favorites.map(String).filter(id => /^\d{1,20}$/.test(id)))].slice(0, 5000) : [];
    state.targets = p.targets && typeof p.targets === "object" && !Array.isArray(p.targets)
      ? Object.fromEntries(Object.entries(p.targets).filter(([id, value]) => /^\d{1,20}$/.test(id) && isNum(value) && value > 0).slice(0, 5000)) : {};
    state.alertedTargets = Array.isArray(p.alertedTargets) ? [...new Set(p.alertedTargets.map(String).filter(id => /^\d{1,20}$/.test(id)))].slice(0, 5000) : [];
    state.savedFilters = Array.isArray(p.savedFilters) ? p.savedFilters.filter(item => item && typeof item.name === "string" && item.name.trim() && item.filters && typeof item.filters === "object").slice(0, 25) : [];
    const prefs = p.preferences && typeof p.preferences === "object" ? p.preferences : {};
    alertSoundEnabled = prefs.alertSound === true;
    const a = prefs.appearance && typeof prefs.appearance === "object" ? prefs.appearance : {};
    appearance = {
      background: ["cosmic","liquid","nebula","minimal"].includes(a.background) ? a.background : "cosmic",
      mascot: a.mascot === "none" ? "none" : "omnom",
      motion: ["normal","subtle","off"].includes(a.motion) ? a.motion : "normal",
      glass: a.glass !== false
    };
    applyAppearance();
    applySeasonTheme(["default","newyear","halloween","spring","summer"].includes(prefs.seasonTheme) ? prefs.seasonTheme : "default", false);
    updateAlertSoundControls();
    accountState.hydrating = false;
    if (state.data) render();
  }

  function restoreGuestProfile() {
    state.favorites = readFavorites();
    state.targets = readTargets();
    state.alertedTargets = readAlertedTargets();
    state.savedFilters = readSavedFilters();
    try { alertSoundEnabled = localStorage.getItem(ALERT_SOUND_KEY) === "on"; } catch (_) { alertSoundEnabled = false; }
    appearance = readAppearance();
    applyAppearance();
    let theme = "default";
    try { theme = localStorage.getItem(seasonKey) || "default"; } catch (_) {}
    applySeasonTheme(theme, false);
    updateAlertSoundControls();
    if (state.data) render();
  }

  function setAccountStatus(message, kind) {
    const node = $("accountStatus");
    if (node) {
      node.textContent = message || "";
      node.style.color = kind === "ok" ? "#8eea62" : kind === "muted" ? "var(--muted)" : "#ffbdc6";
    }
    const sync = $("accountSyncStatus");
    if (sync && accountState.user) sync.textContent = message || "Синхронизация включена";
  }

  function updateAccountUI() {
    const signedIn = Boolean(accountState.user);
    $("accountGuest").classList.toggle("hide", signedIn);
    $("accountSigned").classList.toggle("hide", !signedIn);
    $("accountButton").textContent = signedIn ? "◎ " + accountState.user.display_name : "Войти в профиль";
    if (signedIn) {
      $("accountDisplayName").textContent = accountState.user.display_name;
      $("accountUsername").textContent = "@" + accountState.user.username;
      setAccountStatus("Синхронизация включена", "ok");
    }
  }

  async function accountRequest(path, options) {
    const response = await fetch(path, {
      cache: "no-store",
      credentials: "same-origin",
      ...(options || {}),
      headers: { "Accept": "application/json", ...((options && options.headers) || {}) }
    });
    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error(data.error || ("HTTP " + response.status));
    return data;
  }

  function queueProfileSave() {
    if (!accountState.user) return;
    accountState.revision += 1;
    accountState.dirty = true;
    if (accountState.saveTimer) window.clearTimeout(accountState.saveTimer);
    accountState.saveTimer = window.setTimeout(saveAccountProfile, 700);
    setAccountStatus("Есть несохранённые изменения…", "muted");
  }

  async function saveAccountProfile() {
    if (!accountState.user || !accountState.dirty || accountState.saving) return;
    const revision = accountState.revision;
    const payload = profilePayload();
    accountState.dirty = false;
    accountState.saving = true;
    try {
      const result = await accountRequest("./api/me/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: payload })
      });
      accountState.updatedAt = result.updated_at || accountState.updatedAt;
      if (revision === accountState.revision) setAccountStatus("Все изменения сохранены", "ok");
      else accountState.dirty = true;
    } catch (error) {
      accountState.dirty = true;
      setAccountStatus("Не удалось синхронизировать: " + error.message, "error");
    } finally {
      accountState.saving = false;
      if (accountState.dirty && accountState.user) {
        if (accountState.saveTimer) window.clearTimeout(accountState.saveTimer);
        accountState.saveTimer = window.setTimeout(saveAccountProfile, 2500);
      }
    }
  }

  function acceptAccountSession(data) {
    accountState.user = data.user;
    accountState.profilesReady = true;
    accountState.updatedAt = data.updated_at || null;
    accountState.dirty = false;
    if (accountState.saveTimer) window.clearTimeout(accountState.saveTimer);
    applyAccountProfile(data.profile);
    updateAccountUI();
    if ($("accountDialog").open) $("accountDialog").close();
    setAccountStatus("Профиль загружен", "ok");
  }

  async function submitAccountForm(form, mode) {
    const submit = form.querySelector('button[type="submit"]');
    const original = submit.textContent;
    submit.disabled = true;
    submit.textContent = mode === "login" ? "Входим…" : "Создаём…";
    setAccountStatus("", "muted");
    try {
      const body = mode === "login"
        ? { username: $("loginUsername").value.trim(), password: $("loginPassword").value }
        : {
            username: $("registerUsername").value.trim(),
            display_name: $("registerDisplayName").value.trim(),
            password: $("registerPassword").value,
            profile: profilePayload()
          };
      const data = await accountRequest("./api/auth/" + mode, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      acceptAccountSession(data);
      form.reset();
      startAccountProfilePolling();
    } catch (error) {
      setAccountStatus(error.message || "Не удалось выполнить запрос.", "error");
    } finally {
      submit.disabled = false;
      submit.textContent = original;
    }
  }

  async function checkAccountSession() {
    try {
      const data = await accountRequest(ACCOUNT_PROFILE_URL);
      accountState.profilesReady = data.profiles_ready !== false;
      if (data.authenticated && data.user) {
        if (!accountState.user || accountState.user.id !== data.user.id || accountState.updatedAt !== data.updated_at) {
          accountState.user = data.user;
          accountState.updatedAt = data.updated_at || null;
          if (!accountState.dirty) applyAccountProfile(data.profile);
        }
        updateAccountUI();
        startAccountProfilePolling();
      } else if (accountState.user) {
        accountState.user = null;
        accountState.updatedAt = null;
        accountState.dirty = false;
        restoreGuestProfile();
        updateAccountUI();
      } else {
        updateAccountUI();
      }
      if (!accountState.profilesReady) setAccountStatus("Серверное хранилище профилей ещё не подготовлено.", "error");
    } catch (error) {
      setAccountStatus("Профиль временно недоступен. Общий рынок продолжает работать.", "error");
      updateAccountUI();
    }
  }

  function startAccountProfilePolling() {
    if (accountState.pollTimer) return;
    accountState.pollTimer = window.setInterval(async () => {
      if (!accountState.user || accountState.dirty) return;
      try {
        const data = await accountRequest(ACCOUNT_PROFILE_URL);
        if (!data.authenticated || !data.user) {
          accountState.user = null;
          accountState.updatedAt = null;
          restoreGuestProfile();
          updateAccountUI();
          window.clearInterval(accountState.pollTimer);
          accountState.pollTimer = null;
          return;
        }
        if (data.user.id !== accountState.user.id) {
          accountState.user = data.user;
          accountState.updatedAt = data.updated_at || null;
          applyAccountProfile(data.profile);
          updateAccountUI();
        } else if (data.updated_at && data.updated_at !== accountState.updatedAt) {
          accountState.updatedAt = data.updated_at;
          applyAccountProfile(data.profile);
          setAccountStatus("Профиль синхронизирован с другого устройства", "ok");
        }
      } catch (_) {}
    }, 30000);
  }

  async function logoutFromAccount() {
    const button = $("logoutButton");
    button.disabled = true;
    try {
      await saveAccountProfile();
      await accountRequest("./api/auth/logout", { method: "POST" });
    } catch (_) {
      // A lost connection must not leave the current browser showing the next guest's profile.
    } finally {
      accountState.user = null;
      accountState.updatedAt = null;
      accountState.dirty = false;
      accountState.saving = false;
      if (accountState.saveTimer) window.clearTimeout(accountState.saveTimer);
      if (accountState.pollTimer) window.clearInterval(accountState.pollTimer);
      accountState.saveTimer = null;
      accountState.pollTimer = null;
      restoreGuestProfile();
      updateAccountUI();
      button.disabled = false;
      $("accountDialog").close();
    }
  }

  function initAccountUI() {
    updateAccountUI();
    $("accountButton").addEventListener("click", () => {
      $("accountStatus").textContent = "";
      $("accountDialog").showModal();
    });
    $("accountClose").addEventListener("click", () => $("accountDialog").close());
    $("accountDialog").addEventListener("click", event => { if (event.target === $("accountDialog")) $("accountDialog").close(); });
    $("showRegister").addEventListener("click", () => {
      $("loginForm").classList.add("hide");
      $("registerForm").classList.remove("hide");
      $("accountStatus").textContent = "";
    });
    $("showLogin").addEventListener("click", () => {
      $("registerForm").classList.add("hide");
      $("loginForm").classList.remove("hide");
      $("accountStatus").textContent = "";
    });
    $("loginForm").addEventListener("submit", event => { event.preventDefault(); submitAccountForm($("loginForm"), "login"); });
    $("registerForm").addEventListener("submit", event => { event.preventDefault(); submitAccountForm($("registerForm"), "register"); });
    $("logoutButton").addEventListener("click", logoutFromAccount);
    checkAccountSession();
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
      setMascotMood("sad", "Каталог пока пуст… Жду новые лоты");
      dismissPremiumSplash();
      switchView(state.activeView);
      return;
    }
    show("content");
    checkTargetAlerts();
    renderCommandCenter();
    renderDeals();renderDayPicks();renderCheapest();renderFavorites();
    renderCards(); renderCharts(); renderChanges(); renderTop(); renderSales(); fillFacets();
    renderSavedFilters();setSortMenuOptions();applyFilters();
    switchView(state.activeView);
  }

  const APPEARANCE_KEY = "amnyam.appearance.v1";
  const DEFAULT_APPEARANCE = { background: "cosmic", mascot: "omnom", motion: "normal", glass: true };
  function readAppearance() {
    try {
      const saved = JSON.parse(localStorage.getItem(APPEARANCE_KEY) || "{}");
      return {
        background: ["cosmic","liquid","nebula","minimal"].includes(saved.background) ? saved.background : DEFAULT_APPEARANCE.background,
        mascot: saved.mascot === "none" ? "none" : "omnom",
        motion: ["normal","subtle","off"].includes(saved.motion) ? saved.motion : "normal",
        glass: saved.glass !== false
      };
    } catch (_) { return { ...DEFAULT_APPEARANCE }; }
  }
  let appearance = readAppearance();
  function applyAppearance() {
    document.body.dataset.bg = appearance.background;
    document.body.dataset.mascot = appearance.mascot;
    document.body.dataset.motion = appearance.motion;
    document.body.classList.toggle("glass-off", !appearance.glass);
    const bg = $("appearanceBackground"), mascot = $("appearanceMascot"), motion = $("appearanceMotion"), glass = $("appearanceGlass");
    if (bg) bg.value = appearance.background;
    if (mascot) mascot.value = appearance.mascot;
    if (motion) motion.value = appearance.motion;
    if (glass) glass.checked = appearance.glass;
    if (accountState.user) { if (!accountState.hydrating) queueProfileSave(); } else { try { localStorage.setItem(APPEARANCE_KEY, JSON.stringify(appearance)); } catch (_) {} }
  }
  function initAppearance() {
    applyAppearance();
    $("appearanceBackground").addEventListener("change", e => { appearance.background = e.target.value; applyAppearance(); });
    $("appearanceMascot").addEventListener("change", e => { appearance.mascot = e.target.value; applyAppearance(); });
    $("appearanceMotion").addEventListener("change", e => { appearance.motion = e.target.value; applyAppearance(); });
    $("appearanceGlass").addEventListener("change", e => { appearance.glass = e.target.checked; applyAppearance(); });
    $("resetAppearance").addEventListener("click", () => { appearance = { ...DEFAULT_APPEARANCE }; applyAppearance(); });
  }

  // ---------- events ----------
  initAccountUI();
  initAppearance();
  initAmbience();
  initAlertSoundControls();
  const paletteOpen = $("openCommandPalette");
  if (paletteOpen) paletteOpen.addEventListener("click", openCommandPalette);
  $("commandPaletteInput").addEventListener("input", event => filterCommandPalette(event.target.value));
  $("commandPaletteInput").addEventListener("keydown", event => {
    const visible = Array.from(document.querySelectorAll("[data-command-item]:not([hidden])"));
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!visible.length) return;
      const active = visible.indexOf(document.activeElement);
      const next = event.key === "ArrowDown" ? (active + 1) % visible.length : (active <= 0 ? visible.length - 1 : active - 1);
      visible[next].focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const focused = document.activeElement && document.activeElement.matches("[data-command-item]") ? document.activeElement : visible[0];
      if (focused) runCommand(focused);
    }
  });
  $("commandPaletteItems").addEventListener("click", event => {
    const button = event.target.closest("[data-command-item]");
    if (button && !button.hidden) runCommand(button);
  });
  $("commandPalette").addEventListener("click", event => { if (event.target === $("commandPalette")) closeCommandPalette(); });
  document.querySelectorAll("[data-command]").forEach(button => button.addEventListener("click", () => runCommand(button)));
  document.addEventListener("keydown", event => {
    const typing = event.target && (event.target.matches("input,textarea,select") || event.target.isContentEditable);
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault(); openCommandPalette(); return;
    }
    if (!typing && !event.altKey && !event.ctrlKey && !event.metaKey && event.key === "/") {
      event.preventDefault(); switchView("market", true); $("search").focus({ preventScroll: true }); return;
    }
    if (!typing && !event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "g") {
      window.__amnyamGoPending = Date.now();
      window.setTimeout(() => { if (Date.now() - window.__amnyamGoPending >= 700) window.__amnyamGoPending = 0; }, 750);
      return;
    }
    if (!typing && window.__amnyamGoPending && Date.now() - window.__amnyamGoPending < 750) {
      const key = event.key.toLowerCase();
      const views = { h: "overview", m: "market", d: "deals", c: "cheap", a: "analytics", f: "favorites" };
      if (views[key]) { event.preventDefault(); switchView(views[key], true); }
      window.__amnyamGoPending = 0;
    }
  });
  document.querySelectorAll("#mainNav [data-view]").forEach(button=>button.addEventListener("click",()=>switchView(button.dataset.view,true)));
  document.querySelectorAll("[data-go-view]").forEach(button=>button.addEventListener("click",()=>switchView(button.dataset.goView,true)));
  $("globalSearch").addEventListener("keydown",event=>{if(event.key!=="Enter")return;event.preventDefault();$("search").value=$("globalSearch").value.trim();state.page=0;switchView("market",true);applyFilters();});
  document.querySelectorAll("[data-search-token]").forEach(button=>button.addEventListener("click",()=>{
    const token=button.dataset.searchToken||"",input=$("search");input.value=(input.value.trim()+" "+token).trim();$("globalSearch").value=input.value;state.page=0;switchView("market",true);applyFilters();
  }));
  $("dealSort").addEventListener("change",renderDeals);
  $("saveBelowBestTarget").addEventListener("click",()=>{const id=state._belowBestId;if(id)saveTarget(id,$("belowBestTarget").value);});
  $("belowBestMinus10").addEventListener("click",()=>{const id=state._belowBestId,lot=state.lots.find(item=>String(item.lot_id)===String(id));if(lot&&isNum(lot.price)&&lot.price>0){$("belowBestTarget").value=String(Math.max(1,Math.floor(lot.price*.9)));saveTarget(id,$("belowBestTarget").value);}});
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
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { pollBackoffUntil = 0; pollFailureCount = 0; pollLive(); } });
})();
