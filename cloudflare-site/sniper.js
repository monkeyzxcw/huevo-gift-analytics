"use strict";
(function () {
  const $ = (id) => document.getElementById(id);
  const fmt = (value) => Number.isFinite(Number(value)) ? Number(value).toLocaleString("ru-RU", { maximumFractionDigits: 1 }) : "—";
  const price = (value) => Number.isFinite(Number(value)) ? fmt(value) + " ◉" : "—";
  const safeLotUrl = (lot) => {
    const value = String(lot && lot.lot_url || "");
    return /^https:\/\/(?:huevo\.su|huevo\.departament\.site)\/market\/lot\/\d+\/?$/i.test(value)
      ? value : "https://huevo.su/market/lot/" + encodeURIComponent(String(lot && lot.lot_id || ""));
  };
  const asDate = (value) => {
    const date = new Date(value || "");
    return Number.isFinite(date.getTime()) ? date : null;
  };
  const relativeTime = (value) => {
    const date = asDate(value);
    if (!date) return "время не указано";
    const minutes = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
    if (minutes < 1) return "только что";
    if (minutes < 60) return minutes + " мин назад";
    if (minutes < 1440) return Math.round(minutes / 60) + " ч назад";
    return date.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  };
  const median = (values) => {
    const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const quantile = (sorted, q) => {
    if (!sorted.length) return null;
    const position = (sorted.length - 1) * q;
    const low = Math.floor(position), high = Math.ceil(position);
    return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
  };
  const normaliseTitle = (value) => String(value || "").trim().toLocaleLowerCase("ru").replace(/\s+/g, " ");
  function robustReference(values) {
    const sorted = values.filter((value) => Number.isFinite(value) && value > 0).slice().sort((a, b) => a - b);
    if (sorted.length < 5) return null;
    for (let index = 3; index < sorted.length - 2; index += 1) {
      if (sorted[index - 1] > 0 && sorted[index] / sorted[index - 1] >= 2.5) return null;
    }
    const q1 = quantile(sorted, 0.25), q3 = quantile(sorted, 0.75), iqr = q3 - q1;
    const core = iqr > 0 ? sorted.filter((value) => value >= q1 - 1.5 * iqr && value <= q3 + 1.5 * iqr) : sorted;
    if (core.length < 5) return null;
    const reference = median(core);
    const dispersion = reference > 0 ? (quantile(core, 0.75) - quantile(core, 0.25)) / reference : Infinity;
    if (dispersion > 1) return null;
    return { median: reference, p25: quantile(core, 0.25), p75: quantile(core, 0.75), count: core.length, basis: "asks" };
  }
  const state = {
    data: null, lots: [], deals: [], targets: {}, events: [], seen: new Set(), lastIds: null,
    lastPrices: new Map(), lastDeals: new Set(), profileKey: "guest", eventSound: { new: false, deal: false, master: false },
    filter: { type: "all", search: "", min: "", max: "", discount: "" }, profileLoaded: false, ruleProfiles: []
  };
  const EVENTS_KEY = "amnyam.sniper.events.v1";
  const SEEN_KEY = "amnyam.sniper.seen.v1";
  const MAX_EVENTS = 100;
  let soundContext = null;
  const lastSoundAt = { new: 0, deal: 0 };
  function storageRead(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "null");
      return value == null ? fallback : value;
    } catch (_) { return fallback; }
  }
  function storageWrite(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
  }
  function eventKey(event) {
    return [event.type, event.lot_id, event.event_at || "", event.price || "", event.reference_price || ""].join("|");
  }
  function addEvent(event, allowSound) {
    const key = eventKey(event);
    if (state.seen.has(key)) return false;
    state.seen.add(key);
    if (state.seen.size > 1200) state.seen = new Set(Array.from(state.seen).slice(-600));
    state.events.unshift({ ...event, key });
    state.events = state.events.slice(0, MAX_EVENTS);
    saveEvents();
    if (allowSound) playEventSound(event.type);
    return true;
  }
  function saveEvents() {
    storageWrite(EVENTS_KEY + "." + state.profileKey, state.events);
    storageWrite(SEEN_KEY + "." + state.profileKey, Array.from(state.seen).slice(-1200));
  }
  const RULES_KEY = "amnyam.sniper.rules.v1";
  function cleanRuleProfiles(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 20).filter(item => item && typeof item.name === "string" && item.name.trim()).map(item => ({
      id: String(item.id || "").slice(0, 80),
      name: String(item.name || "").trim().slice(0, 40),
      filter: {
        type: ["all", "new", "price", "deal", "target"].includes(item.filter && item.filter.type) ? item.filter.type : "all",
        search: String(item.filter && item.filter.search || "").slice(0, 120),
        min: String(item.filter && item.filter.min || "").slice(0, 24),
        max: String(item.filter && item.filter.max || "").slice(0, 24),
        discount: String(item.filter && item.filter.discount || "").slice(0, 4)
      }
    })).filter(item => item.id);
  }
  function saveRuleProfiles() {
    storageWrite(RULES_KEY + "." + state.profileKey, state.ruleProfiles);
    window.dispatchEvent(new CustomEvent("amnyam:sniper-rules"));
    renderRuleProfiles();
  }
  function renderRuleProfiles() {
    const select = $("sniperRuleProfiles");
    if (!select) return;
    const selected = select.value;
    while (select.firstChild) select.removeChild(select.firstChild);
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = state.ruleProfiles.length ? "Выбери сохранённый профиль" : "Нет сохранённых профилей";
    select.append(placeholder);
    state.ruleProfiles.forEach(profile => {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = profile.name;
      select.append(option);
    });
    if (state.ruleProfiles.some(profile => profile.id === selected)) select.value = selected;
    const hasSelection = Boolean(state.ruleProfiles.find(profile => profile.id === select.value));
    $("sniperRuleApply").disabled = !hasSelection;
    $("sniperRuleDelete").disabled = !hasSelection;
  }
  function currentRuleFilter() {
    return {
      type: $("sniperType").value,
      search: $("sniperSearch").value,
      min: $("sniperMinPrice").value,
      max: $("sniperMaxPrice").value,
      discount: $("sniperMinDiscount").value
    };
  }
  function applyRuleFilter(profile) {
    if (!profile) return;
    $("sniperType").value = profile.filter.type;
    $("sniperSearch").value = profile.filter.search;
    $("sniperMinPrice").value = profile.filter.min;
    $("sniperMaxPrice").value = profile.filter.max;
    $("sniperMinDiscount").value = profile.filter.discount;
    updateFilters();
    $("sniperRuleStatus").textContent = "Применён профиль «" + profile.name + "».";
  }
  function loadRuleProfiles() {
    const local = storageRead(RULES_KEY + "." + state.profileKey, []);
    state.ruleProfiles = cleanRuleProfiles(local);
    renderRuleProfiles();
  }
  window.AMNYAM_RULE_PROFILES = {
    get: () => cleanRuleProfiles(state.ruleProfiles),
    set: value => {
      state.ruleProfiles = cleanRuleProfiles(value);
      if (state.profileLoaded) {
        storageWrite(RULES_KEY + "." + state.profileKey, state.ruleProfiles);
        renderRuleProfiles();
      } else {
        window.AMNYAM_PENDING_RULE_PROFILES = state.ruleProfiles;
      }
    }
  };
  if (Array.isArray(window.AMNYAM_PENDING_RULE_PROFILES)) {
    state.ruleProfiles = cleanRuleProfiles(window.AMNYAM_PENDING_RULE_PROFILES);
    storageWrite(RULES_KEY + ".guest", state.ruleProfiles);
    delete window.AMNYAM_PENDING_RULE_PROFILES;
  }

  function loadEvents(profileKey) {
    state.profileKey = profileKey || "guest";
    loadRuleProfiles();
    if (Array.isArray(window.AMNYAM_PENDING_RULE_PROFILES)) {
      state.ruleProfiles = cleanRuleProfiles(window.AMNYAM_PENDING_RULE_PROFILES);
      saveRuleProfiles();
      delete window.AMNYAM_PENDING_RULE_PROFILES;
    }
    const rawEvents = storageRead(EVENTS_KEY + "." + state.profileKey, []);
    const rawSeen = storageRead(SEEN_KEY + "." + state.profileKey, []);
    state.events = Array.isArray(rawEvents) ? rawEvents.filter((event) => event && typeof event.type === "string").slice(0, MAX_EVENTS) : [];
    state.seen = new Set(Array.isArray(rawSeen) ? rawSeen.filter((key) => typeof key === "string").slice(-1200) : []);
    state.events.forEach((event) => state.seen.add(event.key || eventKey(event)));
  }
  function unlockEventAudio() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    try {
      soundContext = soundContext || new AudioContextClass();
      if (soundContext.state === "suspended") soundContext.resume().catch(() => {});
    } catch (_) {}
  }
  function playEventSound(type) {
    if (!state.eventSound.master) return;
    if (type === "new" && !state.eventSound.new) return;
    if (type === "deal" && !state.eventSound.deal) return;
    if (type !== "new" && type !== "deal") return;
    const now = Date.now();
    if (now - lastSoundAt[type] < 8000) return;
    lastSoundAt[type] = now;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    try {
      soundContext = soundContext || new AudioContextClass();
      const context = soundContext;
      const notes = type === "deal" ? [660, 880, 1046] : [740, 988];
      const play = () => {
        const start = context.currentTime + 0.02;
        notes.forEach((frequency, index) => {
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          oscillator.type = "sine";
          oscillator.frequency.setValueAtTime(frequency, start + index * 0.12);
          gain.gain.setValueAtTime(0.0001, start + index * 0.12);
          gain.gain.exponentialRampToValueAtTime(0.11, start + index * 0.12 + 0.018);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + index * 0.12 + 0.16);
          oscillator.connect(gain);
          gain.connect(context.destination);
          oscillator.start(start + index * 0.12);
          oscillator.stop(start + index * 0.12 + 0.17);
        });
      };
      if (context.state === "suspended") context.resume().then(play).catch(() => {});
      else play();
    } catch (_) {}
  }
  function extractSalesProfile(title) {
    const rows = state.data && state.data.sales && Array.isArray(state.data.sales.by_title) ? state.data.sales.by_title : [];
    return rows.find((row) => normaliseTitle(row.title) === normaliseTitle(title) && Number(row.count) >= 3 && Number(row.median) > 0) || null;
  }
  function buildDeals(lots) {
    const groups = new Map();
    lots.filter((lot) => lot && lot.active !== false && Number.isFinite(lot.price) && lot.price > 0).forEach((lot) => {
      const key = normaliseTitle(lot.title) + "|" + String(lot.rarity || "").trim().toLocaleLowerCase("ru");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(lot);
    });
    const signals = [];
    groups.forEach((group) => {
      if (group.length < 3) return;
      const sale = extractSalesProfile(group[0].title);
      let ref = null, basis = "asks", sample = 0;
      if (sale && Number(sale.count) >= 5) {
        ref = Number(sale.median); basis = "sales"; sample = Number(sale.count);
      } else {
        const offers = robustReference(group.map((lot) => Number(lot.price)));
        if (!offers) return;
        ref = offers.median; sample = offers.count;
      }
      group.forEach((lot) => {
        if (!Number.isFinite(ref) || ref <= 0 || lot.price >= ref * 0.85) return;
        const discount = (1 - lot.price / ref) * 100;
        if (discount <= 0 || discount > 80) return;
        signals.push({ ...lot, reference_price: ref, discount_pct: discount, basis, sample_size: sample });
      });
    });
    return signals;
  }
  function ingest(detail) {
    if (!detail || !Array.isArray(detail.lots)) return;
    const nextLots = detail.lots;
    const nextIds = new Set(nextLots.map((lot) => String(lot.lot_id)));
    const nextPrices = new Map(nextLots.filter((lot) => Number.isFinite(lot.price)).map((lot) => [String(lot.lot_id), lot.price]));
    const nextProfileKey = detail.profileKey || "guest";
    const changedProfile = state.profileLoaded && nextProfileKey !== state.profileKey;
    if (!state.profileLoaded || changedProfile) {
      loadEvents(nextProfileKey);
      state.profileLoaded = true;
    }
    state.data = detail.data || {};
    state.lots = nextLots;
    state.targets = detail.targets && typeof detail.targets === "object" ? detail.targets : {};
    state.deals = Array.isArray(detail.deals) ? detail.deals : buildDeals(nextLots);
    const currentDeals = state.deals;
    const dealKeys = new Set(currentDeals.map((lot) => String(lot.lot_id) + "|" + lot.basis + "|" + Math.round(lot.reference_price)));
    if (state.lastIds === null || changedProfile) {
      const since = asDate(state.data.changes && state.data.changes.since);
      const recentLimit = Date.now() - 24 * 60 * 60 * 1000;
      const newRows = state.data.changes && Array.isArray(state.data.changes.new) ? state.data.changes.new : [];
      newRows.forEach((lot) => {
        const eventDate = asDate(lot.first_seen || lot.last_seen || lot.observed_at) || since;
        if (!eventDate || eventDate.getTime() < recentLimit) return;
        addEvent({ type: "new", lot_id: String(lot.lot_id), title: lot.title || "Новый лот", price: lot.price, event_at: eventDate.toISOString(), lot_url: safeLotUrl(lot) }, false);
      });
      state.lastIds = nextIds;
      state.lastPrices = nextPrices;
      state.lastDeals = dealKeys;
      render();
      return;
    }
    nextLots.forEach((lot) => {
      const id = String(lot.lot_id);
      if (!state.lastIds.has(id)) {
        const eventDate = asDate(lot.first_seen || lot.last_seen) || new Date();
        addEvent({ type: "new", lot_id: id, title: lot.title || "Новый лот", price: lot.price, event_at: eventDate.toISOString(), lot_url: safeLotUrl(lot) }, true);
      } else {
        const oldPrice = state.lastPrices.get(id);
        if (Number.isFinite(oldPrice) && Number.isFinite(lot.price) && lot.price < oldPrice) {
          const latestHistory = Array.isArray(lot.history) && lot.history.length ? lot.history[lot.history.length - 1] : null;
          addEvent({ type: "price", lot_id: id, title: lot.title || "Изменение цены", price: lot.price, previous_price: oldPrice,
            event_at: (latestHistory && latestHistory.observed_at) || lot.last_seen || new Date().toISOString(), lot_url: safeLotUrl(lot) }, false);
        }
      }
    });
    Object.entries(state.targets).forEach(([id, target]) => {
      const lot = nextLots.find((item) => String(item.lot_id) === id);
      const oldPrice = state.lastPrices.get(id);
      if (lot && Number.isFinite(oldPrice) && Number.isFinite(lot.price) && oldPrice > Number(target) && lot.price <= Number(target)) {
        addEvent({ type: "target", lot_id: id, title: lot.title || "Целевая цена", price: lot.price, target_price: Number(target),
          event_at: new Date().toISOString(), lot_url: safeLotUrl(lot) }, false);
      }
    });
    currentDeals.forEach((lot) => {
      const id = String(lot.lot_id);
      const key = id + "|" + lot.basis + "|" + Math.round(lot.reference_price);
      if (!state.lastDeals.has(key)) {
        addEvent({ type: "deal", lot_id: id, title: lot.title || "Ниже рынка", price: lot.price,
          reference_price: lot.reference_price, discount_pct: Math.round(lot.discount_pct * 10) / 10, basis: lot.basis,
          event_at: lot.last_seen || lot.first_seen || new Date().toISOString(), lot_url: safeLotUrl(lot) }, true);
      }
    });
    state.lastIds = nextIds;
    state.lastPrices = nextPrices;
    state.lastDeals = dealKeys;
    render();
  }
  function typeLabel(type) {
    return ({ new: "НОВЫЙ ЛОТ", price: "ЦЕНА СНИЗИЛАСЬ", deal: "НИЖЕ РЫНКА", target: "ЦЕЛЬ ДОСТИГНУТА" })[type] || "СОБЫТИЕ";
  }
  function renderFeed() {
    const list = $("sniperFeed");
    if (!list) return;
    while (list.firstChild) list.removeChild(list.firstChild);
    const filtered = state.events.filter((event) => {
      if (state.filter.type !== "all" && event.type !== state.filter.type) return false;
      const query = state.filter.search.trim().toLocaleLowerCase("ru");
      if (query && !(String(event.title || "") + " " + String(event.lot_id || "")).toLocaleLowerCase("ru").includes(query)) return false;
      if (state.filter.min !== "" && Number(event.price) < Number(state.filter.min)) return false;
      if (state.filter.max !== "" && Number(event.price) > Number(state.filter.max)) return false;
      if (state.filter.discount !== "" && Number(event.discount_pct || 0) < Number(state.filter.discount)) return false;
      return true;
    });
    $("sniperFeedNote").textContent = filtered.length + " из " + state.events.length + " событий · локальная история";
    if (!filtered.length) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = state.events.length ? "Нет событий под выбранные фильтры." : "Пока нет новых событий. Лента заполнится при изменении наблюдаемых данных.";
      list.append(empty);
      return;
    }
    filtered.slice(0, 60).forEach((event) => {
      const item = document.createElement("li");
      item.className = "sniper-event sniper-event-" + event.type;
      const info = document.createElement("div");
      const tag = document.createElement("span");
      tag.className = "sniper-event-tag";
      tag.textContent = typeLabel(event.type);
      const title = document.createElement("b");
      title.textContent = event.title || ("Лот #" + event.lot_id);
      const meta = document.createElement("small");
      meta.textContent = "#" + event.lot_id + " · " + relativeTime(event.event_at);
      info.append(tag, title, meta);
      const right = document.createElement("div");
      right.className = "sniper-event-value";
      const amount = document.createElement("b");
      amount.textContent = price(event.price);
      right.append(amount);
      if (Number.isFinite(Number(event.discount_pct))) {
        const discount = document.createElement("small");
        discount.textContent = "−" + fmt(event.discount_pct) + "% · " + (event.basis === "sales" ? "по продажам" : "по объявлениям");
        right.append(discount);
      } else if (Number.isFinite(Number(event.previous_price))) {
        const previous = document.createElement("small");
        previous.textContent = "Было " + price(event.previous_price);
        right.append(previous);
      }
      const link = document.createElement("a");
      link.className = "btn secondary";
      link.href = safeLotUrl(event);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Открыть ↗";
      item.append(info, right, link);
      list.append(item);
    });
  }
  function uniqueTitles() {
    const names = new Map();
    state.lots.forEach((lot) => {
      const title = String(lot.title || "").trim();
      if (!title) return;
      const key = normaliseTitle(title);
      if (!names.has(key)) names.set(key, title);
    });
    return Array.from(names.values()).sort((a, b) => a.localeCompare(b, "ru"));
  }
  function fillGiftSelects() {
    const titles = uniqueTitles();
    ["sniperGiftSelect", "sniperRarityGift"].forEach((id) => {
      const select = $(id);
      const previous = select.value;
      while (select.firstChild) select.removeChild(select.firstChild);
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = titles.length ? "Выбери подарок" : "Нет данных";
      select.append(placeholder);
      titles.forEach((title) => {
        const option = document.createElement("option");
        option.value = title;
        option.textContent = title;
        select.append(option);
      });
      if (titles.includes(previous)) select.value = previous;
      else if (titles.length) select.value = titles[0];
    });
  }
  function calcPurchase() {
    const title = $("sniperGiftSelect").value;
    const buy = Number($("sniperBuyPrice").value);
    const box = $("sniperCalcResult");
    while (box.firstChild) box.removeChild(box.firstChild);
    if (!title || !Number.isSafeInteger(buy) || buy <= 0) {
      const message = document.createElement("div");
      message.className = "empty";
      message.textContent = "Укажи подарок и целую цену покупки больше нуля.";
      box.append(message);
      return;
    }
    const sale = extractSalesProfile(title);
    let profile = null;
    if (sale && Number(sale.count) >= 3 && Number(sale.median) > 0) {
      profile = { p25: Number(sale.p25) || Number(sale.median), median: Number(sale.median), p75: Number(sale.p75) || Number(sale.median), count: Number(sale.count), basis: "Подтверждённые продажи" };
    } else {
      const group = state.lots.filter((lot) => normaliseTitle(lot.title) === normaliseTitle(title) && lot.active !== false);
      const offers = robustReference(group.map((lot) => Number(lot.price)));
      if (offers) profile = { p25: offers.p25, median: offers.median, p75: offers.p75, count: offers.count, basis: "Активные объявления — не сделки" };
    }
    if (!profile) {
      const message = document.createElement("div");
      message.className = "empty";
      message.textContent = "Недостаточно сопоставимых данных. Нужны минимум 3 подтверждённые продажи или 5 устойчивых объявлений.";
      box.append(message);
      return;
    }
    const grid = document.createElement("div");
    grid.className = "sniper-scenario-grid";
    [["Осторожный", profile.p25], ["Медианный", profile.median], ["Оптимистичный", profile.p75]].forEach(([label, estimate]) => {
      const delta = estimate - buy;
      const card = document.createElement("div");
      card.className = "sniper-scenario";
      const caption = document.createElement("small");
      caption.textContent = label;
      const amount = document.createElement("b");
      amount.textContent = price(estimate);
      const difference = document.createElement("span");
      difference.textContent = (delta >= 0 ? "+" : "−") + price(Math.abs(delta)) + " к покупке";
      card.append(caption, amount, difference);
      grid.append(card);
    });
    const note = document.createElement("p");
    note.className = "sniper-calc-note";
    note.textContent = profile.basis + " · выборка " + fmt(profile.count) + ". Без комиссий, времени продажи и гарантий будущей цены.";
    box.append(grid, note);
  }
  function attributeEntries(lot) {
    const instance = lot.gift_instance && typeof lot.gift_instance === "object" ? lot.gift_instance : {};
    const details = lot.gift_details && typeof lot.gift_details === "object" ? lot.gift_details : {};
    const catalog = lot.gift_catalog && typeof lot.gift_catalog === "object" ? lot.gift_catalog : {};
    const raw = instance.attributes || instance.characteristics ||
      details.attributes || details.characteristics || details.properties ||
      catalog.attributes || catalog.characteristics || catalog.properties;
    if (Array.isArray(raw)) {
      return raw.map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const key = entry.key || entry.type || entry.attribute || entry.label || entry.name;
        const value = entry.value ?? entry.display_value ?? entry.display_name ?? entry.title ?? entry.text;
        return key && value != null ? [String(key).trim(), String(value).trim()] : null;
      }).filter((pair) => pair && pair[0] && pair[1]);
    }
    if (raw && typeof raw === "object") {
      return Object.entries(raw).filter(([key, value]) => key && value != null && String(value).trim())
        .map(([key, value]) => [key, String(value).trim()]);
    }
    return [];
  }
  function renderRarity() {
    const title = $("sniperRarityGift").value;
    const box = $("sniperRarityResult");
    while (box.firstChild) box.removeChild(box.firstChild);
    if (!title) return;
    const rows = state.lots.filter((lot) => normaliseTitle(lot.title) === normaliseTitle(title));
    const buckets = new Map();
    rows.forEach((lot) => {
      attributeEntries(lot).forEach(([key, value]) => {
        const bucketKey = key.toLocaleLowerCase("ru");
        if (!buckets.has(bucketKey)) buckets.set(bucketKey, { label: key, values: new Map(), seenLots: new Set() });
        const bucket = buckets.get(bucketKey);
        if (bucket.seenLots.has(String(lot.lot_id))) return;
        bucket.seenLots.add(String(lot.lot_id));
        bucket.values.set(value, (bucket.values.get(value) || 0) + 1);
      });
    });
    const known = Array.from(buckets.values()).filter((bucket) => bucket.seenLots.size >= 2 && bucket.values.size >= 2);
    if (!known.length) {
      const message = document.createElement("div");
      message.className = "empty";
      message.textContent = "В собранных карточках пока нет нескольких сопоставимых значений характеристик. Ничего не додумываем.";
      box.append(message);
      return;
    }
    known.sort((a, b) => Math.min(...a.values.values()) / a.seenLots.size - Math.min(...b.values.values()) / b.seenLots.size);
    known.slice(0, 8).forEach((bucket) => {
      const sample = bucket.seenLots.size;
      const values = Array.from(bucket.values.entries()).sort((a, b) => a[1] - b[1]).slice(0, 4);
      const section = document.createElement("div");
      section.className = "sniper-rarity-row";
      const head = document.createElement("b");
      head.textContent = bucket.label + " · " + sample + " наблюдений";
      section.append(head);
      values.forEach(([value, count]) => {
        const line = document.createElement("div");
        line.className = "sniper-rarity-value";
        const text = document.createElement("span");
        text.textContent = value;
        const percentage = count / sample * 100;
        const share = document.createElement("b");
        share.textContent = fmt(percentage) + "%";
        const track = document.createElement("i");
        const fill = document.createElement("em");
        fill.style.width = Math.max(3, Math.min(100, percentage)) + "%";
        track.append(fill);
        line.append(text, share, track);
        section.append(line);
      });
      box.append(section);
    });
    const caveat = document.createElement("p");
    caveat.className = "sniper-calc-note";
    caveat.textContent = "Частота рассчитана только по " + fmt(rows.length) + " найденным лотам этого подарка с доступными характеристиками. Это не процент выпуска и не общий тираж.";
    box.append(caveat);
  }
  function render() {
    const now = Date.now();
    const last24h = now - 24 * 60 * 60 * 1000;
    const recentNew = state.events.filter((event) => event.type === "new" && (asDate(event.event_at)?.getTime() || 0) >= last24h).length;
    $("sniperNewCount").textContent = fmt(recentNew);
    $("sniperPriceCount").textContent = fmt(state.events.filter((event) => event.type === "price").length);
    $("sniperDealCount").textContent = fmt(state.deals.length);
    const reached = Object.entries(state.targets).filter(([id, target]) => {
      const lot = state.lots.find((item) => String(item.lot_id) === id);
      return lot && lot.active !== false && Number.isFinite(lot.price) && lot.price <= Number(target);
    }).length;
    $("sniperTargetCount").textContent = fmt(reached);
    $("sniperUpdated").textContent = state.data && state.data.live && state.data.live.fresh
      ? "Live · " + relativeTime(state.data.live.last_poll_at)
      : state.data && state.data.generated_at ? "Снимок · " + relativeTime(state.data.generated_at) : "Ожидаем данные…";
    const nav = $("navSniperCount");
    if (nav) nav.textContent = fmt(state.events.filter((event) => event.type === "new").length);
    renderFeed();
    fillGiftSelects();
    calcPurchase();
    renderRarity();
    const settings = window.AMNYAM_SOUND_SETTINGS && window.AMNYAM_SOUND_SETTINGS.get
      ? window.AMNYAM_SOUND_SETTINGS.get() : { new: false, deal: false, master: false };
    state.eventSound = settings;
    $("sniperNewSound").checked = settings.new === true;
    $("sniperDealSound").checked = settings.deal === true;
  }
  function updateFilters() {
    state.filter.type = $("sniperType").value;
    state.filter.search = $("sniperSearch").value;
    state.filter.min = $("sniperMinPrice").value;
    state.filter.max = $("sniperMaxPrice").value;
    state.filter.discount = $("sniperMinDiscount").value;
    renderFeed();
  }
  function init() {
    ["sniperType", "sniperSearch", "sniperMinPrice", "sniperMaxPrice", "sniperMinDiscount"].forEach((id) => {
      $(id).addEventListener(id === "sniperType" ? "change" : "input", updateFilters);
    });
    $("sniperReset").addEventListener("click", () => {
      $("sniperType").value = "all";
      $("sniperSearch").value = "";
      $("sniperMinPrice").value = "";
      $("sniperMaxPrice").value = "";
      $("sniperMinDiscount").value = "";
      updateFilters();
    });
    $("sniperNewSound").addEventListener("change", () => {
      if (window.AMNYAM_SOUND_SETTINGS) window.AMNYAM_SOUND_SETTINGS.set("new", $("sniperNewSound").checked);
    });
    $("sniperDealSound").addEventListener("change", () => {
      if (window.AMNYAM_SOUND_SETTINGS) window.AMNYAM_SOUND_SETTINGS.set("deal", $("sniperDealSound").checked);
    });
    $("sniperGiftSelect").addEventListener("change", calcPurchase);
    $("sniperBuyPrice").addEventListener("input", calcPurchase);
    $("sniperCalculate").addEventListener("click", calcPurchase);
    $("sniperRarityGift").addEventListener("change", renderRarity);
    $("sniperRuleProfiles").addEventListener("change", () => {
      const selected = state.ruleProfiles.find(item => item.id === $("sniperRuleProfiles").value);
      $("sniperRuleApply").disabled = !selected;
      $("sniperRuleDelete").disabled = !selected;
    });
    $("sniperRuleSave").addEventListener("click", () => {
      const name = $("sniperRuleName").value.trim();
      if (!name) { $("sniperRuleStatus").textContent = "Укажи название профиля."; return; }
      const existing = state.ruleProfiles.findIndex(item => item.name.toLocaleLowerCase("ru") === name.toLocaleLowerCase("ru"));
      const id = existing >= 0 ? state.ruleProfiles[existing].id : "rule-" + Date.now().toString(36);
      const profile = { id, name: name.slice(0, 40), filter: currentRuleFilter() };
      if (existing >= 0) state.ruleProfiles[existing] = profile;
      else if (state.ruleProfiles.length < 20) state.ruleProfiles.push(profile);
      else { $("sniperRuleStatus").textContent = "Достигнут лимит 20 профилей."; return; }
      saveRuleProfiles();
      $("sniperRuleProfiles").value = id;
      $("sniperRuleName").value = profile.name;
      $("sniperRuleStatus").textContent = "Профиль «" + profile.name + "» сохранён.";
    });
    $("sniperRuleApply").addEventListener("click", () => {
      const profile = state.ruleProfiles.find(item => item.id === $("sniperRuleProfiles").value);
      applyRuleFilter(profile);
    });
    $("sniperRuleDelete").addEventListener("click", () => {
      const id = $("sniperRuleProfiles").value;
      const profile = state.ruleProfiles.find(item => item.id === id);
      if (!profile) return;
      state.ruleProfiles = state.ruleProfiles.filter(item => item.id !== id);
      saveRuleProfiles();
      $("sniperRuleStatus").textContent = "Профиль «" + profile.name + "» удалён.";
    });
    window.addEventListener("amnyam:market", (event) => ingest(event.detail));
    window.addEventListener("amnyam:sniper-sounds", (event) => {
      state.eventSound = event.detail || { new: false, deal: false, master: false };
      $("sniperNewSound").checked = state.eventSound.new === true;
      $("sniperDealSound").checked = state.eventSound.deal === true;
      if (state.eventSound.master) unlockEventAudio();
    });
    document.addEventListener("pointerdown", unlockEventAudio, { once: true, passive: true });
    document.addEventListener("keydown", unlockEventAudio, { once: true });
    if (window.AMNYAM_MARKET) ingest(window.AMNYAM_MARKET);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();