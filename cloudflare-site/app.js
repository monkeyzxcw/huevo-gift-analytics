"use strict";
(function () {
  const $ = (id) => document.getElementById(id);
  const SVG = "http://www.w3.org/2000/svg";
  const PAGE = 50;
  const STALE_HOURS = 24;
  const HUEVO_HOSTS = /^https:\/\/(huevo\.su|huevo\.departament\.site)\//i;
  const TARGET_PRICE_MAX = 1e15;

  function unregisterLegacyServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    const legacyScript = new URL("./service-worker.js", location.href).href;
    navigator.serviceWorker.getRegistrations().then((registrations) =>
      Promise.all(registrations.filter((registration) =>
        [registration.active, registration.waiting, registration.installing]
          .some((worker) => worker && worker.scriptURL === legacyScript)
      ).map((registration) => registration.unregister()))
    ).catch(() => {});
  }
  unregisterLegacyServiceWorker();

  async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        ...options,
        headers: { "Accept": "application/json", ...(options.headers || {}) },
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted || (error && error.name === "AbortError")) {
        throw new Error("Превышено время ожидания ответа сервера (" + Math.ceil(timeoutMs / 1000) + " сек.).");
      }
      throw error;
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function fetchJson(url, options = {}, timeoutMs = 12000) {
    const response = await fetchWithTimeout(url, options, timeoutMs);
    if (!response.ok) throw new Error("HTTP " + response.status);
    let data;
    try { data = await response.json(); }
    catch (_) { throw new Error("Сервер вернул некорректный JSON."); }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Сервер вернул неожиданный формат данных.");
    }
    return data;
  }

  const ACCOUNT_PROFILE_URL = "./api/me";
  let accountState = {
    user: null, profilesReady: false, updatedAt: null, dirty: false, hydrating: false, authRevision: 0,
    revision: 0, saving: false, savePromise: null, profilePollRunning: false, saveTimer: null, pollTimer: null, authPromise: null, saveRetryCount: 0
  };
  let presenceState = { available: false, canManage: false, configured: false, loading: true, saving: false, error: "" };

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
    try {
      const x = JSON.parse(localStorage.getItem("amnyam.targets") || "{}");
      return x && typeof x === "object" && !Array.isArray(x)
        ? Object.fromEntries(Object.entries(x).filter(([id, value]) =>
            /^\d{1,20}$/.test(id) && Number.isSafeInteger(value) && value > 0 && value <= TARGET_PRICE_MAX
          ).slice(0, 5000))
        : {};
    } catch (_) { return {}; }
  }
  function writeTargets(){if(accountState.user){if(!accountState.hydrating)queueProfileSave();return;}try{localStorage.setItem("amnyam.targets",JSON.stringify(state.targets));}catch(_){}}
  function readAlertedTargets(){try{const x=JSON.parse(localStorage.getItem("amnyam.alertedTargets")||"[]");return Array.isArray(x)?x.map(String).filter(id=>/^\d{1,20}$/.test(id)).slice(0,5000):[];}catch(_){return [];}}
  function writeAlertedTargets(){if(accountState.user){if(!accountState.hydrating)queueProfileSave();return;}try{localStorage.setItem("amnyam.alertedTargets",JSON.stringify(state.alertedTargets));}catch(_){}}
  function readSavedFilters(){try{const x=JSON.parse(localStorage.getItem("amnyam.savedFilters")||"[]");return Array.isArray(x)?x.filter(i=>i&&typeof i.name==="string"&&i.name.trim()&&i.filters&&typeof i.filters==="object").slice(0,25):[];}catch(_){return [];}}
  function writeSavedFilters(){if(accountState.user){if(!accountState.hydrating)queueProfileSave();return;}try{localStorage.setItem("amnyam.savedFilters",JSON.stringify(state.savedFilters));}catch(_){}}
  const PORTFOLIO_KEY = "amnyam.portfolio.v1";
  function readPortfolio() {
    try {
      const raw = JSON.parse(localStorage.getItem(PORTFOLIO_KEY) || "[]");
      return Array.isArray(raw) ? raw.filter(item => item && typeof item.title === "string" && item.title.trim() &&
        Number.isSafeInteger(item.quantity) && item.quantity > 0 && item.quantity <= 1000 &&
        Number.isSafeInteger(item.purchase_price) && item.purchase_price > 0).slice(0, 100) : [];
    } catch (_) { return []; }
  }
  function writePortfolio() {
    if (accountState.user) { if (!accountState.hydrating) queueProfileSave(); }
    else { try { localStorage.setItem(PORTFOLIO_KEY, JSON.stringify(state.portfolio)); } catch (_) {} }
    renderPortfolio();
  }
  const state = {
    data:null,lots:[],view:[],page:0,sort:{key:"price",dir:1},groupSort:{key:"count",dir:-1},catalogMode:"lots",
    changeKind:"new",liveFingerprint:null,compareIds:[],activeView:"overview",favorites:readFavorites(),
    targets:readTargets(),alertedTargets:readAlertedTargets(),savedFilters:readSavedFilters(),portfolio:readPortfolio()
  };
  function publishMarketData() {
    const detail = {
      data: state.data, lots: state.lots, targets: { ...state.targets }, deals: buildDealSignals(),
      profileKey: accountState.user && accountState.user.id ? String(accountState.user.id) : "guest"
    };
    window.AMNYAM_MARKET = detail;
    window.dispatchEvent(new CustomEvent("amnyam:market", { detail }));
  }
  let livePollRunning = false;
  let lastHiddenPollAt = 0;
  let snapshotLoadRunning = false;
  let supportPaymentRunning = false;
  let pollFailureCount = 0;
  let pollBackoffUntil = 0;
  let lastSnapshotSignature = "";
  let supportConfig = { enabled: false, amounts: [5000, 10000, 25000, 50000, 100000] };
  let supportSdkReady = false;
  let supportInitRunning = false;
  const SUPPORT_INTENT_STORAGE_PREFIX = "amnyam.pending-support.v1";
  function supportIntentStorageKey() {
    const userId = new URLSearchParams(location.search).get("hu_user_id") || "";
    return SUPPORT_INTENT_STORAGE_PREFIX + "." + (/^\d{1,20}$/.test(userId) ? userId : "guest");
  }
  function readPendingSupportIntent() {
    try {
      const raw = JSON.parse(localStorage.getItem(supportIntentStorageKey()) || "null");
      if (!raw || typeof raw.intent_id !== "string" || !/^pi_[A-Za-z0-9_-]{1,80}$/.test(raw.intent_id) ||
          !Number.isFinite(raw.saved_at) || Date.now() - raw.saved_at > 7 * 24 * 60 * 60 * 1000) {
        localStorage.removeItem(supportIntentStorageKey());
        return null;
      }
      return raw.intent_id;
    } catch (_) { return null; }
  }
  function persistPendingSupportIntent(intentId) {
    supportStatusIntentId = intentId || null;
    try {
      if (supportStatusIntentId) localStorage.setItem(supportIntentStorageKey(), JSON.stringify({
        intent_id: supportStatusIntentId, saved_at: Date.now()
      }));
      else localStorage.removeItem(supportIntentStorageKey());
    } catch (_) {}
  }
  let supportStatusIntentId = readPendingSupportIntent();
  let supportStatusLookupRunning = false;

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
    if (snapshotLoadRunning) return;
    snapshotLoadRunning = true;
    show("loading");
    try {
      const json = await fetchJson("./data.json?_=" + Date.now(), { cache: "no-store" }, 12000);
      if (!Array.isArray(json.lots)) throw new Error("В снимке отсутствует обязательный список lots.");
      const n = normalise(json);
      state.data = n.raw; state.lots = n.lots;
      state.liveFingerprint = n.raw.live && n.raw.live.fingerprint ? String(n.raw.live.fingerprint) : null;
      lastSnapshotSignature = snapshotSignature(n.raw, n.lots);
      render();
      dismissPremiumSplash();
    } catch (error) {
      $("errorText").textContent = "Не удалось загрузить data.json (" + (error && error.message ? error.message : "ошибка") + "). Последний корректный снимок не заменён.";
      setBadge("err", "Данные недоступны");
      show("error");
      dismissPremiumSplash();
    } finally {
      snapshotLoadRunning = false;
    }
  }

  function snapshotSignature(raw, lots) {
    const live = raw && raw.live && typeof raw.live === "object" ? raw.live : {};
    const collector = raw && raw.collector && typeof raw.collector === "object" ? raw.collector : {};
    const lastSnapshot = Array.isArray(raw && raw.snapshots) ? raw.snapshots[raw.snapshots.length - 1] : null;
    const changes = raw && raw.changes && raw.changes.counts ? raw.changes.counts : null;

    // Canonicalise complete enrichment objects. The old signature only watched a
    // handful of gift_instance fields (and only the last event ID), so updates to
    // author, collection, owner, edition status, event labels/users/times, etc. were
    // downloaded every 3 seconds but silently ignored by the UI.
    const canonical = (value) => {
      if (Array.isArray(value)) return value.map(canonical);
      if (value && typeof value === "object") {
        return Object.keys(value).sort().map((key) => [key, canonical(value[key])]);
      }
      return value;
    };

    // Ignore last_poll_at and per-lot last_seen: those timestamps move on every poll
    // even when the visible market values did not change.
    return JSON.stringify({
      collector: [collector.status, collector.message, collector.lots, collector.pages,
        canonical(collector.gift_instances)],
      live: [live.fingerprint, Number(live.item_count) || 0],
      lots: (lots || []).map((lot) => [
        String(lot.lot_id), lot.title, lot.serial, lot.rarity, lot.price, lot.status,
        lot.active !== false,
        canonical(lot.gift_details),
        canonical(lot.gift_catalog),
        canonical(lot.gift_instance),
        canonical(lot.history)
      ]),
      stats: raw && raw.stats,
      sales: raw && raw.sales ? [raw.sales.generated_at, raw.sales.summary, Array.isArray(raw.sales.by_title) ? raw.sales.by_title.length : 0] : null,
      snapshots: Array.isArray(raw && raw.snapshots) ? raw.snapshots.length : 0,
      lastSnapshot: lastSnapshot ? [lastSnapshot.observed_at, lastSnapshot.active_lots, lastSnapshot.median_price] : null,
      changes: changes ? [changes.new, changes.gone, changes.price_up, changes.price_down] : null,
      gone: canonical(raw && raw.gone_lots),
      catalogEvents: canonical(raw && raw.catalog_events)
    });
  }

  async function pollFullSnapshot() {
    // The dashboard polls the Worker's merged /data.json, not only the first-page
    // endpoint. This lets both the 3-second live stream and the 5-minute full snapshot
    // reach every panel without reloading the document.
    if (livePollRunning || !state.data || Date.now() < pollBackoffUntil) return;
    if (document.visibilityState !== "visible") {
      // Do not poll a background tab every 3 seconds, but keep target alerts alive
      // while the browser is running and the app is minimized or on another tab.
      if (Date.now() - lastHiddenPollAt < 15000) return;
      lastHiddenPollAt = Date.now();
    }
    livePollRunning = true;
    try {
      const json = await fetchJson("./data.json?_=" + Date.now(), {
        cache: "no-store",
        headers: { "Accept": "application/json" }
      }, 10000);
      if (!Array.isArray(json.lots)) throw new Error("Некорректный снимок рынка: отсутствует список lots.");
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
        // Keep an already-open gift card in sync too; otherwise an enrichment arriving
        // while the user is viewing that lot would remain hidden until the dialog is reopened.
        const detailDialog = $("detail");
        if (detailDialog && detailDialog.open && activeDetailLotId) {
          const refreshedLot = state.lots.find((lot) => String(lot.lot_id) === activeDetailLotId);
          if (refreshedLot) openDetail(refreshedLot, lastTrigger);
        }
      } else {
        // Update non-visual metadata (including last successful full-snapshot time) without
        // rebuilding cards, charts, rows, the active tab, or the search controls.
        state.data = n.raw;
        renderState();
        renderSourceHealth();
        // Price targets must be evaluated on every successful poll, even when the
        // visible snapshot signature is unchanged and the background tab is throttled.
        checkTargetAlerts();
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

  let fastLivePollRunning = false;
  async function pollLive() {
    if (fastLivePollRunning || !state.data || Date.now() < pollBackoffUntil) return;
    if (document.visibilityState !== "visible") {
      if (Date.now() - lastHiddenPollAt < 15000) return;
      lastHiddenPollAt = Date.now();
    }
    fastLivePollRunning = true;
    try {
      const live = await fetchJson("./api/live/status?_=" + Date.now(), { cache: "no-store" }, 8000);
      pollFailureCount = 0;
      pollBackoffUntil = 0;
      state.data.live = {
        enabled: Boolean(live.enabled),
        fresh: Boolean(live.fresh),
        last_poll_at: live.last_poll_at || null,
        item_count: Number(live.item_count) || 0,
        age_seconds: Number.isFinite(Number(live.age_seconds)) ? Number(live.age_seconds) : null,
        fingerprint: live.fingerprint || null,
        message: live.fresh ? "Первая страница Huevo обновляется в реальном времени." :
          (live.enabled ? "Локальный опрос первой страницы не поступал более 15 секунд." : "Live-хранилище пока не включено.")
      };
      if (live.fresh && Array.isArray(live.items)) {
        const fingerprint = String(live.fingerprint || "");
        if (fingerprint && fingerprint !== state.liveFingerprint) {
          const byId = new Map(live.items.map(item => [String(item.lot_id), item]));
          const merged = state.lots.map(lot => {
            const fresh = byId.get(String(lot.lot_id));
            if (!fresh) return lot;
            byId.delete(String(lot.lot_id));
            return {
              ...lot,
              title: fresh.title || lot.title,
              serial: fresh.serial || lot.serial,
              rarity: fresh.rarity || lot.rarity,
              price: isNum(fresh.price) ? fresh.price : lot.price,
              status: fresh.status || lot.status,
              lot_url: fresh.lot_url || lot.lot_url,
              image_url: fresh.image_url || lot.image_url,
              active: true,
              last_seen: live.last_poll_at || lot.last_seen
            };
          });
          byId.forEach(item => merged.push({
            ...item,
            first_seen: live.last_poll_at || new Date().toISOString(),
            last_seen: live.last_poll_at || new Date().toISOString(),
            active: true,
            history: []
          }));
          state.lots = merged;
          state.liveFingerprint = fingerprint;
          state.data.price_bins = [];
          state.data.categories = [];
          state.data.top_expensive = merged.filter(lot => isNum(lot.price))
            .sort((a, b) => b.price - a.price).slice(0, 10);
          render();
          const detailDialog = $("detail");
          if (detailDialog && detailDialog.open && activeDetailLotId) {
            const refreshedLot = state.lots.find(lot => String(lot.lot_id) === activeDetailLotId);
            if (refreshedLot) openDetail(refreshedLot, lastTrigger);
          }
        } else {
          renderState();
          renderSourceHealth();
          checkTargetAlerts();
        }
      } else {
        renderState();
        renderSourceHealth();
      }
    } catch (_) {
      pollFailureCount = Math.min(pollFailureCount + 1, 5);
      const delays = [3000, 6000, 12000, 20000, 30000];
      pollBackoffUntil = Date.now() + delays[pollFailureCount - 1];
      const dot = $("stateDot"), label = $("stateText");
      if (dot && label && state.data) {
        dot.className = "dot warn";
        label.textContent = "Связь восстанавливается";
      }
    } finally {
      fastLivePollRunning = false;
    }
  }

  // ---------- optional target-price sound ----------
  const ALERT_SOUND_KEY = "amnyam.alertSound.v1";
  let alertSoundEnabled = false;
  let alertAudioContext = null;
  let soundVolume = 100;
  let soundPattern = "signature";
  let sniperSoundPrefs = { new: false, deal: false };
  try {
    const savedVolume = Number(localStorage.getItem("amnyam.sound.volume.v1"));
    if (Number.isInteger(savedVolume) && savedVolume >= 0 && savedVolume <= 100) soundVolume = savedVolume;
    const savedPattern = localStorage.getItem("amnyam.sound.pattern.v1");
    if (["signature", "soft", "double"].includes(savedPattern)) soundPattern = savedPattern;
    alertSoundEnabled = localStorage.getItem(ALERT_SOUND_KEY) === "on";
    sniperSoundPrefs = {
      new: localStorage.getItem("amnyam.sniperSound.new.v1") === "on",
      deal: localStorage.getItem("amnyam.sniperSound.deal.v1") === "on"
    };
  } catch (_) {}
  window.AMNYAM_SOUND_SETTINGS = {
    get: () => ({ ...sniperSoundPrefs, master: alertSoundEnabled, volume: soundVolume, pattern: soundPattern }),
    set: (kind, enabled) => {
      if (kind !== "new" && kind !== "deal") return false;
      sniperSoundPrefs[kind] = Boolean(enabled);
      if (accountState.user) {
        if (!accountState.hydrating) queueProfileSave();
      } else {
        try { localStorage.setItem("amnyam.sniperSound." + kind + ".v1", enabled ? "on" : "off"); } catch (_) {}
      }
      window.dispatchEvent(new CustomEvent("amnyam:sniper-sounds", { detail: { ...sniperSoundPrefs, master: alertSoundEnabled } }));
      return true;
    },
    masterEnabled: () => alertSoundEnabled,
    volume: () => soundVolume,
    pattern: () => soundPattern
  };
  function updateAlertSoundControls() {
    const toggle = $("toggleAlertSound"), hint = $("alertSoundHint");
    if (toggle) {
      toggle.textContent = "Звук: " + (alertSoundEnabled ? "включён" : "выключен");
      toggle.setAttribute("aria-pressed", String(alertSoundEnabled));
    }
    if (hint) hint.textContent = alertSoundEnabled
      ? "Звуковой сигнал AMNYAM включён. " + soundVolume + "% · " + soundPatternLabel(soundPattern) + "."
      : "Звуковые сигналы отключены. Включи их и нажми тест, чтобы услышать сигнал AMNYAM.";
    updateAdvancedSoundControls();
    window.dispatchEvent(new CustomEvent("amnyam:sniper-sounds", { detail: { ...sniperSoundPrefs, master: alertSoundEnabled } }));
  }
  function soundPatternLabel(pattern) {
    return ({ signature: "фирменный, 5 нот", soft: "мягкий, 3 ноты", double: "двойной, 2 ноты" })[pattern] || "фирменный, 5 нот";
  }
  function updateAdvancedSoundControls() {
    const volume = $("soundVolume"), volumeLabel = $("soundVolumeLabel"), pattern = $("soundPattern");
    if (volume) volume.value = String(soundVolume);
    if (volumeLabel) volumeLabel.textContent = soundVolume + "%";
    if (pattern) pattern.value = soundPattern;
  }
  function persistAdvancedSoundSettings() {
    if (accountState.user) {
      if (!accountState.hydrating) queueProfileSave();
    } else {
      try {
        localStorage.setItem("amnyam.sound.volume.v1", String(soundVolume));
        localStorage.setItem("amnyam.sound.pattern.v1", soundPattern);
      } catch (_) {}
    }
    updateAdvancedSoundControls();
    updateAlertSoundControls();
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
      const playMotif = () => {
        // AMNYAM signature: a bright five-note rising/falling arpeggio, rather
        // than the old generic two-beep alert. Triggered only by a user setting
        // or a target-price event.
        const notes = soundPattern === "soft" ? [659.25, 783.99, 1046.5]
          : soundPattern === "double" ? [880, 660] : [523.25, 659.25, 783.99, 1046.5, 783.99];
        const volume = Math.max(0, Math.min(100, soundVolume)) / 100;
        notes.forEach((frequency, index) => {
          const start = context.currentTime + index * (soundPattern === "double" ? 0.22 : 0.145);
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          oscillator.type = index === 4 ? "sine" : "triangle";
          oscillator.frequency.setValueAtTime(frequency, start);
          gain.gain.setValueAtTime(0.0001, start);
          const peak = soundPattern === "soft" ? 0.04 : soundPattern === "double" ? 0.052 : (index === 3 ? 0.065 : 0.048);
          gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * volume), start + 0.018);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
          oscillator.connect(gain);
          gain.connect(context.destination);
          oscillator.start(start);
          oscillator.stop(start + 0.17);
        });
      };
      if (context.state === "suspended") context.resume().then(playMotif).catch(() => {
        const hint = $("alertSoundHint");
        if (hint) hint.textContent = "Браузер приостановил звук. Нажми «Проверить звук» ещё раз.";
      });
      else playMotif();
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
    const volume = $("soundVolume"), pattern = $("soundPattern");
    if (volume) volume.addEventListener("input", () => {
      soundVolume = Math.max(0, Math.min(100, Number(volume.value) || 0));
      persistAdvancedSoundSettings();
    });
    if (pattern) pattern.addEventListener("change", () => {
      soundPattern = ["signature", "soft", "double"].includes(pattern.value) ? pattern.value : "signature";
      persistAdvancedSoundSettings();
    });
    updateAdvancedSoundControls();
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

    const fromText = $("historyFrom") ? $("historyFrom").value : "";
    const toText = $("historyTo") ? $("historyTo").value : "";
    const fromTime = fromText ? Date.parse(fromText + "T00:00:00") : null;
    const toTime = toText ? Date.parse(toText + "T23:59:59.999") : null;
    let snaps = (Array.isArray(state.data.snapshots) ? state.data.snapshots : []).filter(p => p && p.observed_at);
    if (Number.isFinite(fromTime)) snaps = snaps.filter(p => Date.parse(p.observed_at) >= fromTime);
    if (Number.isFinite(toTime)) snaps = snaps.filter(p => Date.parse(p.observed_at) <= toTime);
    if (fromText && toText && Number.isFinite(fromTime) && Number.isFinite(toTime) && fromTime > toTime) snaps = [];
    const rangeNote = $("historyRangeNote");
    if (rangeNote) rangeNote.textContent = fromText || toText
      ? (snaps.length ? "Выбрано снимков: " + fmt(snaps.length) : "Нет снимков в выбранном диапазоне")
      : "Все доступные снимки · " + fmt(snaps.length);
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
    document.querySelectorAll(".tabs [role=tab]").forEach((t) => {
      t.setAttribute("aria-selected", String(t.dataset.kind === state.changeKind));
    });

    const ch = raw && typeof raw === "object" ? raw : {};
    const counts = ch.counts && typeof ch.counts === "object" ? ch.counts : {};
    const goneFallback = Array.isArray(state.data.gone_lots) ? state.data.gone_lots : [];
    const goneById = new Map(goneFallback.map((item) => [String(item.lot_id), item]));
    const newRows = Array.isArray(ch.new) ? ch.new : [];
    const goneSource = Array.isArray(ch.gone) ? ch.gone : goneFallback;
    const goneRows = goneSource.map((item) => ({ ...item, ...(goneById.get(String(item.lot_id)) || {}) }));
    const eventRows = (Array.isArray(state.data.catalog_events) ? state.data.catalog_events : [])
      .slice().sort((a, b) => Date.parse(b.observed_at || "") - Date.parse(a.observed_at || ""));
    const salesRows = (Array.isArray(state.data.sales_history) ? state.data.sales_history : [])
      .slice().sort((a, b) => {
        const pageDiff = (Number(a.source_page) || 1e9) - (Number(b.source_page) || 1e9);
        return pageDiff || (Number(a.source_row) || 1e9) - (Number(b.source_row) || 1e9);
      });
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
      goneFallback.length > 0 || eventRows.length > 0 || salesRows.length > 0 || priceRows.length > 0 ||
      (Array.isArray(state.data.snapshots) && state.data.snapshots.length > 1);
    if (!available) {
      $("changesNote").textContent = "";
      list.append(h("li", { class: "empty", text: "Пока нет данных для сравнения. После успешных сборов здесь появятся новые, исчезнувшие лоты, изменения цен и события истории." }));
      return;
    }
    const k = state.changeKind;
    $("changesNote").textContent = k === "sales"
      ? "Подтверждённые сделки · " + fmt(salesRows.length) + " записей · новые страницы выше"
      : (ch.since ? "относительно " + when(ch.since) :
        (Array.isArray(state.data.snapshots) && state.data.snapshots.length > 1 ? "по последним снимкам" : "история каталога"));
    const tabIds = { new: "tabNew", gone: "tabGone", price: "tabPrice", events: "tabEvents", sales: "tabSales" };
    list.setAttribute("aria-labelledby", tabIds[k] || "tabNew");
    const rows = k === "new" ? newRows : k === "gone" ? goneRows
      : k === "events" ? eventRows : k === "sales" ? salesRows : priceRows;
    const inferredNew = k === "new" && !Array.isArray(ch.new);
    const total = k === "new" ? (Number.isFinite(Number(counts.new)) ? Number(counts.new) : rows.length)
      : k === "gone" ? (Number.isFinite(Number(counts.gone)) ? Number(counts.gone) : rows.length)
      : k === "events" ? eventRows.length
      : k === "sales" ? salesRows.length
      : (Number.isFinite(Number(counts.price_up)) || Number.isFinite(Number(counts.price_down))
        ? (Number(counts.price_up) || 0) + (Number(counts.price_down) || 0) : rows.length);
    if (!rows.length) {
      const message = k === "new" ? (inferredNew ? "Список новых лотов отсутствует в ответе источника." : "Новых лотов не обнаружено.")
        : k === "gone" ? "Исчезнувших лотов нет в текущем сравнении."
        : k === "events" ? "Новых событий истории экземпляров пока нет. Первичная загрузка истории формирует базу для дальнейшего сравнения."
        : k === "sales" ? "История завершённых сделок пока не собрана. После первого прохода /market/history здесь появятся реальные цены, продавцы и покупатели."
        : "Изменений цен по доступной истории нет.";
      list.append(h("li", { class: "empty", text: message }));
      return;
    }
    const disappearanceLabels = {
      pending_history: "История экземпляра проверяется",
      history_baseline: "История загружена — ожидаем следующих изменений",
      sold: "Продан в Маркете",
      transferred: "Передан другому владельцу",
      delisted: "Вероятно снят продавцом"
    };
    rows.slice(0, 50).forEach((r) => {
      if (k === "price") {
        const up = Number(r.to) > Number(r.from);
        list.append(lotItem(r, [h("span", { class: up ? "bad" : "good", text: fmt(r.from) + " → " + fmt(r.to) + " ◉" }), h("div", { class: "m", text: (r.pct != null ? (r.pct > 0 ? "+" : "") + fmt(r.pct) + "%" : "") })], "#" + r.lot_id));
      } else if (k === "events") {
        const flow = [r.from_user, r.to_user].filter(Boolean).join(" → ");
        const detail = [ "#" + (r.lot_id || "—"), r.serial, flow, r.time_raw ].filter(Boolean).join(" · ");
        list.append(lotItem(r, h("span", { text: r.label || "Изменение истории" }), detail));
      } else if (k === "sales") {
        const flow = [
          r.seller ? "Продавец: " + r.seller : "",
          r.buyer ? "Покупатель: " + r.buyer : ""
        ].filter(Boolean).join(" → ");
        const serial = r.serial ? "#" + r.serial : "";
        // Keep the value exactly as Huevo supplied it. A time like 01:22 is not
        // converted into a date, and an absent date is never inferred from observed_at.
        const saleTime = String(r.date_raw || r.sale_date || "").trim();
        const detail = [
          "#" + (r.lot_id || "—"), serial, flow,
          saleTime || "Дата сделки не указана Huevo"
        ].filter(Boolean).join(" · ");
        list.append(lotItem({
          ...r,
          lot_url: safeUrl(r.lot_url, r.lot_id),
          status: "Завершённая сделка"
        }, price(r.price), detail));
      } else if (k === "gone") {
        const stateLabel = disappearanceLabels[r.disappearance_status] || "Причина исчезновения пока не установлена";
        const instance = r.gift_instance || {};
        const serial = instance.serial ? "№ " + instance.serial + (instance.supply ? " из " + instance.supply : "") : "";
        list.append(lotItem(r, h("span", { text: price(r.price) }), "#" + r.lot_id + (serial ? " · " + serial : "") + " · " + stateLabel));
      } else {
        list.append(lotItem(r, price(r.price), "#" + r.lot_id + (r.rarity ? " · " + r.rarity : "")));
      }
    });
    if (total > rows.length) list.append(h("li", { class: "m", text: "Показано " + Math.min(rows.length, 50) + " из " + fmt(total) + "." }));
  }
  function renderTop() {
    const top = (Array.isArray(state.data.top_expensive) && state.data.top_expensive.length ? state.data.top_expensive : state.lots.filter((l) => isNum(l.price)).sort((a, b) => b.price - a.price).slice(0, 10));
    const list = clear($("topList"));
    if (!top.length) list.append(h("li", { class: "empty", text: "Нет лотов с ценой." }));
    top.forEach((l) => list.append(lotItem(l, price(l.price), "#" + l.lot_id + (l.rarity ? " · " + l.rarity : ""))));
  }

  function portfolioReference(item) {
    const title = normaliseSaleTitle(item.title);
    const rarity = normaliseSaleRarity(item.rarity);
    const group = state.lots.filter(lot => lot.active !== false &&
      normaliseSaleTitle(lot.title) === title &&
      normaliseSaleRarity(lot.rarity) === rarity &&
      isNum(lot.price) && lot.price > 0);
    const saleRows = state.data && state.data.sales && Array.isArray(state.data.sales.by_title_rarity)
      ? state.data.sales.by_title_rarity : [];
    const exactSale = rarity ? saleRows.find(row =>
      normaliseSaleTitle(row.title) === title &&
      normaliseSaleRarity(row.rarity) === rarity &&
      isNum(row.median) && row.median > 0) : null;
    if (exactSale && Number(exactSale.count) >= 3) {
      return { value: exactSale.median, basis: "подтверждённые продажи · точное название и редкость", sample: exactSale.count };
    }
    const offers = robustOfferReference(group.map(lot => lot.price));
    if (offers && !offers.ambiguous) return { value: offers.reference, basis: "активные объявления", sample: offers.sample_size };
    return null;
  }

  function renderPortfolio() {
    const list = $("portfolioList"), summary = $("portfolioSummary");
    if (!list || !summary) return;
    clear(list); clear(summary);
    $("portfolioCount").textContent = fmt(state.portfolio.length) + " позиций";
    const metricCard = (title, value, detail) => h("article", { class: "card" }, [
      h("div", { class: "k", text: title }),
      h("div", { class: "v", text: value }),
      h("div", { class: "s", text: detail })
    ]);
    if (!state.portfolio.length) {
      list.append(h("div", { class: "empty", text: "Портфель пока пуст. Добавь подарок, количество и цену покупки." }));
      summary.append(metricCard("Позиций", "0", "Добавь свои покупки"));
      return;
    }
    let invested = 0, investedValued = 0, estimated = 0, valued = 0;
    const rows = state.portfolio.map(item => {
      const reference = portfolioReference(item);
      const cost = item.purchase_price * item.quantity;
      invested += cost;
      if (reference) { estimated += reference.value * item.quantity; investedValued += cost; valued += 1; }
      const pnl = reference ? (reference.value - item.purchase_price) * item.quantity : null;
      const row = h("article", { class: "portfolio-row" }, [
        h("div", {}, [
          h("b", { text: item.title }),
          h("small", { text: (item.rarity || "Редкость не указана") + " · " + fmt(item.quantity) + " шт." })
        ]),
        h("div", { class: "portfolio-metric" }, [
          h("small", { text: "ВЛОЖЕНО" }), h("b", { text: price(cost) })
        ]),
        h("div", { class: "portfolio-metric" }, [
          h("small", { text: "ОЦЕНКА" }),
          h("b", { text: reference ? price(reference.value * item.quantity) : "Нет данных" }),
          h("small", { text: reference ? reference.basis + " · " + fmt(reference.sample) + " записей" : "Нужна выборка" })
        ]),
        h("div", { class: "portfolio-metric " + (pnl == null ? "" : pnl >= 0 ? "good" : "bad") }, [
          h("small", { text: "РЕЗУЛЬТАТ" }),
          h("b", { text: pnl == null ? "—" : (pnl >= 0 ? "+" : "") + price(pnl) })
        ]),
        h("button", { class: "btn secondary", type: "button", text: "Удалить", "aria-label": "Удалить " + item.title })
      ]);
      row.querySelector("button").addEventListener("click", () => {
        state.portfolio = state.portfolio.filter(entry => entry.id !== item.id);
        writePortfolio();
      });
      return row;
    });
    rows.forEach(row => list.append(row));
    summary.append(
      metricCard("Покупок", fmt(state.portfolio.length), "Разных позиций"),
      metricCard("Вложено", price(invested), "По сохранённой цене покупки"),
      metricCard("Оценка", valued ? price(estimated) : "Нет данных", fmt(valued) + " позиций с ориентиром"),
      metricCard("Результат", valued ? (estimated - investedValued >= 0 ? "+" : "") + price(estimated - investedValued) : "—", "Только по позициям с оценкой")
    );
  }

  function addPortfolioItem() {
    const title = $("portfolioGift").value.trim();
    const rarity = $("portfolioRarity").value.trim();
    const quantity = Number($("portfolioQuantity").value);
    const cost = Number($("portfolioCost").value);
    if (!title || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000 ||
        !Number.isSafeInteger(cost) || cost < 1 || cost > TARGET_PRICE_MAX) {
      $("portfolioForm").reportValidity();
      return;
    }
    const id = String(Date.now()) + "-" + Math.random().toString(36).slice(2, 8);
    state.portfolio.unshift({
      id, title: title.slice(0, 120), rarity: rarity.slice(0, 80),
      quantity, purchase_price: cost, added_at: new Date().toISOString()
    });
    state.portfolio = state.portfolio.slice(0, 100);
    $("portfolioForm").reset();
    $("portfolioQuantity").value = "1";
    writePortfolio();
  }

  function renderMarketEvents() {
    const list = $("marketEventsList");
    if (!list || !state.data) return;
    clear(list);
    const events = [];
    const add = (type, label, item) => {
      if (!item || typeof item !== "object") return;
      const title = item.title || item.gift_title || item.name || ("Лот #" + (item.lot_id || "—"));
      const time = item.observed_at || item.event_at || item.first_seen || item.last_seen || null;
      events.push({
        type, label, title: String(title), time,
        price: isNum(item.price) ? item.price : null,
        id: item.lot_id || item.id || null
      });
    };
    const changes = state.data.changes && typeof state.data.changes === "object" ? state.data.changes : {};
    (Array.isArray(changes.new) ? changes.new : []).slice(0, 40).forEach(item => add("new", "Новый лот", item));
    (Array.isArray(changes.price_changes) ? changes.price_changes : []).slice(0, 40).forEach(item => add("price", "Изменение цены", item));
    (Array.isArray(changes.gone) ? changes.gone : []).slice(0, 40).forEach(item => add("gone", "Лот больше не найден", item));
    (Array.isArray(state.data.catalog_events) ? state.data.catalog_events : []).slice(0, 40)
      .forEach(item => add("catalog", item.label || item.event || "Событие экземпляра", item));
    const timeValue = value => {
      const parsed = Date.parse(value || "");
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const sorted = events.sort((a, b) => timeValue(b.time) - timeValue(a.time)).slice(0, 30);
    $("marketEventsCount").textContent = fmt(events.length) + " событий";
    if (!sorted.length) {
      list.append(h("li", { class: "empty", text: "События появятся после следующих сравнений снимков и истории экземпляров." }));
      return;
    }
    sorted.forEach(event => list.append(h("li", { class: "market-event-row" }, [
      h("div", {}, [
        h("b", { text: event.title }),
        h("small", { text: event.label + " · " + (event.time ? when(event.time) : "дата не указана") + (event.id ? " · #" + event.id : "") })
      ]),
      h("span", { class: "event-value", text: event.price != null ? price(event.price) : " " })
    ])));
  }

  function renderGiftCatalogIndex() {
    const grid = $("giftCatalogGrid");
    if (!grid || !state.data) return;
    clear(grid);
    const rows = Array.isArray(state.data.gift_catalog_index) ? state.data.gift_catalog_index : [];
    const search = String($("giftCatalogSearch").value || "").trim().toLocaleLowerCase("ru");
    const sort = $("giftCatalogSort").value;
    const filtered = rows.filter(item => item && typeof item === "object" &&
      (!search || [item.title, item.name, item.catalog_id, item.gift_catalog_id].some(value =>
        String(value || "").toLocaleLowerCase("ru").includes(search))));
    if (sort === "supply_desc") filtered.sort((a, b) => (Number(b.supply) || 0) - (Number(a.supply) || 0));
    else if (sort === "supply_asc") filtered.sort((a, b) => (Number(a.supply) || 0) - (Number(b.supply) || 0));
    else filtered.sort((a, b) => String(a.title || a.name || "").localeCompare(String(b.title || b.name || ""), "ru"));
    $("giftCatalogCount").textContent = fmt(filtered.length) + " из " + fmt(rows.length) + " карточек";
    if (!filtered.length) {
      grid.append(h("div", { class: "empty", text: rows.length ? "Нет совпадений по поиску." : "Индекс /gifts пока не поступил. Он собирается независимо от активных лотов." }));
      return;
    }
    filtered.slice(0, 150).forEach(item => {
      const id = String(item.catalog_id || item.gift_catalog_id || item.id || "");
      const imageUrl = typeof item.image_url === "string" && /^https:\/\//i.test(item.image_url) ? item.image_url : "";
      const image = imageUrl ? h("img", { src: imageUrl, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }) : h("span", { class: "thumb", text: "🎁" });
      const title = String(item.title || item.name || ("Подарок #" + (id || "—")));
      const body = h("div", {}, [
        h("b", { text: title }),
        h("small", { text: (id ? "Каталог #" + id : "ID не указан") +
          (item.supply ? " · тираж " + fmt(Number(item.supply)) : "") +
          (item.rarity ? " · " + item.rarity : "") })
      ]);
      const node = h("article", { class: "catalog-index-card" }, [image, body]);
      if (/^\d{1,20}$/.test(id)) node.append(h("a", {
        class: "btn secondary", href: "https://huevo.su/gifts/" + encodeURIComponent(id),
        target: "_blank", rel: "noopener noreferrer", text: "Открыть /gifts ↗"
      }));
      grid.append(node);
    });
  }

  function refreshGlobalSearchSuggestions() {
    const box = $("globalSearchSuggestions");
    if (!box || !state.data) return;
    clear(box);
    const names = new Set();
    state.lots.forEach(lot => {
      if (lot.title) names.add(String(lot.title));
      names.add(String(lot.lot_id));
    });
    const sales = state.data.sales && Array.isArray(state.data.sales.by_title) ? state.data.sales.by_title : [];
    sales.forEach(item => { if (item.title) names.add(String(item.title)); });
    const catalog = Array.isArray(state.data.gift_catalog_index) ? state.data.gift_catalog_index : [];
    catalog.forEach(item => { if (item && (item.title || item.name)) names.add(String(item.title || item.name)); });
    Array.from(names).slice(0, 500).forEach(value => box.append(h("option", { value })));
  }

  // ---------- collector source health: expose real per-source progress, never infer success ----------
  function renderSourceHealth() {
    const data = state.data || {};
    const collector = data.collector && typeof data.collector === "object" ? data.collector : {};
    const live = data.live && typeof data.live === "object" ? data.live : {};
    const salesState = collector.sales_history || data.sales_history_state || {};
    const indexState = collector.gift_catalog_index || {};
    const detailState = collector.gift_catalog_details || {};
    const instanceState = collector.gift_instances || {};
    const salesRows = Array.isArray(data.sales_history) ? data.sales_history : [];
    const catalogIndex = Array.isArray(data.gift_catalog_index) ? data.gift_catalog_index : [];
    const catalogDetails = Array.isArray(data.gift_catalogs) ? data.gift_catalogs : [];

    const statusText = (value) => ({
      ok: "Успешно",
      blocked: "Пауза Huevo",
      error: "Ошибка",
      pending: "В очереди",
      saved: "Данные сохранены",
      fresh: "Обновляется",
      stale: "Нет свежего сигнала",
      unknown: "Нет метаданных"
    }[String(value || "unknown").toLowerCase()] || "Неизвестный статус");
    const dateText = (value) => {
      if (!value) return "Время проверки не записано";
      const date = new Date(value);
      return Number.isFinite(date.getTime()) ? "Проверено: " + when(date.toISOString()) : "Время проверки не распознано";
    };
    const card = (name, status, value, detail, checkedAt) => {
      const key = ["ok", "blocked", "error", "pending", "saved", "fresh", "stale"].includes(status) ? status : "unknown";
      return h("article", { class: "source-health-card" }, [
        h("div", { class: "source-health-head" }, [
          h("b", { text: name }),
          h("span", { class: "source-health-status " + key, text: statusText(key) })
        ]),
        h("strong", { class: "source-health-value", text: value }),
        h("p", { class: "source-health-detail", text: detail }),
        h("small", { class: "source-health-time", text: dateText(checkedAt) })
      ]);
    };

    const marketCount = Number.isFinite(Number(collector.lots)) ? Number(collector.lots) : state.lots.length;
    const marketStatus = collector.status || (data.generated_at ? "saved" : "unknown");
    const liveStatus = live.fresh ? "fresh" : (live.enabled ? "stale" : "unknown");
    const salesCount = Number.isFinite(Number(salesState.total)) ? Number(salesState.total)
      : (Number.isFinite(Number(salesState.total_records)) ? Number(salesState.total_records) : salesRows.length);
    const indexCount = Number.isFinite(Number(indexState.cards)) ? Number(indexState.cards) : catalogIndex.length;
    const detailsCount = Number.isFinite(Number(detailState.known)) ? Number(detailState.known) : catalogDetails.length;
    const detailsIndexTotal = Number(detailState.index_total) || indexCount;
    const detailsCoverage = detailsIndexTotal > 0
      ? Math.min(100, Math.round(detailsCount / detailsIndexTotal * 100)) : null;
    const cards = [
      card("Полный рынок", marketStatus, fmt(marketCount) + " лотов",
        (collector.pages ? fmt(collector.pages) + " страниц в последнем проходе" : "Число страниц последнего прохода не записано") +
        (collector.message ? " · " + collector.message : ""), collector.checked_at || data.generated_at),
      card("Live · первая страница", liveStatus, fmt(Number(live.item_count) || 0) + " лотов",
        live.last_poll_at ? "Последний сигнал: " + when(live.last_poll_at) : "Локальный опрос первой страницы ещё не поступал",
        live.last_poll_at),
      card("История завершённых продаж", salesState.status || (salesCount ? "saved" : "unknown"),
        fmt(salesCount) + " записей",
        (salesState.pages ? fmt(salesState.pages) + " страниц обработано в последнем цикле" : "Страницы истории ещё не подтверждены") +
        (salesState.total_pages ? " · всего страниц: " + fmt(salesState.total_pages) : "") +
        (salesState.new_records ? " · новых: " + fmt(salesState.new_records) : (salesState.updated ? " · новых: " + fmt(salesState.updated) : "")),
        salesState.checked_at),
      card("Независимый индекс /gifts", indexState.status || (indexCount ? "saved" : "unknown"),
        fmt(indexCount) + " карточек",
        "Канонический список подарков, собирается независимо от активных объявлений",
        indexState.checked_at || data.gift_catalog_index_checked_at),
      card("Подробности каталога", detailState.status || (detailsCount ? "saved" : "unknown"),
        fmt(Number(detailState.updated) || 0) + " обновлено",
        fmt(detailsCount) + " полных карточек · из " + fmt(detailsIndexTotal) + " в индексе" +
        (detailsCoverage == null ? "" : " · покрытие " + detailsCoverage + "%") +
        " · попыток: " + fmt(Number(detailState.attempted) || 0),
        detailState.checked_at),
      card("Экземпляры и история владельцев", instanceState.status || "unknown",
        fmt(Number(instanceState.updated) || 0) + " обновлено",
        fmt(Number(instanceState.events_added) || 0) + " новых событий истории · попыток: " +
        fmt(Number(instanceState.attempted) || 0) + " · пакетов: " + fmt(Number(instanceState.batches) || 0),
        instanceState.checked_at)
    ];

    const grid = clear($("sourceHealthGrid"));
    grid.append(...cards);
    const checked = [collector.checked_at, salesState.checked_at, indexState.checked_at,
      detailState.checked_at, instanceState.checked_at || instanceState.updated_at || instanceState.last_attempt_at || instanceState.last_checked_at, live.last_poll_at]
      .filter(Boolean).map(value => new Date(value).getTime()).filter(Number.isFinite);
    $("sourceHealthUpdated").textContent = checked.length
      ? "Последняя активность · " + when(new Date(Math.max(...checked)).toISOString())
      : "Ожидаются первые метаданные сборщика";
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
  function downloadCsvFile(fileName, columns, rows) {
    if (!Array.isArray(rows) || !rows.length) return false;
    const cell = value => {
      const numeric = typeof value === "number" && Number.isFinite(value);
      let text = value == null ? "" : String(value);
      const trimmed = text.trimStart();
      if (!numeric && ["=", "+", "-", "@", "\t", "\r"].some(prefix => trimmed.startsWith(prefix))) text = "'" + text;
      return numeric ? text : '"' + text.replace(/"/g, '""') + '"';
    };
    const csv = [columns.map(column => cell(column[0])).join(";")]
      .concat(rows.map(row => columns.map(column => cell(column[1](row))).join(";")))
      .join("\r\n");
    const blob = new Blob([String.fromCharCode(0xfeff), csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    return true;
  }

  function exportGiftCatalogCsv() {
    const rows = Array.isArray(state.data && state.data.gift_catalog_index) ? state.data.gift_catalog_index : [];
    const ok = downloadCsvFile("amnyam-gift-catalog-" + new Date().toISOString().slice(0, 10) + ".csv", [
      ["ID каталога", item => item.catalog_id || item.gift_catalog_id || item.id],
      ["Подарок", item => item.title || item.name],
      ["Тираж", item => item.supply],
      ["Редкость", item => item.rarity],
      ["Ссылка", item => "https://huevo.su/gifts/" + encodeURIComponent(String(item.catalog_id || item.gift_catalog_id || item.id || ""))]
    ], rows);
    if (!ok) $("giftCatalogCount").textContent = "Нет карточек для экспорта";
  }

  function exportPortfolioCsv() {
    const ok = downloadCsvFile("amnyam-portfolio-" + new Date().toISOString().slice(0, 10) + ".csv", [
      ["Подарок", item => item.title], ["Редкость", item => item.rarity],
      ["Количество", item => item.quantity], ["Цена покупки", item => item.purchase_price],
      ["Всего вложено", item => item.quantity * item.purchase_price],
      ["Добавлено", item => item.added_at]
    ], state.portfolio);
    if (!ok) $("portfolioCount").textContent = "Нет позиций для экспорта";
  }

  function exportEventsCsv() {
    const changes = state.data && state.data.changes && typeof state.data.changes === "object" ? state.data.changes : {};
    const rows = [];
    const push = (type, item) => {
      if (item && typeof item === "object") rows.push({
        type, title: item.title || item.gift_title || item.name || "",
        lot_id: item.lot_id || "", price: item.price,
        observed_at: item.observed_at || item.event_at || item.first_seen || item.last_seen || "",
        detail: item.label || item.event || item.status || ""
      });
    };
    (Array.isArray(changes.new) ? changes.new : []).forEach(item => push("Новый лот", item));
    (Array.isArray(changes.price_changes) ? changes.price_changes : []).forEach(item => push("Изменение цены", item));
    (Array.isArray(changes.gone) ? changes.gone : []).forEach(item => push("Лот не найден", item));
    (Array.isArray(state.data.catalog_events) ? state.data.catalog_events : []).forEach(item => push("Событие экземпляра", item));
    const ok = downloadCsvFile("amnyam-market-events-" + new Date().toISOString().slice(0, 10) + ".csv", [
      ["Тип", item => item.type], ["Подарок", item => item.title],
      ["ID лота", item => item.lot_id], ["Цена", item => item.price],
      ["Дата источника", item => item.observed_at], ["Событие", item => item.detail]
    ], rows);
    if (!ok) $("marketEventsCount").textContent = "Нет событий для экспорта";
  }

  function exportMarketCsv() {
    const rows = Array.isArray(state.view) ? state.view : [];
    if (!rows.length) {
      $("exportCsvStatus").textContent = "Нет строк для экспорта";
      return;
    }
    const columns = [
      ["ID лота", lot => lot.lot_id],
      ["Подарок", lot => lot.title],
      ["Серийный номер", lot => lot.serial],
      ["Цена", lot => lot.price],
      ["Редкость", lot => lot.rarity],
      ["Статус", lot => lot.status],
      ["Похожие лоты", lot => lot._lotCount],
      ["Изменение к минимуму, %", lot => lot._delta],
      ["Впервые замечен", lot => lot.first_seen],
      ["Последнее наблюдение", lot => lot.last_seen],
      ["Ссылка", lot => lot.lot_url]
    ];
    const cell = value => {
      const numeric = typeof value === "number" && Number.isFinite(value);
      let text = value == null ? "" : String(value);
      const trimmed = text.trimStart();
      if (!numeric && ["=", "+", "-", "@", "\t", "\r"].some(prefix => trimmed.startsWith(prefix))) text = "'" + text;
      return numeric ? text : '"' + text.replace(/"/g, '""') + '"';
    };
    const csv = [columns.map(column => cell(column[0])).join(";")]
      .concat(rows.map(lot => columns.map(column => cell(column[1](lot))).join(";")))
      .join("\r\n");
    const blob = new Blob([String.fromCharCode(0xfeff), csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "amnyam-market-" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    $("exportCsvStatus").textContent = "Экспортировано строк: " + fmt(rows.length);
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
  let activeDetailLotId = null;
  function openDetail(l, trigger) {
    lastTrigger = trigger;
    activeDetailLotId = String(l.lot_id);
    $("dTitle").textContent = l.title || ("Лот #" + l.lot_id);
    const body = clear($("dBody"));
    const imageCandidates = [];
    const addImage = value => {
      const url = typeof value === "string" ? value :
        value && typeof value === "object" ? (value.image_url || value.url || value.src || value.preview_url) : "";
      if (typeof url === "string" && /^https:\/\/(?:huevo\.su|huevo\.departament\.site)\//i.test(url) && !imageCandidates.includes(url)) {
        imageCandidates.push(url);
      }
    };
    const addImageGroup = value => {
      if (!value) return;
      if (Array.isArray(value)) value.forEach(addImage);
      else if (typeof value === "object") {
        addImage(value.image_url); addImage(value.image); addImage(value.preview_url); addImage(value.thumbnail);
        if (Array.isArray(value.images)) value.images.forEach(addImage);
        if (Array.isArray(value.gallery)) value.gallery.forEach(addImage);
      }
    };
    addImage(l.image_url);
    addImageGroup(l.gift_catalog);
    addImageGroup(l.gift_details);
    addImageGroup(l.gift_instance);
    const gallery = h("div", { class: "detail-image-gallery" });
    const heroImage = imageCandidates.length
      ? h("img", { class: "detail-hero-image", src: imageCandidates[0], alt: l.title || "Подарок", referrerpolicy: "no-referrer" })
      : h("span", { class: "detail-hero-placeholder", text: "🎁", "aria-hidden": "true" });
    gallery.append(heroImage);
    if (imageCandidates.length > 1) {
      const thumbs = h("div", { class: "detail-image-thumbs" });
      imageCandidates.slice(0, 8).forEach((url, index) => {
        const button = h("button", { class: "detail-image-thumb", type: "button", "aria-label": "Изображение " + (index + 1), "aria-pressed": String(index === 0) }, [
          h("img", { src: url, alt: "", loading: "lazy", referrerpolicy: "no-referrer" })
        ]);
        button.addEventListener("click", () => {
          if (heroImage.tagName === "IMG") heroImage.src = url;
          thumbs.querySelectorAll("button").forEach(item => item.setAttribute("aria-pressed", String(item === button)));
        });
        thumbs.append(button);
      });
      gallery.append(thumbs);
    }
    body.append(h("div", { class: "dl-top" }, [gallery, h("div", {}, [
      h("div", { class: "price", text: price(l.price) }),
      h("div", { class: "muted", text: "Цена объявления, не цена сделки" }),
      h("small", { class: "muted", text: imageCandidates.length > 1 ? "Галерея · " + imageCandidates.length + " изображений источника" : "Изображение из карточки подарка" })
    ])]));
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
    const details = l.gift_details && typeof l.gift_details === "object" ? l.gift_details : null;
    const rawAttributes = details && (details.attributes || details.characteristics || details.properties || details.gift_attributes);
    const metadataKeys = new Set(["gift_id","gift_url","checked_at","status","message","error","source_url","attributes","characteristics","properties","gift_attributes"]);
    const attributeText = (value) => {
      if (typeof value === "string") return value.trim();
      if (typeof value === "number" && Number.isFinite(value)) return fmt(value);
      if (typeof value === "boolean") return value ? "Да" : "Нет";
      if (Array.isArray(value)) return value.map(attributeText).filter(Boolean).join(", ");
      if (value && typeof value === "object") {
        const main = ["value","display_value","display_name","name","title","label","text"].map(key => value[key]).find(item => item != null && item !== "");
        if (main == null) return "";
        const rarity = value.rarity_text || value.rarity;
        return attributeText(main) + (rarity != null && rarity !== "" ? " · редкость " + attributeText(rarity) : "");
      }
      return "";
    };
    let attributePairs = [];
    if (Array.isArray(rawAttributes)) {
      attributePairs = rawAttributes.map(item => {
        if (!item || typeof item !== "object") return [null, item];
        const key = item.key || item.type || item.attribute || item.label || item.name;
        const value = item.value ?? item.display_value ?? item.display_name ?? item.title ?? item.text;
        return [key, value];
      });
    } else if (rawAttributes && typeof rawAttributes === "object") {
      attributePairs = Object.entries(rawAttributes);
    } else if (details) {
      attributePairs = Object.entries(details).filter(([key]) => !metadataKeys.has(key.toLowerCase()));
    }
    const attributes = attributePairs.map(([key,value]) => [
      typeof key === "string" ? key.trim() : "",
      attributeText(value)
    ]).filter(([key,value]) => key && /^[a-zа-яё0-9_\s-]{2,40}$/i.test(key) && value);
    body.append(h("h4", { text: "Характеристики подарка" }));
    if (attributes.length) {
      const labels = {
        model:"Модель", model_name:"Модель", backdrop:"Фон", background:"Фон", backdrop_name:"Фон",
        symbol:"Символ", symbol_name:"Символ", pattern:"Узор", pattern_name:"Узор",
        rarity:"Редкость", serial:"Номер", supply:"Тираж", collection:"Коллекция"
      };
      body.append(h("dl", { class: "kv gift-attributes" }, attributes.map(([key,value]) => {
        const normalKey = key.toLowerCase().replace(/[ -]+/g, "_");
        return h("div", {}, [h("dt", { text: labels[normalKey] || key }), h("dd", { text: value })]);
      })));
      body.append(h("p", { class: "muted foot", text: "Характеристики извлечены из карточки подарка Huevo. Значения и редкость показываются только если они присутствуют в данных источника." }));
    } else {
      const aggregate = state.data && state.data.collector && state.data.collector.gift_details;
      const updated = aggregate && Number.isFinite(Number(aggregate.updated)) ? Number(aggregate.updated) : 0;
      const emptyMessage = details
        ? "Карточка этого подарка обработана, но распознанных характеристик в её записи нет. Сборщик не подставляет догадки."
        : updated > 0
          ? "Сборщик сообщает о проверке " + fmt(updated) + " карточек подарков, но характеристики этого экземпляра не прикреплены к лоту. Нужна повторная отправка или привязка результата по ID подарка."
          : "Для этого подарка пока нет сохранённой расшифровки характеристик. Ожидается результат анализа карточки сборщиком.";
      body.append(h("div", { class: "empty", text: emptyMessage }));
    }

    const instance = l.gift_instance && typeof l.gift_instance === "object" ? l.gift_instance : null;
    const catalogCandidate = l.gift_catalog && typeof l.gift_catalog === "object" ? l.gift_catalog : null;
    const catalogId = String(catalogCandidate && (catalogCandidate.catalog_id || catalogCandidate.gift_catalog_id) || "");
    const giftCatalog = catalogCandidate && catalogCandidate.source === "huevo_gift_catalog_page" && /^\d{1,20}$/.test(catalogId) ? catalogCandidate : null;
    body.append(h("h4", { text: "Экземпляр и тираж" }));
    if (giftCatalog) {
      const soldOutLabel = giftCatalog.edition_sold_out === true ? "Тираж разошёлся"
        : giftCatalog.edition_sold_out === false ? "Тираж ещё доступен / распродажа не отмечена" : "Не указано на странице подарка";
      const catalogRows = [
        ["Подарок", giftCatalog.title || l.title || "—"],
        ["Полный тираж", isNum(giftCatalog.supply) ? fmt(giftCatalog.supply) : "—"],
        ["Выпущено экземпляров", isNum(giftCatalog.issued) ? fmt(giftCatalog.issued) : "—"],
        ["Цена выпуска", isNum(giftCatalog.drop_price) ? price(giftCatalog.drop_price) : (giftCatalog.drop_price_text || "—")],
        ["Состояние тиража", soldOutLabel],
        ["Редкость", giftCatalog.rarity || "—"],
        ["Автор дизайна", giftCatalog.author || "—"],
        ["Коллекция", giftCatalog.collection || "—"]
      ];
      body.append(h("dl", { class: "kv gift-attributes" }, catalogRows.map((pair) =>
        h("div", {}, [h("dt", { text: pair[0] }), h("dd", { text: pair[1] })]))));
      const catalogAttributes = giftCatalog.attributes && typeof giftCatalog.attributes === "object"
        ? Object.entries(giftCatalog.attributes) : [];
      if (catalogAttributes.length) {
        body.append(h("dl", { class: "kv gift-attributes" }, catalogAttributes
          .filter(([key, value]) => key && value != null && String(value).trim())
          .map(([key, value]) => h("div", {}, [
            h("dt", { text: String(key) }),
            h("dd", { text: String(value) })
          ]))));
      }
      const catalogId = String(giftCatalog.catalog_id || giftCatalog.gift_catalog_id || "");
      // Build the catalogue URL from its numeric catalogue ID only; never
      // reuse an arbitrary source URL or a /gift/<instance> path.
      const catalogHref = /^\d{1,20}$/.test(catalogId)
        ? "https://huevo.su/gifts/" + catalogId : "";
      if (catalogHref) {
        body.append(h("p", {}, [h("a", { class: "btn secondary", href: catalogHref, target: "_blank", rel: "noopener noreferrer", text: "Открыть страницу подарка и тираж ↗" })]));
      }
      body.append(h("p", { class: "muted foot", text: "Данные о тираже, цене выпуска и статусе выпуска загружены со страницы подарка /gifts/{id}. Они не подменяются информацией из личной страницы конкретного экземпляра." }));
    } else {
      body.append(h("div", { class: "empty", text: "Информация о тираже ещё не получена со страницы подарка /gifts/{id}. Старые поля с личной страницы /gift/{id} не используются как источник тиража." }));
    }

    if (instance) {
      const instanceRows = [
        ["Номер экземпляра", instance.serial ? "№ " + fmt(instance.serial) : "—"],
        ["Редкость экземпляра", instance.rarity || "—"],
        ["Текущий владелец", instance.current_owner || "—"]
      ];
      body.append(h("dl", { class: "kv gift-attributes" }, instanceRows.map((pair) =>
        h("div", {}, [h("dt", { text: pair[0] }), h("dd", { text: pair[1] })]))));
      const rawInstanceUrl = String(instance.gift_url || "");
      const instanceHref = /^https:\/\/(?:huevo\.su|huevo\.departament\.site)\/gift\/\d+\/?$/i.test(rawInstanceUrl)
        ? rawInstanceUrl : "";
      if (instanceHref) {
        body.append(h("a", { class: "btn secondary", href: instanceHref, target: "_blank", rel: "noopener noreferrer", text: "Открыть страницу конкретного экземпляра ↗" }));
      }
    } else {
      body.append(h("div", { class: "empty", text: "Данные конкретного экземпляра — номер, владелец и история — ещё не собраны." }));
    }

    body.append(h("h4", { text: "История экземпляра: кто кому" }));
    const events = Array.isArray(instance && instance.history) ? instance.history.slice().reverse().slice(0, 20) : [];
    if (!instance || !instance.history_found) {
      body.append(h("div", { class: "empty", text: "История конкретного экземпляра ещё не получена или её блок не удалось распознать." }));
    } else if (!events.length) {
      body.append(h("div", { class: "empty", text: "Блок истории доступен, но событий в нём нет." }));
    } else {
      const eventList = h("ul", { class: "list" });
      events.forEach((event) => {
        const flow = [event.from_user, event.to_user].filter(Boolean).join(" → ") || "Участники не указаны";
        eventList.append(h("li", { class: "li" }, [
          h("span", { class: "thumb", text: "↗", "aria-hidden": "true" }),
          h("div", {}, [
            h("div", { class: "t", text: event.label || "Изменение истории" }),
            h("div", { class: "m", text: flow })
          ]),
          h("div", { class: "p", text: event.time_raw || "—" })
        ]));
      });
      body.append(eventList);
      if (instance.history.length > events.length) {
        body.append(h("p", { class: "muted foot", text: "Показаны последние " + fmt(events.length) + " из " + fmt(instance.history.length) + " событий." }));
      }
    }
    body.append(h("p", { class: "muted foot", text: "Номер, владелец и история относятся к конкретному экземпляру. Тираж и цена выпуска берутся отдельно со страницы /gifts/{id}. События истории не содержат сумму каждой сделки." }));

    const watch=h("div",{class:"detail-watch"});
    const fav=h("button",{class:"btn secondary",type:"button",text:state.favorites.includes(String(l.lot_id))?"★ В избранном":"☆ В избранное"});
    fav.addEventListener("click",()=>{toggleFavorite(l.lot_id);fav.textContent=state.favorites.includes(String(l.lot_id))?"★ В избранном":"☆ В избранное";});
    const target=h("input",{class:"input target-input",type:"number",min:"1",step:"1",inputmode:"numeric",placeholder:"Целевая цена","aria-label":"Целевая цена для "+(l.title||l.lot_id)});
    target.value=state.targets[String(l.lot_id)]?String(state.targets[String(l.lot_id)]):"";
    const save=h("button",{class:"btn",type:"button",text:"Сохранить цену-цель"});
    const targetError=h("small",{class:"target-error","role":"alert","aria-live":"polite"});
    save.addEventListener("click",()=>{
      if(saveTarget(l.lot_id,target.value,targetError))save.textContent=target.value.trim()?"Цена-цель сохранена":"Цель удалена";
    });
    watch.append(fav,target,save);body.append(watch,targetError);
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
    // Split the long detail sheet into four focused panes, moving existing
    // nodes so all original controls and event handlers remain intact.
    const detailGroups = {
      overview: h("div", { class: "detail-pane", "data-detail-pane": "overview" }),
      catalog: h("div", { class: "detail-pane", "data-detail-pane": "catalog" }),
      history: h("div", { class: "detail-pane", "data-detail-pane": "history" }),
      actions: h("div", { class: "detail-pane", "data-detail-pane": "actions" })
    };
    let activeGroup = "overview";
    Array.from(body.childNodes).forEach(node => {
      if (node.nodeType === 1 && node.tagName === "H4") {
        const heading = node.textContent.toLocaleLowerCase("ru");
        if (heading.includes("история")) activeGroup = "history";
        else if (heading.includes("характеристики") || heading.includes("экземпляр и тираж")) activeGroup = "catalog";
      }
      if (node.nodeType === 1 && (node.classList.contains("detail-watch") || node.classList.contains("target-error"))) activeGroup = "actions";
      if (node.nodeType === 1 && node.tagName === "P" && node.textContent.includes("Открыть лот на Huevo")) activeGroup = "actions";
      detailGroups[activeGroup].append(node);
    });
    clear(body);
    const detailTabs = $("detailWorkspaceTabs");
    detailTabs.querySelectorAll("[data-detail-tab]").forEach(button => {
      button.setAttribute("aria-selected", String(button.dataset.detailTab === "overview"));
      button.onclick = () => {
        detailTabs.querySelectorAll("[data-detail-tab]").forEach(tab => {
          tab.setAttribute("aria-selected", String(tab === button));
        });
        Object.entries(detailGroups).forEach(([key, pane]) => {
          pane.classList.toggle("hide", key !== button.dataset.detailTab);
        });
      };
    });
    detailGroups.catalog.classList.add("hide");
    detailGroups.history.classList.add("hide");
    detailGroups.actions.classList.add("hide");
    body.append(detailGroups.overview, detailGroups.catalog, detailGroups.history, detailGroups.actions);
    const dlg = $("detail");
    if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
  }

  function mainViewFor(view) {
    const groups = {
      overview:"overview", market:"market", sniper:"sniper",
      deals:"opportunities", cheap:"opportunities",
      analytics:"analytics", events:"analytics", data:"data", sales:"data",
      favorites:"portfolio", portfolio:"portfolio",
      appearance:"settings", support:"settings", help:"settings"
    };
    return groups[view] || "overview";
  }
  function switchView(view, focusSearch) {
    const allowed = new Set(["overview","market","sniper","deals","cheap","analytics","events","data","sales","favorites","portfolio","support","appearance","help"]);
    state.activeView = allowed.has(view) ? view : "overview";
    const mainView = mainViewFor(state.activeView);
    document.querySelectorAll("[data-view-section]").forEach(section => {
      section.classList.toggle("view-hidden", section.getAttribute("data-view-section") !== state.activeView);
    });
    document.querySelectorAll("#mainNav [data-view]").forEach(button => {
      const active = (button.dataset.main || button.dataset.view) === mainView;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll(".workspace-subnav-group").forEach(group => {
      group.classList.toggle("is-active", group.dataset.subnavGroup === mainView);
    });
    document.querySelectorAll(".workspace-subnav [data-view]").forEach(button => {
      button.setAttribute("aria-selected", String(button.dataset.view === state.activeView));
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

  function normaliseSaleRarity(value) {
    return String(value || "").trim().toLocaleLowerCase("ru").replace(/\s+/g, " ");
  }

  function salesReferenceDescription(lot) {
    if (lot && lot.reference_scope === "catalog_rarity") return "точному каталогу и редкости";
    if (lot && lot.reference_scope === "title_rarity") return "названию и редкости";
    return "названию без подтверждённой редкости";
  }

  function salesReferenceLabel(lot) {
    if (!lot || lot.basis !== "sales") return "МЕДИАНА ОБЪЯВЛЕНИЙ";
    if (lot.reference_scope === "catalog_rarity") return "МЕДИАНА ПРОДАЖ · КАТАЛОГ И РЕДКОСТЬ";
    if (lot.reference_scope === "title_rarity") return "МЕДИАНА ПРОДАЖ · НАЗВАНИЕ И РЕДКОСТЬ";
    return "МЕДИАНА ПРОДАЖ · ТОЛЬКО НАЗВАНИЕ";
  }

  function salesProfileForGift(lot) {
    const sales = state.data && state.data.sales && typeof state.data.sales === "object" ? state.data.sales : {};
    const title = normaliseSaleTitle(lot && lot.title);
    const rarity = normaliseSaleRarity(lot && lot.rarity);
    const catalog = lot && lot.gift_catalog && typeof lot.gift_catalog === "object" ? lot.gift_catalog : {};
    const instance = lot && lot.gift_instance && typeof lot.gift_instance === "object" ? lot.gift_instance : {};
    const catalogId = String(catalog.catalog_id || catalog.gift_catalog_id ||
      instance.catalog_id || instance.gift_catalog_id || "").trim();
    const valid = item => item && isNum(item.median) && item.median > 0;
    const catalogProfiles = Array.isArray(sales.by_catalog_rarity) ? sales.by_catalog_rarity : [];
    const rarityProfiles = Array.isArray(sales.by_title_rarity) ? sales.by_title_rarity : [];
    const titleProfiles = Array.isArray(sales.by_title) ? sales.by_title : [];

    // Prefer a profile proven by the exact previously observed Huevo lot ID.
    const exactCatalog = catalogId && rarity ? catalogProfiles.find(item =>
      String(item.catalog_id || "") === catalogId &&
      normaliseSaleRarity(item.rarity) === rarity && valid(item)) : null;
    // Prefer the most specific profile that has enough completed trades to be useful.
    if (exactCatalog && Number(exactCatalog.count) >= 5) return exactCatalog;

    // If the catalog relation is unavailable or sparse, a title + rarity profile can
    // safely pool several exact lot matches of that same rarity.
    const exactRarity = title && rarity ? rarityProfiles.find(item =>
      normaliseSaleTitle(item.title) === title &&
      normaliseSaleRarity(item.rarity) === rarity && valid(item)) : null;
    if (exactRarity && Number(exactRarity.count) >= 5) return exactRarity;

    // A sparse exact profile is still preferable to mixing a different rarity.
    if (exactCatalog) return exactCatalog;
    if (exactRarity) return exactRarity;

    // Retain legacy / title-only sales only when no narrower match exists;
    // the caller marks this broad benchmark as low confidence.
    return titleProfiles.find(item => normaliseSaleTitle(item.title) === title && valid(item)) || null;
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
      let reference, basis, sampleSize, p25, p75, dispersion, excluded, referenceScope;
      if (sales && sales.count >= 5) {
        reference = sales.median; basis = "sales"; sampleSize = sales.count;
        referenceScope = sales.match_scope || "title";
        p25 = isNum(sales.p25) ? sales.p25 : null;
        p75 = isNum(sales.p75) ? sales.p75 : null;
        dispersion = p25 != null && p75 != null && reference > 0 ? (p75-p25)/reference : null;
        excluded = 0;
      } else {
        // Asking prices are not transaction prices. Use them only when the distribution
        // has a sufficiently large, non-dispersed core; otherwise suppress the deal signal.
        if (!offers || offers.ambiguous || offers.dispersion > 1.0) continue;
        reference = offers.reference; basis = "active"; sampleSize = offers.sample_size;
        referenceScope = "title_rarity";
        p25 = offers.p25; p75 = offers.p75; dispersion = offers.dispersion; excluded = offers.excluded;
      }
      if (!isNum(reference) || reference <= 0) continue;
      for (const lot of group) {
        if (lot.price >= reference * 0.85) continue;
        const discount = Math.round((1 - lot.price / reference) * 1000) / 10;
        signals.push({
          ...lot, reference_price: reference, discount_pct: discount, sample_size: sampleSize,
          basis, reference_scope: referenceScope,
          reference_p25: p25, reference_p75: p75, dispersion, excluded_outliers: excluded,
          confidence: basis === "sales"
            ? (referenceScope === "title" ? "low" : (sampleSize >= 20 ? "high" : "medium"))
            : "low",
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

  function dealScore(lot) {
    if (!lot || !isNum(lot.discount_pct) || lot.discount_pct <= 0 || lot.suspicious) return 0;
    const discount = Math.max(0, Math.min(80, Number(lot.discount_pct))) / 80;
    const sample = Math.max(0, Number(lot.sample_size) || 0);
    const evidence = Math.min(1, sample / 20);
    const exactSales = lot.basis === "sales" && ["catalog_rarity", "title_rarity"].includes(lot.reference_scope);
    const confidence = lot.confidence === "high" ? 1 : lot.confidence === "medium" ? 0.82 : 0.58;
    const raw = discount * 60 + evidence * 25 + (exactSales ? 15 : 6);
    return Math.round(Math.max(0, Math.min(100, raw * confidence)));
  }

  function dealScoreExplanation(lot) {
    const confidence = lot.confidence === "high" ? "высокая" :
      lot.confidence === "medium" ? "средняя" : "низкая";
    const source = lot.basis === "sales"
      ? (lot.reference_scope === "catalog_rarity" ? "продажи точного каталога и редкости" :
        lot.reference_scope === "title_rarity" ? "продажи точного названия и редкости" :
        "продажи только по названию")
      : "активные объявления с тем же названием и редкостью";
    const sample = isNum(lot.sample_size) ? fmt(lot.sample_size) : "нет";
    return "Скидка: " + fmt(lot.discount_pct) + "%. Ориентир: " + source +
      ". Выборка: " + sample + " записей. Уверенность источника: " + confidence +
      ". Балл помогает расставить приоритет проверки и не предсказывает прибыль.";
  }

  function renderDealCard(lot,label,dayPick){
    const id=String(lot.lot_id),saved=isNum(lot.reference_price)?Math.max(0,lot.reference_price-lot.price):null;
    const histValues=(Array.isArray(lot._history)?lot._history:[]).filter(p=>isNum(p.price)).map(p=>p.price);
    const histLow=histValues.length>=2?Math.min(...histValues):null;
    const badgeText=isNum(lot.discount_pct)?"−"+fmt(lot.discount_pct)+"%"+(lot.suspicious?" · ПРОВЕРИТЬ":""):(label||"Рыночный лот");
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
    row.classList.add("deal-row","deal-card-rich");
    if(dayPick){
      row.classList.add("day-pick-card");
      row.children[1].classList.add("day-pick-content");
      row.children[2].classList.add("day-pick-actions");
    }
    const metrics=h("div",{class:"deal-metrics"});
    metrics.append(
      h("span",{class:"deal-metric ask"},[h("small",{text:"ЦЕНА ЛОТА"}),h("b",{text:price(lot.price)})]),
      h("span",{class:"deal-metric"},[h("small",{text:salesReferenceLabel(lot)}),h("b",{text:isNum(lot.reference_price)?price(lot.reference_price):"Нет ориентира"})]),
      h("span",{class:"deal-metric saving"},[h("small",{text:"РАЗНИЦА"}),h("b",{text:isNum(saved)?price(saved)+" ниже":"Не рассчитана"})]),
      h("span",{class:"deal-metric"},[h("small",{text:"ОЦЕНКА СИГНАЛА"}),h("b",{text:dealScore(lot)+"/100"})]),
      h("span",{class:"deal-metric"},[h("small",{text:lot.basis==="sales"?"СОВЕРШЁННЫЕ ПРОДАЖИ · "+salesReferenceDescription(lot).toUpperCase():"АКТИВНЫЕ ОБЪЯВЛЕНИЯ · ТО ЖЕ НАЗВАНИЕ И РЕДКОСТЬ"}),h("b",{text:isNum(lot.sample_size)&&lot.sample_size>0?fmt(lot.sample_size)+" записей":"Мало данных"})])
    );
    if(histLow!==null)metrics.append(h("span",{class:"deal-metric history-low"},[h("small",{text:"МИНИМУМ В ИСТОРИИ"}),h("b",{text:price(histLow)})]));
    metrics.append(h("p",{class:"deal-score-note",text:dealScoreExplanation(lot)}));
    const mini=sparkline(lot._history);
    if(mini)metrics.append(h("div",{class:"deal-sparkline"},[mini,h("small",{text:"История цены"})]));
    row.children[1].append(metrics);
    if(lot.suspicious)row.children[1].append(h("p",{class:"deal-warning",text:"Экстремальный дисконт более 80%. Не выбран верхним сигналом: проверь совпадение подарка, редкость, статус и возможную ошибку цены."}));
    if(lot.basis==="sales" && lot.reference_scope==="title")row.children[1].append(h("p",{class:"deal-warning",text:"Исторические сделки пока не связаны с точным каталогом и редкостью. Это широкий ориентир по названию, уверенность снижена."}));
    const target=h("input",{class:"input target-input deal-target-input",type:"number",min:"1",step:"1",inputmode:"numeric",placeholder:"Желаемая цена","aria-label":"Цена-цель для "+(lot.title||id)});
    target.value=state.targets[id]?String(state.targets[id]):"";
    const save=h("button",{class:"btn target-save",type:"button",text:state.targets[id]?"Обновить цену-цель":"Задать цену-цель"});
    save.addEventListener("click",()=>{saveTarget(lot.lot_id,target.value);});
    const quick=h("button",{class:"btn secondary target-quick",type:"button",text:"Цель −10%"});
    quick.addEventListener("click",()=>{target.value=String(Math.max(1,Math.floor(lot.price*.9)));saveTarget(lot.lot_id,target.value);});
    const status=h("small",{class:"target-status",text:state.targets[id]?(lot.active!==false&&isNum(lot.price)&&lot.price<=state.targets[id]?"✓ Цель достигнута":"Цель "+price(state.targets[id])):"Цель не задана"});
    row.children[1].append(h("div",{class:"deal-target-row"},[target,save,quick,status]));
    return row;
  }

  function renderDeals(){
    const signals=buildDealSignals(),best=signals.find(lot=>!lot.suspicious)||null;
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
      const extremeCount=signals.filter(lot=>lot.suspicious).length;
      const bestReference = best.basis==="sales"
        ? "медианы подтверждённых продаж ("+salesReferenceDescription(best)+")"
        : "устойчивой медианы объявлений той же редкости";
      $("belowBestMeta").textContent="На "+fmt(best.discount_pct)+"% ниже "+bestReference+" · разница "+price(Math.max(0,best.reference_price-best.price))+" · "+fmt(best.sample_size)+(best.basis==="sales"?" продаж":" лотов")+" · "+(best.confidence==="high"?"высокая выборка":best.confidence==="medium"?"средняя выборка":"низкая уверенность")+" · #"+best.lot_id+(extremeCount?" · "+fmt(extremeCount)+" экстремальных скидок >80% оставлено ниже как подозрительные":"");
      $("belowBestOpen").href=safeUrl(best.lot_url,best.lot_id);
      const bestImage=$("belowBestImage"),bestArt=$("belowBestArt");
      const imageUrl=typeof best.image_url==="string"&&best.image_url.startsWith("https://")&&(best.image_url.includes("huevo.su/")||best.image_url.includes("huevo.departament.site/"))?best.image_url:"";
      bestArt.classList.toggle("has-image",!!imageUrl);
      bestImage.hidden=!imageUrl;
      bestImage.onerror=()=>{bestArt.classList.remove("has-image");bestImage.hidden=true;};
      if(imageUrl&&bestImage.src!==imageUrl)bestImage.src=imageUrl;
      if(!imageUrl)bestImage.removeAttribute("src");
      $("belowBestTarget").value=state.targets[String(best.lot_id)]?String(state.targets[String(best.lot_id)]):"";
      $("overviewPickHint").textContent="Лучший лот по размеру дисконта, а не по минимальной цене: −"+fmt(best.discount_pct)+"% от "+(best.basis==="sales"?"медианы подтверждённых продаж ("+salesReferenceDescription(best)+")":"устойчивого диапазона объявлений той же редкости")+". "+(best.confidence==="low"?"Ориентир предварительный.":"");
      const pick=clear($("overviewPickLot"));
      if(best.image_url&&/^https:\/\//i.test(best.image_url)){const img=h("img",{class:"pick-img",src:best.image_url,alt:"",loading:"lazy",referrerpolicy:"no-referrer"});img.addEventListener("error",()=>img.replaceWith(h("span",{class:"pick-img",text:"🎁"})));pick.append(img);}
      pick.append(h("div",{},[h("strong",{text:best.title||("Лот #"+best.lot_id)}),h("span",{class:"pick-price",text:price(best.price)}),h("small",{text:"−"+fmt(best.discount_pct)+"% к "+(best.basis==="sales"?"продажам":"объявлениям")+" · разница "+price(best.reference_price-best.price)})]));
      deals.slice(0,30).forEach((lot,index)=>list.append(renderDealCard(lot,"#"+(index+1),false)));
    }else{
      state._belowBestId=null;
      $("belowBestTitle").textContent="Пока нет уверенного кандидата";$("belowBestPrice").textContent="—";
      $("belowBestMeta").textContent=signals.length?"Есть экстремальные скидки, но все кандидаты превышают 80% и отмечены как подозрительные. Поэтому верхний сигнал не назначен.":"Нужны минимум 5 сопоставимых записей о продажах или 5 объявлений с достаточно узким диапазоном цен. Слишком разрозненные цены не считаем ориентиром.";
      $("belowBestOpen").href="https://huevo.su/market/gifts";$("belowBestTarget").value="";
      $("overviewPickHint").textContent=signals.length?"Есть только экстремальные скидки >80%; они не выбираются надёжным топ-сигналом.":"Когда появится сопоставимая группа, здесь будет показан лучший надёжный дисконт.";
      const pick=clear($("overviewPickLot"));pick.append(h("span",{class:"muted",text:"Пока нет группы аналогов для честного сравнения."}));
      list.append(h("li",{class:"empty",text:signals.length?"Кандидаты со скидкой более 80% показаны в каталоге, но не назначены лучшими из-за риска аномальной цены.":"Нет лотов на 15% дешевле медианы трёх или более похожих активных предложений."}));
    }
    updateViewCounts();
  }

  function renderDayPicks(){
    const box=clear($("dayPicks")),signals=buildDealSignals(),reliable=signals.filter(lot=>!lot.suspicious),chosen=[],seen=new Set();
    const add=(lot,tag,description)=>{if(!lot||seen.has(String(lot.lot_id))||chosen.length>=3)return;seen.add(String(lot.lot_id));chosen.push({lot,tag,description});};
    const signalById=new Map(signals.map(lot=>[String(lot.lot_id),lot]));
    const fallback=state.lots.filter(l=>l&&l.active!==false&&isNum(l.price)&&l.price>0)
      .slice().sort((a,b)=>a.price-b.price||String(a.title).localeCompare(String(b.title),"ru"))
      .map(lot=>signalById.get(String(lot.lot_id))||lot);
    if(reliable.length){
      add(reliable[0],"ЛУЧШИЙ НАДЁЖНЫЙ ДИСКОНТ","Сильная скидка к аналогам без признака экстремального выброса");
      add(fallback[0],"САМАЯ НИЗКАЯ ЦЕНА","Самое дешёвое активное объявление — не обязательно выгоднее рынка");
      add(reliable.slice().sort((a,b)=>b.sample_size-a.sample_size||b.discount_pct-a.discount_pct)[0],"БОЛЬШЕ АНАЛОГОВ","Наиболее широкая выборка для сравнения цены");
    }else{
      add(fallback[0],"САМАЯ НИЗКАЯ ЦЕНА","Бюджетный лот; надёжный дисконт к рынку не подтверждён");
    }
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
    $("watchHelp").textContent = (targets
      ? targets+" целевых цен сохранено"+(reached?" · цель достигнута у "+reached+" лотов":"")+". "
      : "Добавь лот в избранное и задай цену-цель. ") +
      "При достижении цены AMNYAM воспроизведёт мелодию, если звук включён и вкладка открыта.";
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

  function renderOwnerPresence(){
    const view=$("ownerPresenceView"), text=$("ownerPresenceText"), toggle=$("ownerPresenceToggle"), toggleText=$("ownerPresenceToggleText");
    if(!view||!text||!toggle||!toggleText)return;
    view.dataset.available=String(presenceState.available);
    text.textContent=presenceState.loading?"Проверяем статус…":presenceState.error?"Статус временно недоступен":presenceState.available?"Сейчас на месте":"Сейчас не на месте";
    toggle.hidden=!presenceState.canManage;
    toggle.disabled=presenceState.saving||!presenceState.configured;
    toggle.setAttribute("aria-checked",String(presenceState.available));
    toggleText.textContent=presenceState.saving?"Сохраняем…":presenceState.available?"На месте":"Не на месте";
    if(presenceState.error)view.title=presenceState.error;else view.removeAttribute("title");
  }

  async function refreshOwnerPresence(){
    try{
      const data=await fetchJson("./api/contact/status?_="+Date.now(),{cache:"no-store"},8000);
      presenceState={
        available:Boolean(data.available),
        canManage:Boolean(data.can_manage),
        configured:Boolean(data.configured),
        loading:false,saving:false,error:""
      };
    }catch(error){
      presenceState={...presenceState,loading:false,error:"Не удалось загрузить статус: "+error.message};
    }
    renderOwnerPresence();
  }

  async function setOwnerPresence(available){
    if(!presenceState.canManage||presenceState.saving)return;
    presenceState.saving=true;
    presenceState.error="";
    renderOwnerPresence();
    try{
      const result=await accountRequest("./api/contact/status",{
        method:"PUT",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({available:Boolean(available)})
      });
      presenceState={
        available:Boolean(result.available),canManage:Boolean(result.can_manage),
        configured:Boolean(result.configured),loading:false,saving:false,error:""
      };
    }catch(error){
      presenceState.saving=false;
      presenceState.error=error.message||"Не удалось изменить статус.";
    }
    renderOwnerPresence();
  }

  function checkTargetAlerts(){
    let changed=false;
    Object.entries(state.targets).forEach(([id,target])=>{
      const lot=state.lots.find(l=>String(l.lot_id)===id);if(!lot||lot.active===false||!isNum(lot.price))return;
      const already=state.alertedTargets.includes(id);
      if(lot.price>target){if(already){state.alertedTargets=state.alertedTargets.filter(v=>v!==id);changed=true;}}
      else if(!already){state.alertedTargets.push(id);changed=true;playAlertSound(false);}
    });
    if(changed)writeAlertedTargets();
  }

  function saveTarget(lotId,raw,errorNode){
    const id=String(lotId),textValue=String(raw == null ? "" : raw).trim(),value=textValue===""?null:Number(textValue);
    if(value!==null&&(!Number.isSafeInteger(value)||value<=0||value>TARGET_PRICE_MAX)){
      const message="Введи целую целевую цену от 1 до "+fmt(TARGET_PRICE_MAX)+".";
      if(errorNode){errorNode.textContent=message;errorNode.classList.add("visible");}
      else{const notice=$("notice");notice.textContent=message;notice.classList.remove("hide");notice.classList.add("bad");}
      return false;
    }
    if(errorNode){errorNode.textContent="";errorNode.classList.remove("visible");}
    if(value===null){delete state.targets[id];state.alertedTargets=state.alertedTargets.filter(v=>v!==id);}
    else{state.targets[id]=value;if(!state.favorites.includes(id))state.favorites=[...state.favorites,id].slice(-5000);}
    writeTargets();writeAlertedTargets();writeFavorites();checkTargetAlerts();renderFavorites();renderRows();renderDeals();renderDayPicks();updateViewCounts();publishMarketData();return true;
  }

  function toggleFavorite(lotId){
    const id=String(lotId);
    if(state.favorites.includes(id)){state.favorites=state.favorites.filter(v=>v!==id);delete state.targets[id];state.alertedTargets=state.alertedTargets.filter(v=>v!==id);writeTargets();writeAlertedTargets();}
    else state.favorites=[...state.favorites,id].slice(-5000);
    writeFavorites();renderFavorites();updateViewCounts();renderRows();renderDeals();renderDayPicks();publishMarketData();
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

  async function requestSupportApi(path, options, timeoutMs = 12000) {
    const response = await fetchWithTimeout(path, { cache: "no-store", ...(options || {}) }, timeoutMs);
    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error(data.detail || data.error || ("HTTP " + response.status));
    return data;
  }

  function supportMessage(message, kind) {
    const box = $("supportMsg");
    $("supportMsgText").textContent = message || "";
    box.hidden = !message;
    box.className = "support-message" + (kind ? " " + kind : "");
    const retry = $("supportRetryStatus");
    const hideRetry = !(kind === "pending" && Boolean(supportStatusIntentId));
    retry.hidden = hideRetry;
    retry.classList.toggle("hide", hideRetry);
    retry.disabled = supportStatusLookupRunning;
    retry.setAttribute("aria-busy", String(supportStatusLookupRunning));
  }

  async function refreshSupportPaymentStatus() {
    const intentId = supportStatusIntentId;
    if (!intentId || supportStatusLookupRunning) return;
    supportStatusLookupRunning = true;
    const retry = $("supportRetryStatus");
    retry.disabled = true;
    retry.setAttribute("aria-busy", "true");
    try {
      const result = await requestSupportApi(
        "./api/support/status/" + encodeURIComponent(intentId),
        {},
        8000
      );
      const status = String(result.status || "pending");
      if (status === "succeeded") {
        persistPendingSupportIntent(null);
        supportMessage(result.test
          ? "Тестовый платёж подтверждён. Спасибо!"
          : "Поддержка подтверждена сервером. Спасибо!", "good");
        try {
          const stats = await requestSupportApi("./api/support/stats", {}, 8000);
          $("supporters").textContent = fmt(Number(stats.supporters) || 0);
          $("supportTotal").textContent = fmt(Number(stats.total) || 0);
        } catch (_) {}
      } else if (status === "pending") {
        supportMessage("Платёж уже создан и пока ожидает подтверждения. Не создавай повторный платёж. ID: " + intentId, "pending");
      } else {
        persistPendingSupportIntent(null);
        supportMessage("Платёж завершился со статусом: " + status + ".", "error");
      }
    } catch (_) {
      supportMessage("Платёж уже создан, но сервер пока не вернул статус. Не создавай повторный платёж. Попробуй проверить ещё раз. ID: " + intentId, "pending");
    } finally {
      supportStatusLookupRunning = false;
      retry.disabled = false;
      retry.removeAttribute("aria-busy");
      retry.hidden = !supportStatusIntentId;
      retry.classList.toggle("hide", !supportStatusIntentId);
    }
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
    if (supportStatusIntentId) {
      supportMessage("Найден ранее созданный платёж без окончательного статуса. Не создавай новый; проверь текущий. ID: " + supportStatusIntentId, "pending");
    }
    supportInitRunning = false;
  }

  async function makeSupportPayment(amount) {
    const inHuevo = new URLSearchParams(location.search).has("hu_user_id");
    if (supportPaymentRunning) return;
    if (supportStatusIntentId) {
      supportMessage("У тебя уже есть созданный платёж без окончательного статуса. Не создавай второй — сначала проверь текущий. ID: " + supportStatusIntentId, "pending");
      return;
    }
    if (!supportConfig.enabled) return supportMessage("Приём поддержки не настроен. Проверь настройки huEVO Apps.", "error");
    if (!inHuevo || !supportSdkReady || !window.huevo) return supportMessage("Для оплаты открой AMNYAM MODE внутри huEVO как приложение.", "error");
    supportPaymentRunning = true;
    const buttons = Array.from(document.querySelectorAll("#supportAmounts [data-amount]"));
    buttons.forEach((button) => { button.disabled = true; button.setAttribute("aria-busy", "true"); });
    try {
      const numericAmount = Number(amount);
      const configuredAmounts = (supportConfig.amounts || []).map(Number);
      if (!Number.isSafeInteger(numericAmount) || numericAmount < 5000 || numericAmount > 100000 ||
          (configuredAmounts.length && !configuredAmounts.includes(numericAmount))) {
        throw new Error("Недопустимая сумма поддержки.");
      }
      supportMessage("Создаём запрос на поддержку…");
      const intent = await requestSupportApi("./api/support/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ amount: numericAmount, launch_query: location.search })
      });
      if (!intent.intent_id) throw new Error("Сервер не вернул ID платёжного запроса.");
      persistPendingSupportIntent(String(intent.intent_id));
      if (intent.reused) {
        supportMessage("На сервере уже есть незавершённый платёж. Повторный платёж не создан; проверь статус существующего. ID: " + intent.intent_id, "pending");
        return;
      }
      supportMessage("Платёж создан. Подтверди его в официальном окне huEVO" + (intent.test ? " (тестовый режим)." : "."));
      let confirmationTimedOut = false;
      try {
        let confirmTimer;
        await Promise.race([
          Promise.resolve().then(() => window.huevo.confirmPayment(supportStatusIntentId)),
          new Promise((_, reject) => {
            confirmTimer = window.setTimeout(() => reject(new Error("Окно huEVO не ответило за 15 секунд.")), 15000);
          })
        ]).finally(() => window.clearTimeout(confirmTimer));
      } catch (_) {
        confirmationTimedOut = true;
        supportMessage("Ответ окна huEVO не получен. Платёж уже создан; проверяю статус на сервере…", "muted");
      }

      const deadline = Date.now() + 80000;
      let status = "pending";
      let statusLookupFailed = false;
      while (status === "pending" && Date.now() < deadline) {
        const waitMs = Math.min(2000, deadline - Date.now());
        if (waitMs > 0) await new Promise((resolve) => window.setTimeout(resolve, waitMs));
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        try {
          const result = await requestSupportApi(
            "./api/support/status/" + encodeURIComponent(supportStatusIntentId),
            {},
            Math.min(8000, remainingMs)
          );
          status = String(result.status || "pending");
        } catch (_) {
          statusLookupFailed = true;
          break;
        }
      }

      if (status === "succeeded") {
        persistPendingSupportIntent(null);
        supportMessage(intent.test ? "Тестовый платёж подтверждён. Спасибо!" : "Поддержка подтверждена сервером. Спасибо!", "good");
        try {
          const stats = await requestSupportApi("./api/support/stats", {}, 8000);
          $("supporters").textContent = fmt(Number(stats.supporters) || 0);
          $("supportTotal").textContent = fmt(Number(stats.total) || 0);
        } catch (_) {}
      } else if (status === "pending") {
        const reason = statusLookupFailed
          ? "Сервер временно не ответил на проверку статуса."
          : confirmationTimedOut
            ? "Подтверждение в окне huEVO не получено за отведённое время."
            : "Платёж всё ещё ожидает подтверждения.";
        supportMessage(reason + " Платёж уже создан; не создавай повторный. Проверь статус кнопкой ниже. ID: " + supportStatusIntentId, "pending");
      } else {
        persistPendingSupportIntent(null);
        supportMessage("Платёж завершился со статусом: " + status + ".", "error");
      }
    } catch (error) {
      if (supportStatusIntentId) {
        supportMessage("Платёж уже создан, но его статус пока не подтверждён. Не создавай повторный платёж. ID: " + supportStatusIntentId, "pending");
      } else {
        supportMessage(error && error.message ? error.message : "Не удалось создать платёж.", "error");
      }
    } finally {
      supportPaymentRunning = false;
      buttons.forEach((button) => { button.disabled = false; button.removeAttribute("aria-busy"); });
      if (supportStatusIntentId) {
        $("supportRetryStatus").hidden = false;
        $("supportRetryStatus").classList.remove("hide");
      }
    }
  }

  // ---------- command center / market pulse ----------
  function renderCommandCenter() {
    const st = stats();
    const deals = buildDealSignals();
    const best = deals.find((lot) => !lot.suspicious) || null;
    const setText = (id, value) => { const el = $(id); if (el) el.textContent = value; };
    setText("pulseLots", fmt(st.total));
    setText("pulseMedian", price(st.median));
    setText("pulseDeals", fmt(deals.length));
    setText("pulseWatchlist", fmt(state.favorites.length));
    setText("pulseWatchlistNote", fmt(Object.keys(state.targets).length) + " целевых цен · " + fmt(state.favorites.length) + " в избранном");
    setText("pulseBestTitle", best ? (best.title || ("Лот #" + best.lot_id)) : "Пока нет подтверждённой сделки");
    setText("pulseBestNote", best ? ("Лот #" + best.lot_id + " · максимальный дисконт, не минимальная цена · " + price(best.price) + " вместо медианы " + price(best.reference_price) + " · " + fmt(best.sample_size) + " аналогов") : "Нужно минимум 3 сопоставимых лота и цена минимум на 15% ниже медианы.");
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


  // ---------- huEVO identity + cross-device profile sync ----------
  window.addEventListener("amnyam:sniper-rules", () => {
    if (accountState.user && !accountState.hydrating) queueProfileSave();
  });
  function profilePayload() {
    return {
      favorites: state.favorites.slice(0, 5000),
      targets: { ...state.targets },
      alertedTargets: state.alertedTargets.slice(0, 5000),
      savedFilters: state.savedFilters.slice(0, 25),
      portfolio: state.portfolio.slice(0, 100),
      sniperRuleProfiles: window.AMNYAM_RULE_PROFILES && window.AMNYAM_RULE_PROFILES.get ? window.AMNYAM_RULE_PROFILES.get() : [],
      preferences: {
        alertSound: Boolean(alertSoundEnabled),
        soundVolume,
        soundPattern,
        sniperNewSound: Boolean(sniperSoundPrefs.new),
        sniperDealSound: Boolean(sniperSoundPrefs.deal),
        appearance: { ...appearance },
        overviewWidgets: { ...overviewWidgets },
        seasonTheme: document.body.dataset.season || "default"
      }
    };
  }

  function applyAccountProfile(profile) {
    accountState.hydrating = true;
    const p = profile && typeof profile === "object" ? profile : {};
    state.favorites = Array.isArray(p.favorites) ? [...new Set(p.favorites.map(String).filter(id => /^\d{1,20}$/.test(id)))].slice(0, 5000) : [];
    state.targets = p.targets && typeof p.targets === "object" && !Array.isArray(p.targets)
      ? Object.fromEntries(Object.entries(p.targets).filter(([id, value]) => /^\d{1,20}$/.test(id) && Number.isSafeInteger(value) && value > 0 && value <= TARGET_PRICE_MAX).slice(0, 5000)) : {};
    state.alertedTargets = Array.isArray(p.alertedTargets) ? [...new Set(p.alertedTargets.map(String).filter(id => /^\d{1,20}$/.test(id)))].slice(0, 5000) : [];
    state.savedFilters = Array.isArray(p.savedFilters) ? p.savedFilters.filter(item => item && typeof item.name === "string" && item.name.trim() && item.filters && typeof item.filters === "object").slice(0, 25) : [];
    state.portfolio = Array.isArray(p.portfolio) ? p.portfolio.filter(item => item && typeof item.title === "string" && item.title.trim() && Number.isSafeInteger(item.quantity) && item.quantity > 0 && Number.isSafeInteger(item.purchase_price) && item.purchase_price > 0).slice(0, 100) : [];
    window.AMNYAM_PENDING_RULE_PROFILES = Array.isArray(p.sniperRuleProfiles) ? p.sniperRuleProfiles : [];
    const prefs = p.preferences && typeof p.preferences === "object" ? p.preferences : {};
    alertSoundEnabled = prefs.alertSound === true;
    soundVolume = Number.isInteger(prefs.soundVolume) && prefs.soundVolume >= 0 && prefs.soundVolume <= 100 ? prefs.soundVolume : 100;
    soundPattern = ["signature", "soft", "double"].includes(prefs.soundPattern) ? prefs.soundPattern : "signature";
    sniperSoundPrefs = { new: prefs.sniperNewSound === true, deal: prefs.sniperDealSound === true };
    updateAdvancedSoundControls();
    const a = prefs.appearance && typeof prefs.appearance === "object" ? prefs.appearance : {};
    appearance = {
      background: ["cosmic","liquid","nebula","minimal"].includes(a.background) ? a.background : "cosmic",
      mascot: a.mascot === "none" ? "none" : "omnom",
      motion: ["normal","subtle","off"].includes(a.motion) ? a.motion : "normal",
      glass: a.glass !== false
    };
    applyAppearance();
    overviewWidgets = sanitizeOverviewWidgets(prefs.overviewWidgets);
    applyOverviewWidgets(false);
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
    state.portfolio = readPortfolio();
    try {
      alertSoundEnabled = localStorage.getItem(ALERT_SOUND_KEY) === "on";
      sniperSoundPrefs = {
        new: localStorage.getItem("amnyam.sniperSound.new.v1") === "on",
        deal: localStorage.getItem("amnyam.sniperSound.deal.v1") === "on"
      };
    } catch (_) { alertSoundEnabled = false; sniperSoundPrefs = { new: false, deal: false }; }
    window.dispatchEvent(new CustomEvent("amnyam:sniper-sounds", { detail: { ...sniperSoundPrefs, master: alertSoundEnabled } }));
    appearance = readAppearance();
    applyAppearance();
    overviewWidgets = readOverviewWidgets();
    applyOverviewWidgets(false);
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
    if (sync && accountState.user) sync.textContent = message || "Профиль huEVO синхронизирован";
  }

  function updateAccountUI() {
    const signedIn = Boolean(accountState.user);
    $("accountGuest").classList.toggle("hide", signedIn);
    $("accountSigned").classList.toggle("hide", !signedIn);
    $("accountButton").textContent = signedIn ? "◎ " + accountState.user.display_name : "Профиль huEVO";
    if (signedIn) {
      $("accountDisplayName").textContent = accountState.user.display_name || "Пользователь huEVO";
      $("accountUsername").textContent = accountState.user.username ? "@" + accountState.user.username : "hu_user_id: " + accountState.user.hu_user_id;
      const avatar = $("accountAvatar");
      if (avatar) {
        if (accountState.user.avatar_url) {
          avatar.src = accountState.user.avatar_url;
          avatar.classList.remove("hide");
        } else {
          avatar.removeAttribute("src");
          avatar.classList.add("hide");
        }
      }
      setAccountStatus("Профиль huEVO подключён", "ok");
    }
  }

  async function accountRequest(path, options) {
    const response = await fetchWithTimeout(path, {
      cache: "no-store",
      credentials: "same-origin",
      ...(options || {}),
      headers: { "Accept": "application/json", ...((options && options.headers) || {}) }
    }, 12000);
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
    if (!accountState.user || !accountState.dirty) return;
    if (accountState.savePromise) {
      await accountState.savePromise;
      return; // The in-flight request's finally block schedules the next save with backoff.
    }
    const revision = accountState.revision;
    const payload = profilePayload();
    accountState.dirty = false;
    accountState.saving = true;
    const operation = (async () => {
      try {
        const result = await accountRequest("./api/me/profile", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: payload })
        });
        accountState.updatedAt = result.updated_at || accountState.updatedAt;
        accountState.saveRetryCount = 0;
        if (revision === accountState.revision) setAccountStatus("Все изменения сохранены", "ok");
        else accountState.dirty = true;
      } catch (error) {
        accountState.dirty = true;
        accountState.saveRetryCount = Math.min((accountState.saveRetryCount || 0) + 1, 5);
        setAccountStatus("Не удалось синхронизировать: " + error.message, "error");
      }
    })();
    accountState.savePromise = operation;
    try {
      await operation;
    } finally {
      if (accountState.savePromise === operation) accountState.savePromise = null;
      accountState.saving = false;
      if (accountState.dirty && accountState.user) {
        if (accountState.saveTimer) window.clearTimeout(accountState.saveTimer);
        const retryDelays = [2500, 5000, 10000, 20000, 30000];
        accountState.saveTimer = window.setTimeout(saveAccountProfile, retryDelays[(accountState.saveRetryCount || 1) - 1]);
      }
    }
  }

  function acceptAccountSession(data) {
    accountState.authRevision += 1;
    accountState.user = data.user;
    accountState.profilesReady = true;
    accountState.updatedAt = data.updated_at || null;
    accountState.dirty = false;
    if (accountState.saveTimer) window.clearTimeout(accountState.saveTimer);
    applyAccountProfile(data.profile);
    updateAccountUI();

    refreshOwnerPresence();
    if ($("accountDialog").open) $("accountDialog").close();
    setAccountStatus("Профиль huEVO загружен", "ok");
  }

  function hasHuevoLaunch() {
    const params = new URLSearchParams(location.search);
    return params.has("hu_user_id") && params.has("hu_app_id") && params.has("hu_hash") && params.has("hu_ts");
  }

  async function authenticateFromHuevo() {
    if (!hasHuevoLaunch()) return false;
    if (accountState.authPromise) return accountState.authPromise;
    accountState.authPromise = (async () => {
      setAccountStatus("Проверяем подписанный профиль huEVO…", "muted");
      const data = await accountRequest("./api/auth/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ launch_query: location.search, profile: profilePayload() })
      });
      if (!data.authenticated || !data.user) throw new Error("huEVO не подтвердил пользователя.");
      acceptAccountSession(data);
      startAccountProfilePolling();
      return true;
    })();
    try { return await accountState.authPromise; }
    finally { accountState.authPromise = null; }
  }

  async function checkAccountSession() {
    const authRevision = accountState.authRevision;
    try {
      // Prefer the freshly signed launch identity on every huEVO app open.
      // This also handles switching Huevo accounts in the social network.
      if (hasHuevoLaunch()) {
        await authenticateFromHuevo();
        return;
      }
      const data = await accountRequest(ACCOUNT_PROFILE_URL);
      if (authRevision !== accountState.authRevision) return;
      accountState.profilesReady = data.profiles_ready !== false;
      if (data.authenticated && data.user) {
        if (!accountState.user || accountState.user.id !== data.user.id || accountState.updatedAt !== data.updated_at) {
          accountState.user = data.user;
          accountState.updatedAt = data.updated_at || null;
          if (!accountState.dirty) applyAccountProfile(data.profile);
        }
        updateAccountUI();
        startAccountProfilePolling();

        refreshOwnerPresence();
      } else {
        accountState.user = null;
        accountState.updatedAt = null;
        accountState.dirty = false;
        restoreGuestProfile();
        updateAccountUI();

        refreshOwnerPresence();
        setAccountStatus(accountState.profilesReady
          ? "Открой AMNYAM MODE внутри huEVO — профиль подключится автоматически."
          : "Серверное хранилище профилей ещё не подготовлено.", "muted");
      }
    } catch (error) {
      setAccountStatus(error.message || "Не удалось подтвердить профиль huEVO.", "error");
      updateAccountUI();
    }
  }

  function startAccountProfilePolling() {
    if (accountState.pollTimer) return;
    accountState.pollTimer = window.setInterval(async () => {
      if (!accountState.user || accountState.dirty || accountState.profilePollRunning) return;
      const authRevision = accountState.authRevision;
      accountState.profilePollRunning = true;
      try {
        const data = await accountRequest(ACCOUNT_PROFILE_URL);
        if (authRevision !== accountState.authRevision || accountState.dirty) return;
        if (!data.authenticated || !data.user) {
          accountState.authRevision += 1;
          accountState.user = null;
          accountState.updatedAt = null;
          restoreGuestProfile();
          updateAccountUI();
          setAccountStatus("Сеанс huEVO истёк. Перезагрузи приложение внутри huEVO.", "error");
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
      } catch (_) {
        // A temporary profile API failure must not interrupt the shared market.
      } finally {
        accountState.profilePollRunning = false;
      }
    }, 30000);
  }

  function initAccountUI() {
    updateAccountUI();
    $("accountButton").addEventListener("click", () => {
      $("accountStatus").textContent = "";
      $("accountDialog").showModal();
      if (!accountState.user && hasHuevoLaunch()) authenticateFromHuevo().catch(error => setAccountStatus(error.message, "error"));
    });
    $("accountClose").addEventListener("click", () => $("accountDialog").close());
    $("accountDialog").addEventListener("click", event => { if (event.target === $("accountDialog")) $("accountDialog").close(); });
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
      publishMarketData();
      return;
    }
    show("content");
    checkTargetAlerts();
    renderCommandCenter();
    renderDeals();renderDayPicks();renderCheapest();renderFavorites();
    renderCards(); renderCharts(); renderChanges(); renderTop(); renderSales(); renderSourceHealth();
    renderPortfolio(); renderMarketEvents(); renderGiftCatalogIndex(); refreshGlobalSearchSuggestions(); fillFacets();
    renderSavedFilters();setSortMenuOptions();applyFilters();
    switchView(state.activeView);
    publishMarketData();
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
  const OVERVIEW_WIDGETS_KEY = "amnyam.overviewWidgets.v1";
  function sanitizeOverviewWidgets(value) {
    const raw = value && typeof value === "object" ? value : {};
    return { hero: raw.hero !== false, dayPicks: raw.dayPicks !== false, charts: raw.charts !== false };
  }
  function readOverviewWidgets() {
    try { return sanitizeOverviewWidgets(JSON.parse(localStorage.getItem(OVERVIEW_WIDGETS_KEY) || "{}")); }
    catch (_) { return { hero: true, dayPicks: true, charts: true }; }
  }
  let overviewWidgets = readOverviewWidgets();
  function applyOverviewWidgets(persist) {
    [["hero","overviewShowHero"],["dayPicks","overviewShowDayPicks"],["charts","overviewShowCharts"]].forEach(([key,id]) => {
      const section = document.querySelector('[data-overview-widget="' + key + '"]');
      const control = $(id);
      if (section) section.classList.toggle("hide", overviewWidgets[key] === false);
      if (control) control.checked = overviewWidgets[key] !== false;
    });
    if (persist) {
      if (accountState.user) queueProfileSave();
      else { try { localStorage.setItem(OVERVIEW_WIDGETS_KEY, JSON.stringify(overviewWidgets)); } catch (_) {} }
    }
  }
  function initOverviewWidgets() {
    applyOverviewWidgets(false);
    [["overviewShowHero","hero"],["overviewShowDayPicks","dayPicks"],["overviewShowCharts","charts"]].forEach(([id,key]) => {
      const control = $(id);
      if (control) control.addEventListener("change", () => {
        overviewWidgets[key] = control.checked;
        applyOverviewWidgets(true);
      });
    });
  }
  const CUSTOM_MEDIA_KEY = "amnyam.customWallpaper.v1";
  function applyCustomAppearanceMedia() {
    const node = $("customWallpaper"), hint = $("appearanceMediaHint");
    if (!node) return;
    let saved = "";
    try { saved = localStorage.getItem(CUSTOM_MEDIA_KEY) || ""; } catch (_) {}
    if (saved && /^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(saved) && saved.length <= 720000) {
      node.src = saved;
      node.classList.add("is-active");
      if (hint) hint.textContent = "Собственный фон включён. Файл хранится только в этом браузере.";
    } else {
      node.removeAttribute("src");
      node.classList.remove("is-active");
      if (hint) hint.textContent = "Изображение до 512 КБ хранится только в этом браузере и не отправляется на сервер.";
    }
  }
  function initCustomAppearanceMedia() {
    applyCustomAppearanceMedia();
    const input = $("appearanceMediaFile");
    if (input) input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (!file) return;
      if (!/^image\/(?:png|jpeg|webp|gif)$/i.test(file.type) || file.size > 512 * 1024) {
        $("appearanceMediaHint").textContent = "Поддерживаются PNG, JPG, WebP и GIF до 512 КБ.";
        input.value = "";
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const value = String(reader.result || "");
        if (!/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(value) || value.length > 720000) {
          $("appearanceMediaHint").textContent = "Файл слишком большой для локального хранения.";
          return;
        }
        try { localStorage.setItem(CUSTOM_MEDIA_KEY, value); } catch (_) {
          $("appearanceMediaHint").textContent = "Браузер не смог сохранить файл. Освободи место в локальном хранилище.";
          return;
        }
        applyCustomAppearanceMedia();
      };
      reader.onerror = () => { $("appearanceMediaHint").textContent = "Не удалось прочитать файл."; };
      reader.readAsDataURL(file);
    });
    const clearButton = $("appearanceMediaClear");
    if (clearButton) clearButton.addEventListener("click", () => {
      try { localStorage.removeItem(CUSTOM_MEDIA_KEY); } catch (_) {}
      if (input) input.value = "";
      applyCustomAppearanceMedia();
    });
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
  refreshOwnerPresence();
  window.setInterval(refreshOwnerPresence, 30000);
  initAppearance();
  initOverviewWidgets();
  initCustomAppearanceMedia();
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
      const views = { h: "overview", m: "market", s: "sniper", d: "deals", c: "cheap", a: "analytics", f: "favorites", i: "help" };
      if (views[key]) { event.preventDefault(); switchView(views[key], true); }
      window.__amnyamGoPending = 0;
    }
  });
  const mainNav = $("mainNav");
  mainNav.addEventListener("keydown", event => {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    const tabs = Array.from(mainNav.querySelectorAll('[role="tab"]:not(:disabled)'));
    const current = tabs.indexOf(event.target.closest('[role="tab"]'));
    if (current < 0 || !tabs.length) return;
    let next = current;
    if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    event.preventDefault();
    switchView(tabs[next].dataset.view, false);
    tabs[next].focus();
  });
  document.querySelectorAll("#mainNav [data-view]").forEach(button=>button.addEventListener("click",()=>switchView(button.dataset.view,true)));
  document.querySelectorAll(".workspace-subnav [data-view]").forEach(button=>button.addEventListener("click",()=>switchView(button.dataset.view,true)));
  document.querySelectorAll("[data-go-view]").forEach(button=>button.addEventListener("click",()=>switchView(button.dataset.goView,true)));
  $("globalSearch").addEventListener("input",refreshGlobalSearchSuggestions);
  $("globalSearch").addEventListener("keydown",event=>{if(event.key!=="Enter")return;event.preventDefault();$("search").value=$("globalSearch").value.trim();state.page=0;switchView("market",true);applyFilters();});
  document.querySelectorAll("[data-search-token]").forEach(button=>button.addEventListener("click",()=>{
    const token=button.dataset.searchToken||"",input=$("search");input.value=(input.value.trim()+" "+token).trim();$("globalSearch").value=input.value;state.page=0;switchView("market",true);applyFilters();
  }));
  $("dealSort").addEventListener("change",renderDeals);
  $("exportCsv").addEventListener("click",exportMarketCsv);
  $("portfolioForm").addEventListener("submit",event=>{event.preventDefault();addPortfolioItem();});
  $("marketWorkspaceTabs").addEventListener("click",event=>{
    const button=event.target.closest("[data-market-tab]");
    if(!button)return;
    const catalog=button.dataset.marketTab==="catalog";
    $("catalog").classList.toggle("hide",catalog);
    $("giftCatalogPanel").classList.toggle("hide",!catalog);
    document.querySelectorAll("[data-market-tab]").forEach(tab=>tab.setAttribute("aria-selected",String(tab===button)));
    if(catalog)renderGiftCatalogIndex();
  });
  $("giftCatalogSearch").addEventListener("input",renderGiftCatalogIndex);
  $("giftCatalogSort").addEventListener("change",renderGiftCatalogIndex);
  $("exportGiftCatalogCsv").addEventListener("click",exportGiftCatalogCsv);
  $("exportPortfolioCsv").addEventListener("click",exportPortfolioCsv);
  $("exportEventsCsv").addEventListener("click",exportEventsCsv);
  $("historyApply").addEventListener("click",renderCharts);
  $("historyReset").addEventListener("click",()=>{
    $("historyFrom").value="";
    $("historyTo").value="";
    renderCharts();
  });
  $("saveBelowBestTarget").addEventListener("click",()=>{const id=state._belowBestId;if(id)saveTarget(id,$("belowBestTarget").value);});
  $("belowBestMinus10").addEventListener("click",()=>{const id=state._belowBestId,lot=state.lots.find(item=>String(item.lot_id)===String(id));if(lot&&isNum(lot.price)&&lot.price>0){$("belowBestTarget").value=String(Math.max(1,Math.floor(lot.price*.9)));saveTarget(id,$("belowBestTarget").value);}});
  $("supportAmounts").addEventListener("click",event=>{const b=event.target.closest("[data-amount]");if(b&&!b.disabled)makeSupportPayment(b.dataset.amount);});
  $("supportRetryStatus").addEventListener("click", refreshSupportPaymentStatus);
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
  $("detail").addEventListener("close",()=>{activeDetailLotId=null;if(lastTrigger&&document.contains(lastTrigger))lastTrigger.focus();});
  $("detail").addEventListener("click",e=>{if(e.target===$("detail"))$("detail").close();});
  $("savePreset").addEventListener("click",saveFilterPreset);$("applyPreset").addEventListener("click",applyFilterPreset);$("deletePreset").addEventListener("click",deleteFilterPreset);
  $("savedFilterSelect").addEventListener("change",()=>{
    const index=Number($("savedFilterSelect").value),item=state.savedFilters[index];$("applyPreset").disabled=!item;$("deletePreset").disabled=!item;if(item)$("presetName").value=item.name;
  });
  $("ownerPresenceToggle").addEventListener("click",()=>setOwnerPresence(!presenceState.available));
  $("compareSelected").addEventListener("click",openComparison);$("compareClose").addEventListener("click",()=>$("compareDialog").close());
  $("compareDialog").addEventListener("click",e=>{if(e.target===$("compareDialog"))$("compareDialog").close();});
  load();
  initSupport();
  pollLive();
  window.setInterval(pollLive, 3000);
  window.setInterval(pollFullSnapshot, 5 * 60 * 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      pollBackoffUntil = 0;
      pollFailureCount = 0;
      pollLive();
      pollFullSnapshot();
    }
  });
})();
