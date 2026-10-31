"use strict";
(function () {
  const $ = (id) => document.getElementById(id);
  const KEYS = { prefs: "amnyam.desk.prefs.v1", recent: "amnyam.desk.recent.v1", notes: "amnyam.desk.notes.v1", checklist: "amnyam.desk.checklist.v1" };
  const defaults = { density: "normal", contrast: false, largeText: false, focus: false, motion: false, decor: true };
  const safeRead = (key, fallback) => { try { const v = JSON.parse(localStorage.getItem(key) || "null"); return v == null ? fallback : v; } catch (_) { return fallback; } };
  const prefs = Object.assign({}, defaults, safeRead(KEYS.prefs, {}));
  let sessionStarted = Date.now(), selectedRecentId = "";
  const readRecent = () => { const v = safeRead(KEYS.recent, []); return Array.isArray(v) ? v.filter(x => x && /^.{1,160}$/.test(String(x.title || "")) && /^https:\/\/huevo\.su\/market\/lot\//.test(String(x.url || ""))).slice(0, 12) : []; };
  const readNotes = () => { const v = safeRead(KEYS.notes, {}); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; };
  const savePrefs = () => { try { localStorage.setItem(KEYS.prefs, JSON.stringify(prefs)); } catch (_) {} };
  function status(message) { const el = $("deskStatus"); if (el) el.textContent = message; }
  function updatePrefsStatus() {
    const active = [prefs.density === "compact" && "компактный режим", prefs.contrast && "контраст", prefs.largeText && "крупный текст", prefs.focus && "фокус", prefs.motion && "без движения", !prefs.decor && "без декора"].filter(Boolean);
    status(active.length ? "Включено: " + active.join(" · ") : "Стандартный вид");
  }
  function applyPrefs() {
    const b = document.body;
    b.classList.toggle("desk-compact", prefs.density === "compact");
    b.classList.toggle("desk-high-contrast", !!prefs.contrast);
    b.classList.toggle("desk-large-text", !!prefs.largeText);
    b.classList.toggle("desk-focus", !!prefs.focus);
    b.classList.toggle("desk-reduce-motion", !!prefs.motion);
    b.classList.toggle("desk-no-decor", !prefs.decor);
    if ($("deskDensity")) $("deskDensity").value = prefs.density;
    [["deskContrast","contrast"],["deskLargeText","largeText"],["deskFocus","focus"],["deskMotion","motion"],["deskDecor","decor"]].forEach(([id,key]) => { if ($(id)) $(id).checked = !!prefs[key]; });
    updatePrefsStatus();
  }
  function renderRecent() {
    const list = $("deskRecentList"); if (!list) return;
    while (list.firstChild) list.removeChild(list.firstChild);
    const recent = readRecent();
    if (!recent.length) { const empty = document.createElement("p"); empty.className = "muted"; empty.textContent = "Открывай лоты в каталоге — последние просмотренные появятся здесь."; list.append(empty); $("deskNoteEditor").hidden = true; return; }
    recent.forEach(item => {
      const row = document.createElement("div"); row.className = "desk-recent-row";
      const link = document.createElement("a"); link.href = item.url; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = item.title;
      const note = document.createElement("button"); note.type = "button"; note.className = "btn secondary"; note.textContent = selectedRecentId === item.id ? "Выбрано" : "Заметка";
      note.addEventListener("click", () => { selectedRecentId = item.id; $("deskNoteEditor").hidden = false; $("deskNoteTitle").textContent = item.title; $("deskNoteText").value = String(readNotes()[item.id] || ""); renderRecent(); $("deskNoteText").focus(); });
      row.append(link, note); list.append(row);
    });
    if (selectedRecentId && recent.some(x => x.id === selectedRecentId)) $("deskNoteEditor").hidden = false;
  }
  function recordRecent(target) {
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a[href*="huevo.su/market/lot/"], [data-lot-id]');
    if (!anchor) return;
    const href = anchor.href || anchor.getAttribute("href") || "";
    const id = String(anchor.dataset.lotId || (href.match(/\/market\/lot\/([^/?#]+)/) || [])[1] || "");
    if (!id || !/^https:\/\/huevo\.su\/market\/lot\//.test(href)) return;
    const title = (anchor.getAttribute("aria-label") || anchor.textContent || anchor.closest("tr,article,li")?.textContent || "Лот " + id).replace(/\s+/g, " ").trim().slice(0, 160);
    const list = readRecent().filter(x => x.id !== id); list.unshift({ id, title, url: href, seenAt: new Date().toISOString() });
    try { localStorage.setItem(KEYS.recent, JSON.stringify(list.slice(0, 12))); } catch (_) {}
    selectedRecentId = id; renderRecent();
  }
  function downloadJson(name, value) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }), url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportDesk() {
    downloadJson("amnyam-desk-backup.json", { schema: "amnyam-desk-backup-v1", exported_at: new Date().toISOString(), prefs, recent: readRecent(), notes: readNotes(), checklist: safeRead(KEYS.checklist, {}) });
    status("Резервная копия интерфейса создана");
  }
  function importDesk(file) {
    if (!file || file.size > 256 * 1024) { status("Файл слишком большой (лимит 256 КБ)"); return; }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result || ""));
        if (!data || data.schema !== "amnyam-desk-backup-v1" || !data.prefs || typeof data.prefs !== "object") throw new Error("format");
        const next = Object.assign({}, defaults);
        if (["normal","compact"].includes(data.prefs.density)) next.density = data.prefs.density;
        ["contrast","largeText","focus","motion","decor"].forEach(k => { if (typeof data.prefs[k] === "boolean") next[k] = data.prefs[k]; });
        Object.keys(prefs).forEach(k => delete prefs[k]); Object.assign(prefs, next); savePrefs();
        if (Array.isArray(data.recent)) localStorage.setItem(KEYS.recent, JSON.stringify(data.recent.filter(x => x && /^https:\/\/huevo\.su\/market\/lot\//.test(String(x.url || ""))).slice(0, 12)));
        if (data.notes && typeof data.notes === "object" && !Array.isArray(data.notes)) localStorage.setItem(KEYS.notes, JSON.stringify(Object.fromEntries(Object.entries(data.notes).filter(([k,v]) => /^.{1,120}$/.test(k) && typeof v === "string").slice(0, 100))));
        if (data.checklist && typeof data.checklist === "object") localStorage.setItem(KEYS.checklist, JSON.stringify(data.checklist));
        applyPrefs(); renderRecent(); renderChecklist(); status("Настройки восстановлены");
      } catch (_) { status("Не удалось импортировать: файл не похож на резервную копию AMNYAM"); }
      $("deskImportFile").value = "";
    };
    reader.readAsText(file);
  }
  function renderChecklist() {
    const value = safeRead(KEYS.checklist, {});
    document.querySelectorAll("[data-desk-check]").forEach(el => { el.checked = value[el.dataset.deskCheck] === true; });
  }
  function fallbackCopy(value) {
    const area = document.createElement("textarea"); area.value = value; area.style.position = "fixed"; area.style.opacity = "0"; document.body.append(area); area.select();
    try { document.execCommand("copy"); status("Скопировано"); } catch (_) { status("Не удалось скопировать"); } area.remove();
  }
  function exportTableTsv() {
    const rows = Array.from(document.querySelectorAll("#rows tr")).filter(row => row.offsetParent !== null);
    if (!rows.length) { status("Нет видимых строк каталога для копирования"); return; }
    const value = rows.map(row => Array.from(row.querySelectorAll("th,td")).map(cell => cell.innerText.replace(/\s+/g, " ").trim().replace(/\t/g, " ")).join("\t")).join("\n");
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(value).then(() => status("Скопировано строк: " + rows.length)).catch(() => fallbackCopy(value));
    else fallbackCopy(value);
  }
  function openShortcuts() { const dialog = $("deskShortcuts"); if (dialog && !dialog.open) dialog.showModal(); }
  function navigateShortcut(index) { const button = Array.from(document.querySelectorAll("#mainNav [data-view]"))[index]; if (button) button.click(); }
  function init() {
    applyPrefs(); renderRecent(); renderChecklist();
    $("deskDensity")?.addEventListener("change", e => { prefs.density = e.target.value === "compact" ? "compact" : "normal"; savePrefs(); applyPrefs(); });
    [["deskContrast","contrast"],["deskLargeText","largeText"],["deskFocus","focus"],["deskMotion","motion"],["deskDecor","decor"]].forEach(([id,key]) => $(id)?.addEventListener("change", e => { prefs[key] = e.target.checked; savePrefs(); applyPrefs(); }));
    $("deskExport")?.addEventListener("click", exportDesk);
    $("deskImportFile")?.addEventListener("change", e => importDesk(e.target.files && e.target.files[0]));
    $("deskReset")?.addEventListener("click", () => { Object.assign(prefs, defaults); savePrefs(); applyPrefs(); status("Настройки рабочего места сброшены"); });
    $("deskShortcutsOpen")?.addEventListener("click", openShortcuts);
    $("deskShortcutsClose")?.addEventListener("click", () => $("deskShortcuts")?.close());
    $("deskCopyUrl")?.addEventListener("click", () => { const value = location.href; if (navigator.clipboard?.writeText) navigator.clipboard.writeText(value).then(() => status("Адрес AMNYAM скопирован")).catch(() => fallbackCopy(value)); else fallbackCopy(value); });
    $("deskTop")?.addEventListener("click", () => window.scrollTo({ top: 0, behavior: prefs.motion ? "auto" : "smooth" }));
    $("deskCopyTable")?.addEventListener("click", exportTableTsv);
    $("deskSessionReset")?.addEventListener("click", () => { sessionStarted = Date.now(); status("Таймер сессии сброшен"); updateSession(); });
    $("deskNoteSave")?.addEventListener("click", () => {
      if (!selectedRecentId) return;
      const notes = readNotes(), value = $("deskNoteText").value.slice(0, 1000);
      if (value.trim()) notes[selectedRecentId] = value; else delete notes[selectedRecentId];
      try { localStorage.setItem(KEYS.notes, JSON.stringify(notes)); status("Заметка сохранена локально"); } catch (_) { status("Не удалось сохранить заметку"); }
    });
    document.querySelectorAll("[data-desk-check]").forEach(el => el.addEventListener("change", () => { const value = safeRead(KEYS.checklist, {}); value[el.dataset.deskCheck] = el.checked; try { localStorage.setItem(KEYS.checklist, JSON.stringify(value)); } catch (_) {} }));
    document.addEventListener("click", event => recordRecent(event.target));
    document.addEventListener("keydown", event => {
      const target = event.target, typing = target && (target.matches("input,textarea,select") || target.isContentEditable);
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "f") { event.preventDefault(); $("globalSearch")?.focus(); return; }
      if (event.ctrlKey && event.shiftKey && /^[1-8]$/.test(event.key)) { event.preventDefault(); navigateShortcut(Number(event.key) - 1); return; }
      if (event.key === "?" && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); openShortcuts(); return; }
      if (event.key === "Escape" && !typing && $("globalSearch")?.value) { $("globalSearch").value = ""; $("globalSearch").dispatchEvent(new Event("input", { bubbles: true })); }
    });
    window.setInterval(updateSession, 1000); updateSession();
  }
  function updateSession() {
    const el = $("deskSessionTimer"); if (!el) return;
    const seconds = Math.max(0, Math.floor((Date.now() - sessionStarted) / 1000));
    el.textContent = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, "0")).join(":");
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true }); else init();
})();