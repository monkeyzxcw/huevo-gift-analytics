(() => {
  "use strict";
  const KEY = "amnyam.fieldkit.v1";
  const $ = (id) => document.getElementById(id);
  const safeRead = () => {
    try {
      const value = JSON.parse(localStorage.getItem(KEY) || "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch (_) { return {}; }
  };
  const store = safeRead();
  const history = Array.isArray(store.history) ? store.history.filter(x => typeof x === "string").slice(0, 12) : [];
  const saved = Array.isArray(store.saved) ? store.saved.filter(x => x && typeof x.query === "string" && typeof x.name === "string").slice(0, 12) : [];
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify({ history: history.slice(0, 12), saved: saved.slice(0, 12), compact, focus, motion })); } catch (_) {} };
  let compact = Boolean(store.compact), focus = Boolean(store.focus), motion = Boolean(store.motion);
  let market = { lots: [], deals: [] };
  const input = $("search"), min = $("pmin"), max = $("pmax"), sort = $("sortBy");
  if (!input || !min || !max || !sort) return;

  const root = document.createElement("details");
  root.className = "fieldkit";
  const summary = document.createElement("summary");
  summary.textContent = "⚒  AMNYAM FIELD KIT · 20 инструментов";
  root.append(summary);
  const status = document.createElement("p");
  status.className = "fieldkit-status";
  status.setAttribute("role", "status");
  status.textContent = "Быстрые операции с текущим каталогом · без дополнительных запросов к Huevo";
  root.append(status);
  const groups = [
    ["ЦЕНА В ОДНО НАЖАТИЕ", [
      ["До 50 000", () => priceRange("", "50000")],
      ["До 100 000", () => priceRange("", "100000")],
      ["До 250 000", () => priceRange("", "250000")],
      ["От 500 000", () => priceRange("500000", "")],
      ["Убрать лимиты", () => priceRange("", "")]
    ]],
    ["СОРТИРОВКА И ФИЛЬТРЫ", [
      ["Сначала дешёвые", () => setSort("price:1")],
      ["Сначала дорогие", () => setSort("price:-1")],
      ["Больше аналогов", () => setSort("lot_count:-1")],
      ["Сначала новые", () => setSort("first_seen:-1")],
      ["Полный сброс", () => $("reset").click()]
    ]],
    ["ЭКСПОРТ И ОБМЕН", [
      ["Копировать ID страницы", copyIds],
      ["CSV текущей страницы", exportVisibleCsv],
      ["JSON текущей страницы", exportVisibleJson],
      ["Копировать условия поиска", copyQuery],
      ["Сохранить быстрый поиск", saveSearch]
    ]],
    ["ПЕРСОНАЛЬНАЯ РАБОЧАЯ СРЕДА", [
      ["Вернуть недавний поиск", restoreSearch],
      ["Компактные строки", toggleCompact],
      ["Режим фокуса", toggleFocus],
      ["Уменьшить анимации", toggleMotion],
      ["Горячие клавиши", showKeys]
    ]]
  ];
  const controls = document.createElement("div");
  controls.className = "fieldkit-groups";
  groups.forEach(([title, actions]) => {
    const section = document.createElement("section");
    section.className = "fieldkit-group";
    const heading = document.createElement("b");
    heading.textContent = title;
    section.append(heading);
    const row = document.createElement("div");
    row.className = "fieldkit-actions";
    actions.forEach(([label, action]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "fieldkit-action";
      button.textContent = label;
      button.addEventListener("click", () => {
        try { action(); } catch (_) { announce("Не удалось выполнить действие. Проверь доступность функции в браузере."); }
      });
      row.append(button);
    });
    section.append(row);
    controls.append(section);
  });
  root.append(controls);
  const recent = document.createElement("select");
  recent.className = "select fieldkit-recent";
  recent.setAttribute("aria-label", "Недавние поисковые запросы");
  const recentLabel = document.createElement("label");
  recentLabel.className = "fieldkit-recent-label";
  recentLabel.textContent = "Недавние запросы";
  recentLabel.append(recent);
  root.append(recentLabel);
  const savedSelect = document.createElement("select");
  savedSelect.className = "select fieldkit-recent";
  savedSelect.setAttribute("aria-label", "Сохранённые быстрые поиски");
  const savedLabel = document.createElement("label");
  savedLabel.className = "fieldkit-recent-label";
  savedLabel.textContent = "Сохранённые наборы";
  savedLabel.append(savedSelect);
  root.append(savedLabel);
  const tips = document.querySelector(".search-tips");
  if (tips) tips.insertAdjacentElement("afterend", root);

  function announce(message) { status.textContent = message; }
  function apply() {
    $("globalSearch").value = input.value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    announce("Фильтр применён · " + new Date().toLocaleTimeString("ru-RU"));
  }
  function priceRange(low, high) { min.value = low; max.value = high; apply(); }
  function setSort(value) { sort.value = value; sort.dispatchEvent(new Event("change", { bubbles: true })); announce("Сортировка обновлена."); }
  function currentRows() { return Array.from(document.querySelectorAll("#rows tr")).filter(row => row.querySelector(".lot")); }
  function rowData(row) {
    const cells = row.querySelectorAll("td");
    const title = cells[0]?.querySelector("strong")?.textContent?.trim() || "";
    const idText = cells[0]?.querySelector("small")?.textContent || "";
    const id = (idText.match(/#([\d]+)/) || [])[1] || "";
    const priceText = cells[1]?.querySelector(".price-value")?.textContent || "";
    const priceValue = Number(priceText.replace(/[^\d,.-]/g, "").replace(/\s/g, "").replace(",", "."));
    return { id, title, price: Number.isFinite(priceValue) ? priceValue : null, rarity: cells[3]?.querySelector(".chip")?.textContent || "", delta: cells[4]?.textContent?.trim() || "" };
  }
  async function copy(text) {
    if (!text) { announce("Нет данных для копирования."); return; }
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else {
        const area = document.createElement("textarea");
        area.value = text; area.style.position = "fixed"; area.style.opacity = "0";
        document.body.append(area); area.select();
        const ok = document.execCommand("copy"); area.remove();
        if (!ok) throw new Error("copy unavailable");
      }
      announce("Скопировано в буфер обмена.");
    } catch (_) { announce("Браузер запретил копирование. Выдели данные вручную."); }
  }
  function copyIds() { copy(currentRows().map(row => rowData(row).id).filter(Boolean).join("\n")); }
  function csvCell(value) {
    let text = value == null ? "" : String(value);
    if (/^[\s]*[=+\-@\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }
  function download(name, type, value) {
    const blob = new Blob([type === "text/csv;charset=utf-8" ? "\ufeff" + value : value], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1200);
    announce("Файл подготовлен: " + name);
  }
  function exportVisibleCsv() {
    const rows = currentRows().map(rowData);
    if (!rows.length) return announce("На текущей странице нет строк для экспорта.");
    const columns = ["id", "title", "price", "rarity", "delta"];
    download("amnyam-page.csv", "text/csv;charset=utf-8", [columns.join(";"), ...rows.map(row => columns.map(key => csvCell(row[key])).join(";"))].join("\r\n"));
  }
  function exportVisibleJson() {
    const rows = currentRows().map(rowData);
    if (!rows.length) return announce("На текущей странице нет строк для экспорта.");
    download("amnyam-page.json", "application/json;charset=utf-8", JSON.stringify({ exported_at: new Date().toISOString(), rows }, null, 2));
  }
  function copyQuery() {
    const params = new URLSearchParams();
    params.set("q", input.value); params.set("min", min.value); params.set("max", max.value); params.set("rarity", $("rarity").value); params.set("status", $("status").value); params.set("sort", sort.value);
    copy(params.toString());
  }
  function rememberSearch() {
    const query = input.value.trim();
    if (!query) return;
    const index = history.indexOf(query);
    if (index >= 0) history.splice(index, 1);
    history.unshift(query); history.splice(12);
    persist(); renderSelects();
  }
  function saveSearch() {
    const query = input.value.trim();
    const name = query || [min.value && "от " + min.value, max.value && "до " + max.value].filter(Boolean).join(" ") || "Все лоты";
    const snapshot = { name: name.slice(0, 50), query, min: min.value, max: max.value, rarity: $("rarity").value, status: $("status").value, sort: sort.value };
    const index = saved.findIndex(item => item.name === snapshot.name);
    if (index >= 0) saved.splice(index, 1);
    saved.unshift(snapshot); saved.splice(12); persist(); renderSelects();
    announce("Быстрый поиск сохранён локально в этом браузере.");
  }
  function restoreSearch() {
    const value = recent.value;
    if (value === "") return announce("Выбери запрос из списка недавних поисков.");
    input.value = history[Number(value)] || "";
    apply(); announce("Недавний поиск восстановлен.");
  }
  function restore(item) {
    input.value = item.query || ""; min.value = item.min || ""; max.value = item.max || "";
    $("rarity").value = item.rarity || ""; $("status").value = item.status || "";
    sort.value = item.sort || "price:1"; setSort(sort.value); apply();
    announce("Сохранённый набор применён.");
  }
  function renderSelects() {
    recent.replaceChildren();
    const empty = document.createElement("option"); empty.value = ""; empty.textContent = "Выбрать недавний запрос…"; recent.append(empty);
    history.forEach((query, index) => { const option = document.createElement("option"); option.value = String(index); option.textContent = query.slice(0, 70); recent.append(option); });
    savedSelect.replaceChildren();
    const none = document.createElement("option"); none.value = ""; none.textContent = "Выбрать сохранённый набор…"; savedSelect.append(none);
    saved.forEach((item, index) => { const option = document.createElement("option"); option.value = String(index); option.textContent = item.name; savedSelect.append(option); });
  }
  function toggleCompact() {
    compact = !compact; document.body.classList.toggle("amnyam-compact", compact); persist();
    announce(compact ? "Компактные строки включены." : "Обычная плотность таблицы восстановлена.");
  }
  function toggleFocus() {
    focus = !focus; document.body.classList.toggle("amnyam-focus", focus); persist();
    announce(focus ? "Режим фокуса включён. Повторное нажатие вернёт панели." : "Режим фокуса выключен.");
  }
  function toggleMotion() {
    motion = !motion; document.body.classList.toggle("amnyam-calm", motion); persist();
    announce(motion ? "Дополнительные анимации отключены." : "Обычные анимации восстановлены.");
  }
  function showKeys() {
    announce("Клавиши: Ctrl/⌘+K — команды · / — поиск · G затем M — маркет · G затем D — сделки · Esc — закрыть диалог.");
    const dialog = document.getElementById("commandPalette");
    if (dialog && typeof dialog.showModal === "function") {
      const field = document.getElementById("commandPaletteInput");
      if (field) field.value = "горячие клавиши";
    }
  }
  input.addEventListener("change", rememberSearch);
  input.addEventListener("keydown", event => { if (event.key === "Enter") rememberSearch(); });
  recent.addEventListener("change", restoreSearch);
  savedSelect.addEventListener("change", () => { if (savedSelect.value !== "") restore(saved[Number(savedSelect.value)]); });
  window.addEventListener("amnyam:market", event => {
    const detail = event.detail || {};
    market = { lots: Array.isArray(detail.lots) ? detail.lots : [], deals: Array.isArray(detail.deals) ? detail.deals : [] };
    announce("Срез рынка: " + market.lots.length.toLocaleString("ru-RU") + " лотов · сигналов: " + market.deals.length.toLocaleString("ru-RU") + " · Field Kit не делает дополнительных запросов.");
  });
  renderSelects();
  document.body.classList.toggle("amnyam-compact", compact);
  document.body.classList.toggle("amnyam-focus", focus);
  document.body.classList.toggle("amnyam-calm", motion);
})();