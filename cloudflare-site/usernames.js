(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const MAX_ITEMS = 5000;
  const MAX_FILE_BYTES = 8 * 1024 * 1024;
  const MAX_PRICE = 1e15;
  const BASE_KEY = "amnyam.usernames.workspace.v1";
  const allowedViews = ["overview", "market", "sniper", "deals", "analytics", "favorites", "data", "settings"];
  let profileKey = "guest";
  let audioContext = null;

  const blankState = () => ({
    items: [], favorites: [], targets: {}, alertedTargets: {},
    events: [], snapshots: [], importedAt: null, soundEnabled: false
  });
  let state = blankState();
  let activeView = "overview";

  const safeDate = (value) => {
    const date = new Date(value || "");
    return Number.isFinite(date.getTime()) ? date : null;
  };
  const isoNow = () => new Date().toISOString();
  const number = (value) => {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value !== "string") return null;
    const normal = value.trim().replace(/\s/g, "").replace(",", ".");
    if (!normal) return null;
    const parsed = Number(normal);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const median = (values) => {
    const list = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (!list.length) return null;
    const middle = Math.floor(list.length / 2);
    return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
  };
  const fmt = (value) => Number.isFinite(value)
    ? value.toLocaleString("ru-RU", { maximumFractionDigits: 1 })
    : "—";
  const price = (value) => Number.isFinite(value) ? fmt(value) + " ◉" : "—";
  const safeText = (value, max = 160) => String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
  const localKey = () => BASE_KEY + "." + (/^(?:guest|\d{1,20})$/.test(profileKey) ? profileKey : "guest");

  function readState() {
    try {
      const raw = JSON.parse(localStorage.getItem(localKey()) || "null");
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return blankState();
      return {
        items: Array.isArray(raw.items) ? raw.items.slice(0, MAX_ITEMS).map(rawItem => {
          const item = normalizeRecord(rawItem);
          if (!item) return null;
          item.history = Array.isArray(rawItem.history)
            ? rawItem.history.filter(point => point && Number.isSafeInteger(point.price) && point.price > 0 && safeDate(point.at)).slice(-8)
            : [];
          return item;
        }).filter(Boolean) : [],
        favorites: Array.isArray(raw.favorites) ? [...new Set(raw.favorites.filter(x => typeof x === "string"))].slice(0, MAX_ITEMS) : [],
        targets: raw.targets && typeof raw.targets === "object" && !Array.isArray(raw.targets) ? raw.targets : {},
        alertedTargets: raw.alertedTargets && typeof raw.alertedTargets === "object" && !Array.isArray(raw.alertedTargets) ? raw.alertedTargets : {},
        events: Array.isArray(raw.events) ? raw.events.slice(0, 100) : [],
        snapshots: Array.isArray(raw.snapshots) ? raw.snapshots.slice(-20) : [],
        importedAt: typeof raw.importedAt === "string" ? raw.importedAt : null,
        soundEnabled: raw.soundEnabled === true
      };
    } catch (_) {
      return blankState();
    }
  }
  function persist() {
    try {
      localStorage.setItem(localKey(), JSON.stringify(state));
      const info = $("usernameStorageInfo");
      if (info) info.textContent = "Локально сохранено: " + state.items.length.toLocaleString("ru-RU") +
        " объявлений · профиль хранилища: " + (profileKey === "guest" ? "гостевой браузер" : "huEVO ID " + profileKey) + ".";
      return true;
    } catch (_) {
      announce("Не удалось сохранить базу. Экспортируй CSV и уменьши размер импорта.");
      return false;
    }
  }
  function announce(message, tone) {
    const el = $("usernameImportFeedback");
    if (el) {
      el.textContent = message;
      el.dataset.tone = tone || "info";
    }
    const status = $("usernameImportStatus");
    if (status) status.textContent = tone === "error" ? "ОШИБКА" : tone === "success" ? "ГОТОВО" : "LOCAL DATA";
  }

  function classify(name) {
    if (name.includes("_")) return "underscore";
    if (/^\d+$/.test(name)) return "digits";
    if (/^[a-z]+$/i.test(name)) return "letters";
    return "mixed";
  }
  function safeMarketUrl(value, lotId) {
    if (typeof value === "string") {
      try {
        const url = new URL(value);
        if (url.protocol === "https:" && url.hostname === "huevo.su" &&
            (url.pathname === "/market" || /^\/market\/lot\/[\w-]+\/?$/.test(url.pathname))) return url.href;
      } catch (_) {}
    }
    return lotId ? "https://huevo.su/market/lot/" + encodeURIComponent(String(lotId)) : "https://huevo.su/market";
  }
  function normalizeRecord(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    let username = safeText(raw.username || raw.handle || raw.user_name || raw.name || raw.slug, 64).replace(/^@+/, "");
    username = username.replace(/^https?:\/\/(?:t\.me|huevo\.su)\//i, "").replace(/\/+$/, "");
    if (!/^[a-z0-9_]{1,32}$/i.test(username)) return null;
    const rawPrice = raw.price ?? raw.asking_price ?? raw.amount ?? null;
    const amount = rawPrice == null || rawPrice === "" ? null : number(rawPrice);
    if (rawPrice != null && rawPrice !== "" && (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_PRICE)) return null;
    const lotId = safeText(raw.lot_id || raw.listing_id || raw.market_id || raw.id || username.toLowerCase(), 80);
    if (!lotId || !/^[A-Za-z0-9_-]{1,80}$/.test(lotId)) return null;
    const status = safeText(raw.status || "Не указан", 60);
    const key = lotId + "::" + username.toLowerCase();
    return {
      key, lot_id: lotId, username, normalized: username.toLowerCase(),
      length: username.length, kind: classify(username), price: amount,
      status, url: safeMarketUrl(raw.url || raw.lot_url, lotId),
      observed_at: safeDate(raw.observed_at || raw.updated_at || raw.first_seen)?.toISOString() || null,
      history: Array.isArray(raw.history) ? raw.history.filter(x => x && Number.isSafeInteger(x.price) && x.price > 0 && safeDate(x.at)).slice(-8) : []
    };
  }

  function parseCsv(text) {
    const sample = text.slice(0, 3000);
    const delimiter = (sample.match(/;/g) || []).length > (sample.match(/,/g) || []).length ? ";" :
      (sample.match(/\t/g) || []).length > (sample.match(/,/g) || []).length ? "\t" : ",";
    const rows = [];
    let row = [], field = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (quoted) {
        if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (char === '"') quoted = false;
        else field += char;
      } else if (char === '"') quoted = true;
      else if (char === delimiter) { row.push(field); field = ""; }
      else if (char === "\n" || char === "\r") {
        if (char === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.some(cell => String(cell).trim())) rows.push(row);
        row = [];
      } else field += char;
    }
    row.push(field);
    if (row.some(cell => String(cell).trim())) rows.push(row);
    if (quoted) throw new Error("CSV содержит незакрытую кавычку.");
    if (rows.length < 2) throw new Error("В CSV нет строк объявлений.");
    const headers = rows.shift().map(value => String(value).replace(/^\uFEFF/, "").trim().toLowerCase());
    const index = (...names) => headers.findIndex(value => names.includes(value));
    const userIndex = index("username", "handle", "user_name", "name", "юзернейм", "имя");
    if (userIndex < 0) throw new Error("В CSV не найден столбец username / handle.");
    const get = (row, ...names) => { const i = index(...names); return i >= 0 ? row[i] : ""; };
    return rows.slice(0, MAX_ITEMS + 1).map(row => ({
      username: row[userIndex],
      lot_id: get(row, "lot_id", "listing_id", "market_id", "id", "номер лота", "id лота"),
      price: get(row, "price", "asking_price", "amount", "цена", "цена объявления"),
      status: get(row, "status", "статус"),
      url: get(row, "url", "lot_url", "ссылка")
    }));
  }
  function parseImport(text, fileName) {
    if (text.length > MAX_FILE_BYTES) throw new Error("Файл слишком большой. Лимит — 8 МБ.");
    let raw;
    if (/\.csv$/i.test(fileName || "")) {
      raw = parseCsv(text);
    } else {
      let parsed;
      try { parsed = JSON.parse(text.replace(/^\uFEFF/, "")); }
      catch (_) { throw new Error("Не удалось прочитать JSON. Для CSV выбери файл с расширением .csv."); }
      raw = Array.isArray(parsed) ? parsed :
        parsed && Array.isArray(parsed.usernames) ? parsed.usernames :
        parsed && Array.isArray(parsed.items) ? parsed.items :
        parsed && Array.isArray(parsed.listings) ? parsed.listings : null;
      if (!raw) throw new Error("В JSON нужен массив usernames, items или listings.");
    }
    if (!Array.isArray(raw) || !raw.length) throw new Error("Файл не содержит объявлений.");
    if (raw.length > MAX_ITEMS) throw new Error("Слишком много строк. Максимум — " + MAX_ITEMS + ".");
    const map = new Map();
    let rejected = 0;
    raw.forEach(item => {
      const normalized = normalizeRecord(item);
      if (!normalized) { rejected++; return; }
      map.set(normalized.key, normalized);
    });
    if (!map.size) throw new Error("Нет валидных строк. Проверь username и положительные целые цены.");
    return { items: Array.from(map.values()), rejected, total: raw.length };
  }

  function aggregate(items) {
    const prices = items.map(item => item.price).filter(value => Number.isSafeInteger(value) && value > 0);
    return {
      at: isoNow(), count: items.length, priced: prices.length,
      min: prices.length ? Math.min(...prices) : null,
      median: median(prices),
      max: prices.length ? Math.max(...prices) : null
    };
  }
  function mergeImport(incoming) {
    const previous = new Map(state.items.map(item => [item.key, item]));
    const next = incoming.map(item => {
      const old = previous.get(item.key);
      const history = old && Array.isArray(old.history) ? old.history.slice(-7) : [];
      if (old && Number.isSafeInteger(old.price) && Number.isSafeInteger(item.price) && old.price !== item.price) {
        history.push({ at: isoNow(), price: old.price });
        history.push({ at: isoNow(), price: item.price });
      } else if (!history.length && Number.isSafeInteger(item.price)) {
        history.push({ at: isoNow(), price: item.price });
      }
      item.history = history.slice(-8);
      return item;
    });
    const nextMap = new Map(next.map(item => [item.key, item]));
    const events = [];
    next.forEach(item => {
      const old = previous.get(item.key);
      if (!old) events.push({ type: "new", username: item.username, lot_id: item.lot_id, price: item.price, at: isoNow() });
      else if (Number.isSafeInteger(old.price) && Number.isSafeInteger(item.price) && old.price !== item.price) {
        events.push({ type: item.price < old.price ? "down" : "up", username: item.username, lot_id: item.lot_id, from: old.price, price: item.price, at: isoNow() });
      }
    });
    state.events = events.concat(state.events).slice(0, 100);
    state.items = next.slice(0, MAX_ITEMS);
    state.importedAt = isoNow();
    state.snapshots.push(aggregate(state.items));
    state.snapshots = state.snapshots.slice(-20);
    state.favorites = state.favorites.filter(key => typeof key === "string").slice(0, MAX_ITEMS);
    checkTargets();
    persist();
  }

  function groupedComparables(items) {
    const groups = new Map();
    items.filter(item => Number.isSafeInteger(item.price) && item.price > 0).forEach(item => {
      const key = item.length + "|" + item.kind;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    });
    return groups;
  }
  function getDeals() {
    const groups = groupedComparables(state.items), signals = [];
    state.items.forEach(item => {
      if (!Number.isSafeInteger(item.price) || item.price <= 0) return;
      const peers = (groups.get(item.length + "|" + item.kind) || []).filter(peer => peer.key !== item.key);
      if (peers.length < 5) return;
      const reference = median(peers.map(peer => peer.price));
      if (!Number.isFinite(reference) || reference <= item.price) return;
      const discount = (reference - item.price) / reference * 100;
      signals.push({ ...item, reference, sample: peers.length, discount });
    });
    return signals.sort((a, b) => b.discount - a.discount);
  }

  function setWorkspace(type) {
    const usernames = type === "usernames";
    $("giftsWorkspace").classList.toggle("hide", usernames);
    $("usernameWorkspace").classList.toggle("hide", !usernames);
    document.body.dataset.marketWorkspace = usernames ? "usernames" : "gifts";
    document.querySelectorAll("[data-market-type]").forEach(button => {
      button.setAttribute("aria-selected", String(button.dataset.marketType === (usernames ? "usernames" : "gifts")));
    });
    if (usernames) renderAll();
  }
  function switchView(view) {
    activeView = allowedViews.includes(view) ? view : "overview";
    document.querySelectorAll("[data-username-section]").forEach(section => {
      section.classList.toggle("hide", section.dataset.usernameSection !== activeView);
    });
    document.querySelectorAll("#usernameTabs [data-username-view]").forEach(button => {
      const active = button.dataset.usernameView === activeView;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    });
    if (activeView === "market") renderMarket();
    if (activeView === "favorites") renderFavorites();
    if (activeView === "analytics") renderAnalytics();
    if (activeView === "deals") renderDeals();
    if (activeView === "sniper") renderEvents();
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([key, value]) => {
      if (key === "text") node.textContent = value;
      else if (key === "class") node.className = value;
      else if (key === "dataset") Object.entries(value).forEach(([k, v]) => node.dataset[k] = v);
      else if (key !== "style" && value != null) node.setAttribute(key, String(value));
    });
    (Array.isArray(children) ? children : children == null ? [] : [children]).forEach(child => {
      if (child == null) return;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    });
    return node;
  }
  function empty(message) {
    return el("div", { class: "empty username-empty", text: message });
  }
  function iconButton(label, action, className = "btn secondary") {
    const button = el("button", { type: "button", class: className, text: label });
    button.addEventListener("click", action);
    return button;
  }
  function openExternal(item) {
    const url = safeMarketUrl(item.url, item.lot_id);
    window.open(url, "_blank", "noopener,noreferrer");
  }
  function toggleFavorite(key) {
    const exists = state.favorites.includes(key);
    state.favorites = exists ? state.favorites.filter(value => value !== key) : [key, ...state.favorites].slice(0, MAX_ITEMS);
    persist();
    renderAll();
  }
  function openTarget(key) {
    const item = state.items.find(value => value.key === key);
    $("usernameTargetKey").value = key;
    $("usernameTargetTitle").textContent = item ? "Целевая цена · @" + item.username : "Целевая цена";
    $("usernameTargetPrice").value = state.targets[key] ? String(state.targets[key]) : "";
    $("usernameTargetRemove").classList.toggle("hide", !state.targets[key]);
    $("usernameTargetDialog").showModal();
  }
  function saveTarget(key, value) {
    const amount = number(value);
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_PRICE) {
      $("usernameTargetPrice").setCustomValidity("Укажи положительную целую цену.");
      $("usernameTargetPrice").reportValidity();
      return;
    }
    $("usernameTargetPrice").setCustomValidity("");
    state.targets[key] = amount;
    delete state.alertedTargets[key];
    persist();
    $("usernameTargetDialog").close();
    renderAll();
    checkTargets();
  }
  function removeTarget(key) {
    delete state.targets[key];
    delete state.alertedTargets[key];
    persist();
    $("usernameTargetDialog").close();
    renderAll();
  }

  function playSound(force) {
    if (!force && !state.soundEnabled) return;
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) {
      $("usernameSoundHint").textContent = "В этом браузере Web Audio недоступен.";
      return;
    }
    try {
      if (!audioContext) audioContext = new Audio();
      const startNotes = () => {
        [660, 880, 1046].forEach((frequency, index) => {
          const start = audioContext.currentTime + index * 0.15;
          const oscillator = audioContext.createOscillator();
          const gain = audioContext.createGain();
          oscillator.type = "sine";
          oscillator.frequency.setValueAtTime(frequency, start);
          gain.gain.setValueAtTime(0.0001, start);
          gain.gain.exponentialRampToValueAtTime(0.035, start + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.14);
          oscillator.connect(gain);
          gain.connect(audioContext.destination);
          oscillator.start(start);
          oscillator.stop(start + 0.15);
        });
      };
      if (audioContext.state === "suspended") audioContext.resume().then(startNotes).catch(() => {});
      else startNotes();
    } catch (_) {
      const hint = $("usernameSoundHint");
      if (hint) hint.textContent = "Браузер не разрешил воспроизведение звука.";
    }
  }
  function checkTargets() {
    let reached = 0;
    state.items.forEach(item => {
      const target = state.targets[item.key];
      if (!Number.isSafeInteger(target) || !Number.isSafeInteger(item.price)) return;
      if (item.price <= target) {
        if (state.soundEnabled && state.alertedTargets[item.key] !== target) {
          state.alertedTargets[item.key] = target;
          reached++;
        }
      } else if (state.alertedTargets[item.key] === target) {
        delete state.alertedTargets[item.key];
      }
    });
    if (reached) {
      announce("Целевая цена достигнута у " + reached + " юзернеймов." + (state.soundEnabled ? " Звуковой сигнал включён." : " Включи звук в настройках."), "success");
      if (state.soundEnabled) playSound(false);
      persist();
    }
  }

  function createUsernameRow(item, compact = false) {
    const favourite = state.favorites.includes(item.key);
    const delta = item.history.length > 1 ? item.history[item.history.length - 1].price - item.history[item.history.length - 2].price : null;
    const name = el("div", { class: "username-name-cell" }, [
      el("b", { text: "@" + item.username }),
      el("small", { text: "#" + item.lot_id + (item.status ? " · " + item.status : "") })
    ]);
    const length = el("span", { class: "username-length-chip", text: item.length + " симв." });
    const amount = el("strong", { class: "username-price", text: price(item.price) });
    const change = delta == null ? "—" : (delta > 0 ? "+" : "") + fmt(delta) + " ◉";
    const changeEl = el("span", { class: delta == null ? "muted" : delta < 0 ? "good" : "bad", text: change });
    const status = el("span", { class: "chip", text: item.status || "Не указан" });
    const actions = el("div", { class: "username-row-actions" }, [
      iconButton(favourite ? "★" : "☆", () => toggleFavorite(item.key), "username-icon-btn"),
      iconButton("ЦЕЛЬ", () => openTarget(item.key), "username-icon-btn"),
      iconButton("ОТКРЫТЬ ↗", () => openExternal(item), "username-icon-btn")
    ]);
    const row = el("tr", { class: "username-row" }, [
      el("td", {}, name), el("td", {}, length), el("td", {}, amount),
      el("td", {}, changeEl), el("td", {}, status), el("td", {}, actions)
    ]);
    if (compact) row.classList.add("is-compact");
    return row;
  }

  function getFilteredItems() {
    const query = safeText($("usernameSearch").value, 80).toLowerCase().replace(/^@/, "");
    const length = $("usernameLength").value;
    const kind = $("usernameKind").value;
    const min = $("usernameMinPrice").value === "" ? null : number($("usernameMinPrice").value);
    const max = $("usernameMaxPrice").value === "" ? null : number($("usernameMaxPrice").value);
    let rows = state.items.filter(item =>
      (!query || item.normalized.includes(query)) &&
      (!length || (length === "6+" ? item.length >= 6 : item.length === Number(length))) &&
      (!kind || item.kind === kind) &&
      (min == null || (Number.isFinite(min) && item.price != null && item.price >= min)) &&
      (max == null || (Number.isFinite(max) && item.price != null && item.price <= max))
    );
    const sort = $("usernameSort").value;
    const compareName = (a, b) => a.username.localeCompare(b.username, "en", { numeric: true });
    rows.sort((a, b) => {
      if (sort === "price_desc") return (b.price ?? -Infinity) - (a.price ?? -Infinity) || compareName(a, b);
      if (sort === "length_asc") return a.length - b.length || compareName(a, b);
      if (sort === "length_desc") return b.length - a.length || compareName(a, b);
      if (sort === "name_asc") return compareName(a, b);
      if (sort === "newest") return (Date.parse(b.observed_at || "") || 0) - (Date.parse(a.observed_at || "") || 0);
      return (a.price ?? Infinity) - (b.price ?? Infinity) || compareName(a, b);
    });
    return rows;
  }
  function renderMarket() {
    const body = $("usernameRows");
    body.replaceChildren();
    const rows = getFilteredItems();
    $("usernameMarketCount").textContent = rows.length.toLocaleString("ru-RU") + " из " + state.items.length.toLocaleString("ru-RU") + " объявлений";
    if (!rows.length) {
      body.append(el("tr", {}, el("td", { colspan: "6" }, empty(state.items.length ?
        "По выбранным фильтрам объявлений нет. Ослабь фильтры или сбрось их." :
        "База юзернеймов пока пуста. Загрузи JSON/CSV из раздела «Данные» или открой оригинальный Huevo Market."))));
      return;
    }
    rows.forEach(item => body.append(createUsernameRow(item)));
  }

  function renderEvents() {
    const list = $("usernameEvents");
    list.replaceChildren();
    $("usernameSniperCount").textContent = state.events.length.toLocaleString("ru-RU") + " событий";
    if (!state.events.length) {
      list.append(empty("Событий пока нет. После второго импорта AMNYAM сравнит цены и появление юзернеймов."));
      return;
    }
    state.events.forEach(event => {
      const label = event.type === "new" ? "НОВЫЙ ЮЗЕРНЕЙМ" : event.type === "down" ? "ЦЕНА СНИЗИЛАСЬ" : "ЦЕНА ВЫРОСЛА";
      const detail = event.type === "new" ? "Новая строка в последней выгрузке" :
        price(event.from) + " → " + price(event.price);
      list.append(el("article", { class: "username-event" }, [
        el("span", { class: "username-event-mark " + event.type, text: event.type === "down" ? "↘" : event.type === "up" ? "↗" : "+" }),
        el("div", {}, [el("b", { text: "@" + event.username }), el("small", { text: label + " · " + detail })]),
        el("time", { text: safeDate(event.at)?.toLocaleString("ru-RU") || "—" })
      ]));
    });
  }

  function renderDeals() {
    const list = $("usernameDealsList");
    list.replaceChildren();
    const signals = getDeals();
    $("usernameDealsCount").textContent = String(signals.length);
    $("usernameDealsMeta").textContent = signals.length ? signals.length + " СИГНАЛОВ" : "НЕТ НАДЁЖНОЙ ВЫБОРКИ";
    if (!signals.length) {
      list.append(empty("Пока нет группы минимум из 5 сопоставимых юзернеймов. Не буду считать случайное объявление выгодным без аналогов."));
      return;
    }
    signals.slice(0, 100).forEach(item => {
      const card = el("article", { class: "username-deal-card" }, [
        el("div", { class: "username-deal-top" }, [el("span", { class: "section-index", text: "@" + item.username }), el("span", { class: "discount-tag", text: "−" + fmt(item.discount) + "%" })]),
        el("strong", { class: "username-deal-price", text: price(item.price) }),
        el("small", { text: "Медиана " + price(item.reference) + " · аналогов: " + item.sample + " · " + item.length + " симв." }),
        el("div", { class: "username-deal-actions" }, [
          iconButton("☆ ИЗБРАННОЕ", () => toggleFavorite(item.key)),
          iconButton("ЗАДАТЬ ЦЕЛЬ", () => openTarget(item.key)),
          iconButton("ОТКРЫТЬ ↗", () => openExternal(item))
        ])
      ]);
      list.append(card);
    });
  }

  function renderFavorites() {
    const list = $("usernameFavoritesList");
    list.replaceChildren();
    const rows = state.favorites.map(key => state.items.find(item => item.key === key)).filter(Boolean);
    $("usernameWatchCount").textContent = state.favorites.length + " в наблюдении";
    $("usernameFavoritesCount").textContent = String(state.favorites.length);
    if (!rows.length) {
      list.append(empty(state.favorites.length ?
        "Сохранённые имена пока не попали в последнюю импортированную выгрузку. Избранное сохранено." :
        "Нажми ☆ в таблице рынка, чтобы добавить юзернейм в наблюдение."));
      return;
    }
    rows.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity)).forEach(item => {
      const target = state.targets[item.key];
      const reached = Number.isSafeInteger(target) && Number.isSafeInteger(item.price) && item.price <= target;
      list.append(el("article", { class: "username-watch-card" }, [
        el("div", {}, [el("b", { text: "@" + item.username }), el("small", { text: item.length + " символов · " + item.kind })]),
        el("strong", { text: price(item.price) }),
        el("span", { class: reached ? "good" : "muted", text: target ? (reached ? "ЦЕЛЬ ДОСТИГНУТА" : "ЦЕЛЬ " + price(target)) : "ЦЕЛЬ НЕ ЗАДАНА" }),
        el("div", { class: "username-row-actions" }, [
          iconButton(target ? "ИЗМЕНИТЬ ЦЕЛЬ" : "ЗАДАТЬ ЦЕЛЬ", () => openTarget(item.key)),
          iconButton("ОТКРЫТЬ ↗", () => openExternal(item)),
          iconButton("УБРАТЬ ☆", () => toggleFavorite(item.key))
        ])
      ]));
    });
  }

  function renderAnalytics() {
    const lengthBox = $("usernameLengthChart"), kindBox = $("usernameKindChart"), historyBox = $("usernameHistoryChart");
    lengthBox.replaceChildren(); kindBox.replaceChildren(); historyBox.replaceChildren();
    $("usernameAnalyticsStamp").textContent = state.items.length ? "СВЕЖЕСТЬ " + (safeDate(state.importedAt)?.toLocaleString("ru-RU") || "—") : "ОЖИДАЕТ ДАННЫЕ";
    if (!state.items.length) {
      lengthBox.append(empty("Нет данных для графика."));
      kindBox.append(empty("Нет данных для графика."));
      historyBox.append(empty("История появится после первого импорта."));
      $("usernameHistoryNote").textContent = "Нет импортированных срезов.";
      return;
    }
    const renderBars = (node, groups) => {
      const max = Math.max(1, ...groups.map(group => group.count));
      groups.forEach(group => {
        const row = el("div", { class: "username-bar-row" }, [
          el("span", { text: group.label }),
          el("div", { class: "username-bar-track" }, el("i", { class: "username-bar-w-" + Math.max(5, Math.min(100, Math.round(group.count / max * 20) * 5)) })),
          el("b", { text: group.count + (group.median != null ? " · " + price(group.median) : "") })
        ]);
        node.append(row);
      });
    };
    const byLength = new Map(), byKind = new Map();
    state.items.forEach(item => {
      byLength.set(item.length, [...(byLength.get(item.length) || []), item.price]);
      byKind.set(item.kind, [...(byKind.get(item.kind) || []), item.price]);
    });
    renderBars(lengthBox, Array.from(byLength, ([length, prices]) => ({
      label: length + " симв.", count: prices.length, median: median(prices)
    })).sort((a, b) => a.label.localeCompare(b.label, "ru", { numeric: true })));
    renderBars(kindBox, Array.from(byKind, ([kind, prices]) => ({
      label: ({ letters: "Буквы", digits: "Цифры", mixed: "Буквы + цифры", underscore: "Подчёркивание" })[kind] || kind,
      count: prices.length, median: median(prices)
    })).sort((a, b) => b.count - a.count));
    const snapshots = state.snapshots.slice(-12);
    if (!snapshots.length) historyBox.append(empty("История появится после импорта."));
    else {
      const maxCount = Math.max(1, ...snapshots.map(item => item.count));
      snapshots.forEach(snapshot => {
        const column = el("div", { class: "username-history-column" }, [
          el("i", { class: "username-bar-h-" + Math.max(5, Math.min(100, Math.round(snapshot.count / maxCount * 20) * 5)) }),
          el("b", { text: snapshot.median == null ? "—" : price(snapshot.median) }),
          el("small", { text: safeDate(snapshot.at)?.toLocaleDateString("ru-RU") || "—" })
        ]);
        historyBox.append(column);
      });
    }
    $("usernameHistoryNote").textContent = state.snapshots.length + " импортированных срезов · медиана рассчитана по ценам объявлений.";
  }

  function renderOverview() {
    const prices = state.items.map(item => item.price).filter(value => Number.isSafeInteger(value) && value > 0);
    const deals = getDeals();
    const targetsReached = state.items.filter(item => Number.isSafeInteger(state.targets[item.key]) && Number.isSafeInteger(item.price) && item.price <= state.targets[item.key]).length;
    const kpis = $("usernameKpis");
    kpis.replaceChildren();
    [
      ["Объявления", fmt(state.items.length), "В текущей выгрузке"],
      ["С ценой", fmt(prices.length), "Цена указана в источнике"],
      ["Медиана", price(median(prices)), "Цены объявлений"],
      ["Ниже ориентира", fmt(deals.length), "Только при ≥ 5 аналогах"],
      ["Избранное", fmt(state.favorites.length), "Личные отметки"],
      ["Цели достигнуты", fmt(targetsReached), "Проверка по текущему импорту"]
    ].forEach(([label, value, note]) => kpis.append(el("article", { class: "username-kpi" }, [
      el("small", { text: label }), el("b", { text: value }), el("span", { text: note })
    ])));
    $("usernameDataFreshness").textContent = state.importedAt ? "ИМПОРТ " + (safeDate(state.importedAt)?.toLocaleString("ru-RU") || "") : "НЕТ ИМПОРТА";
    $("usernameOverviewDeals").replaceChildren();
    $("usernameOverviewTargets").replaceChildren();
    if (!deals.length) $("usernameOverviewDeals").append(empty("Сигналы появятся после импорта достаточного количества аналогов."));
    else deals.slice(0, 4).forEach(item => $("usernameOverviewDeals").append(el("div", { class: "username-preview-row" }, [
      el("b", { text: "@" + item.username }), el("span", { class: "good", text: "−" + fmt(item.discount) + "%" }),
      el("small", { text: price(item.price) + " · база " + price(item.reference) })
    ])));
    const targetRows = state.items.filter(item => Number.isSafeInteger(state.targets[item.key])).slice(0, 4);
    if (!targetRows.length) $("usernameOverviewTargets").append(empty("Пока нет ценовых целей."));
    else targetRows.forEach(item => $("usernameOverviewTargets").append(el("div", { class: "username-preview-row" }, [
      el("b", { text: "@" + item.username }), el("span", { text: price(item.price) }),
      el("small", { class: item.price <= state.targets[item.key] ? "good" : "muted", text: "Цель " + price(state.targets[item.key]) })
    ])));
  }

  function renderAll() {
    renderOverview();
    renderMarket();
    renderEvents();
    renderDeals();
    renderFavorites();
    renderAnalytics();
    $("usernameNavCount").textContent = String(state.items.length);
    $("usernameDealsCount").textContent = String(getDeals().length);
    $("usernameFavoritesCount").textContent = String(state.favorites.length);
    $("usernameSoundEnabled").checked = state.soundEnabled;
    $("usernameSoundHint").textContent = state.soundEnabled ?
      "Звуковые сигналы включены. Только открытая вкладка, без Push и системных уведомлений." :
      "Звук выключен. Push и системные уведомления не используются.";
    const info = $("usernameStorageInfo");
    if (info) info.textContent = "Локально сохранено: " + state.items.length.toLocaleString("ru-RU") +
      " объявлений · профиль хранилища: " + (profileKey === "guest" ? "гостевой браузер" : "huEVO ID " + profileKey) + ".";
  }

  function csvCell(value) {
    let text = value == null ? "" : String(value);
    if (/^[\s]*[=+\-@\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }
  function download(name, type, text) {
    const blob = new Blob([type.includes("csv") ? "\uFEFF" + text : text], { type });
    const url = URL.createObjectURL(blob);
    const link = el("a", { href: url, download: name });
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1200);
  }
  function exportCsv() {
    if (!state.items.length) return announce("Нет данных для экспорта.", "error");
    const columns = ["username", "lot_id", "price", "status", "url", "observed_at"];
    const rows = [columns.join(";"), ...state.items.map(item => columns.map(key => csvCell(item[key])).join(";"))];
    download("amnyam-usernames-" + new Date().toISOString().slice(0, 10) + ".csv", "text/csv;charset=utf-8", rows.join("\r\n"));
    announce("Экспортировано " + state.items.length + " объявлений в CSV.", "success");
  }
  function downloadTemplate() {
    const template = {
      schema_version: 1, generated_at: null,
      usernames: [{
        username: "example_name", lot_id: "12345", price: 1000,
        status: "active", url: "https://huevo.su/market"
      }]
    };
    download("amnyam-usernames-template.json", "application/json;charset=utf-8", JSON.stringify(template, null, 2));
    announce("Шаблон скачан. example_name и 1000 — только пример структуры, не рыночные данные.");
  }

  async function importFile(file) {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) return announce("Файл слишком большой. Лимит — 8 МБ.", "error");
    try {
      const result = parseImport(await file.text(), file.name);
      const oldCount = state.items.length;
      mergeImport(result.items);
      renderAll();
      announce("Импортировано " + result.items.length + " из " + result.total + " строк." +
        (result.rejected ? " Пропущено некорректных: " + result.rejected + "." : "") +
        (oldCount ? " Выполнено сравнение с прошлой выгрузкой." : " Первый срез сохранён."), "success");
      if (state.soundEnabled) checkTargets();
    } catch (error) {
      announce(error && error.message ? error.message : "Не удалось импортировать файл.", "error");
    } finally {
      $("usernameImportFile").value = "";
    }
  }

  function bind() {
    document.querySelectorAll("[data-market-type]").forEach(button => {
      button.addEventListener("click", () => setWorkspace(button.dataset.marketType));
    });
    document.querySelectorAll("#usernameTabs [data-username-view]").forEach(button => {
      button.addEventListener("click", () => switchView(button.dataset.usernameView));
    });
    $("usernameTabs").addEventListener("keydown", event => {
      if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
      const tabs = Array.from($("usernameTabs").querySelectorAll('[role="tab"]'));
      const current = tabs.indexOf(event.target.closest('[role="tab"]'));
      if (current < 0) return;
      let next = current;
      if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
      else if (event.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
      else if (event.key === "Home") next = 0;
      else next = tabs.length - 1;
      event.preventDefault();
      switchView(tabs[next].dataset.usernameView);
      tabs[next].focus();
    });
    document.querySelectorAll("[data-username-go]").forEach(button => button.addEventListener("click", () => switchView(button.dataset.usernameGo)));
    ["usernameSearch", "usernameMinPrice", "usernameMaxPrice"].forEach(id => $(id).addEventListener("input", renderMarket));
    ["usernameLength", "usernameKind", "usernameSort"].forEach(id => $(id).addEventListener("change", renderMarket));
    $("usernameResetFilters").addEventListener("click", () => {
      ["usernameSearch", "usernameMinPrice", "usernameMaxPrice", "usernameLength", "usernameKind"].forEach(id => $(id).value = "");
      $("usernameSort").value = "price_asc";
      renderMarket();
    });
    $("usernameImportFile").addEventListener("change", event => importFile(event.target.files && event.target.files[0]));
    $("usernameExportCsv").addEventListener("click", exportCsv);
    $("usernameDownloadTemplate").addEventListener("click", downloadTemplate);
    $("usernameTargetClose").addEventListener("click", () => $("usernameTargetDialog").close());
    $("usernameTargetDialog").addEventListener("click", event => { if (event.target === $("usernameTargetDialog")) $("usernameTargetDialog").close(); });
    $("usernameTargetForm").addEventListener("submit", event => {
      event.preventDefault(); saveTarget($("usernameTargetKey").value, $("usernameTargetPrice").value);
    });
    $("usernameTargetRemove").addEventListener("click", () => removeTarget($("usernameTargetKey").value));
    $("usernameTestSound").addEventListener("click", () => playSound(true));
    $("usernameSoundEnabled").addEventListener("change", event => {
      state.soundEnabled = event.target.checked;
      persist();
      renderAll();
      if (state.soundEnabled) { playSound(true); checkTargets(); }
    });
    $("usernameClearData").addEventListener("click", () => {
      if (!window.confirm("Удалить импортированные объявления, историю и события юзернеймов для текущего профиля браузера?")) return;
      state.items = []; state.events = []; state.snapshots = []; state.importedAt = null;
      state.favorites = []; state.targets = {}; state.alertedTargets = {};
      persist(); renderAll(); announce("Локальная база юзернеймов очищена.", "success");
    });
  }

  function hydrateProfile(nextKey) {
    if (!/^(?:guest|\d{1,20})$/.test(nextKey) || nextKey === profileKey) return;
    profileKey = nextKey;
    state = readState();
    renderAll();
  }
  window.addEventListener("amnyam:market", event => {
    const next = event.detail && event.detail.profileKey ? String(event.detail.profileKey) : "guest";
    hydrateProfile(next);
  });
  state = readState();
  bind();
  if (window.AMNYAM_MARKET && window.AMNYAM_MARKET.profileKey) hydrateProfile(String(window.AMNYAM_MARKET.profileKey));
  renderAll();
  switchView("overview");
})();