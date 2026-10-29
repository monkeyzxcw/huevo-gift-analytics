(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const format = value => value === null || value === undefined || value === "" || !Number.isFinite(Number(value))
    ? "—" : Number(value).toLocaleString("ru-RU", { maximumFractionDigits: 1 });
  const price = value => {
    const n = Number(value);
    return value === null || value === undefined || value === "" || !Number.isFinite(n) || n < 0 ? null : n;
  };
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
  let refreshInFlight = false;
  let lastLots = [];
  async function api(path) {
    const response = await fetch(path, { headers: { Accept: "application/json" } });
    let payload = {};
    try { payload = await response.json(); } catch (_) {}
    if (!response.ok) throw new Error(payload.detail || ("HTTP " + response.status));
    return payload;
  }
  function setStatus(message, kind) {
    const node = $("analyticsStatus");
    if (!node) return;
    node.textContent = message;
    node.classList.toggle("good", kind === "good");
    node.classList.toggle("error", kind === "error");
  }
  function keyOf(lot) {
    return String(lot.title || "").trim().toLocaleLowerCase("ru").replace(/\s+/g, " ");
  }
  function renderCoverage(lots, diagnostic, stats) {
    const total = Number(stats.n_total ?? diagnostic.lots_in_database ?? lots.length);
    const priced = Number(stats.n ?? lots.filter(lot => price(lot.price) !== null).length);
    const coverage = total > 0 ? Math.round(priced / total * 100) : 0;
    $("coverageScore").textContent = total ? String(Math.min(100, coverage)) : "—";
    $("coverageLots").textContent = format(total);
    $("coveragePriced").textContent = format(priced);
    $("coverageUnpriced").textContent = format(Math.max(0, total - priced));
    $("coverageDonut").style.background = total
      ? "conic-gradient(var(--gold) 0 " + coverage + "%,#302b20 " + coverage + "% 100%)"
      : "conic-gradient(#302b20 0 100%)";
    $("coverageDonut").setAttribute("aria-label", total
      ? "Известная цена есть у " + coverage + "% лотов"
      : "Каталог пока пуст");
    // Match the existing KPI: this is the count of offers with a parsed price.
    $("count").textContent = format(priced);
    if (lots.length) {
      const prices = lots.map(lot => price(lot.price)).filter(n => n !== null);
      $("avg").textContent = prices.length ? format(prices.reduce((sum, n) => sum + n, 0) / prices.length) + " ◉" : "—";
      $("min").textContent = prices.length ? format(Math.min(...prices)) + " ◉" : "—";
      $("max").textContent = prices.length ? format(Math.max(...prices)) + " ◉" : "—";
    }
  }
  function renderPriceBins(lots) {
    const values = lots.map(lot => price(lot.price)).filter(n => n !== null).sort((a, b) => a - b);
    $("priceBinCount").textContent = values.length + " цен";
    if (!values.length) {
      $("priceBins").innerHTML = '<div class="empty">Пока нет импортированных цен.</div>';
      return;
    }
    const quantile = p => values[Math.floor((values.length - 1) * p)];
    const cuts = [quantile(.25), quantile(.5), quantile(.75)];
    const bins = [
      { label: "≤ " + format(cuts[0]), test: n => n <= cuts[0] },
      { label: format(cuts[0]) + "–" + format(cuts[1]), test: n => n > cuts[0] && n <= cuts[1] },
      { label: format(cuts[1]) + "–" + format(cuts[2]), test: n => n > cuts[1] && n <= cuts[2] },
      { label: "> " + format(cuts[2]), test: n => n > cuts[2] }
    ];
    bins.forEach(bin => { bin.count = values.filter(bin.test).length; });
    const maximum = Math.max(1, ...bins.map(bin => bin.count));
    $("priceBins").innerHTML = bins.map(bin =>
      '<div class="analytics-bar-row"><span class="analytics-bar-name">' + esc(bin.label) +
      '</span><div class="analytics-track"><div class="analytics-fill" style="width:' +
      Math.round(bin.count / maximum * 100) + '%"></div></div><span class="analytics-count">' +
      bin.count + "</span></div>"
    ).join("");
  }
  function renderRarity(lots) {
    const groups = new Map();
    lots.forEach(lot => {
      const name = String(lot.rarity || "Не указана");
      groups.set(name, (groups.get(name) || 0) + 1);
    });
    const entries = [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const maximum = Math.max(1, ...entries.map(entry => entry[1]));
    $("rarityBars").innerHTML = entries.length ? entries.map(([name, count]) =>
      '<div class="analytics-bar-row"><span class="analytics-bar-name" title="' + esc(name) + '">' +
      esc(name) + '</span><div class="analytics-track"><div class="analytics-fill" style="width:' +
      Math.round(count / maximum * 100) + '%"></div></div><span class="analytics-count">' +
      count + "</span></div>"
    ).join("") : '<div class="empty">Категории появятся после импорта.</div>';
  }
  function renderDeviations(lots) {
    const buckets = new Map();
    lots.filter(lot => price(lot.price) !== null).forEach(lot => {
      const key = keyOf(lot);
      if (!key) return;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(lot);
    });
    const comparisons = [];
    buckets.forEach(group => {
      if (group.length < 2) return;
      const average = group.reduce((sum, lot) => sum + price(lot.price), 0) / group.length;
      if (!average) return;
      group.forEach(lot => comparisons.push({
        lot,
        delta: Math.round((price(lot.price) / average - 1) * 100)
      }));
    });
    comparisons.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    const leaders = comparisons.slice(0, 4);
    const maximum = Math.max(1, ...leaders.map(entry => Math.abs(entry.delta)));
    $("deviationBars").innerHTML = leaders.length ? leaders.map(entry => {
      const lot = entry.lot, delta = entry.delta, kind = delta < 0 ? "good" : "bad";
      return '<div class="deviation-mini-row"><span class="deviation-mini-name" title="' +
        esc(lot.title || lot.lot_id) + '">#' + esc(lot.lot_id) + " · " + esc(lot.title || "Без названия") +
        '</span><span class="deviation-mini-value ' + kind + '">' + (delta > 0 ? "+" : "") + delta +
        '%</span><div class="deviation-mini-track"><div class="deviation-mini-fill ' + kind +
        '" style="width:' + Math.max(4, Math.round(Math.abs(delta) / maximum * 100)) +
        '%"></div></div></div>';
    }).join("") : '<div class="empty">Нужны несколько лотов с одинаковым названием.</div>';
  }
  async function refresh() {
    if (refreshInFlight) return;
    refreshInFlight = true;
    try {
      const results = await Promise.all([
        api("/api/stats"),
        api("/api/lots?limit=2000"),
        api("/api/diagnostics"),
        api("/api/status")
      ]);
      const stats = results[0] || {};
      const lots = Array.isArray(results[1]) ? results[1] : [];
      const diagnostic = results[2] || {};
      const status = results[3] || {};
      lastLots = lots;
      renderCoverage(lots, diagnostic, stats);
      renderPriceBins(lots);
      renderRarity(lots);
      renderDeviations(lots);
      const imported = Number(diagnostic.lots_in_database || 0);
      const history = Number(diagnostic.price_history_rows || 0);
      if (imported) {
        setStatus("Подключено к API · " + format(imported) + " лотов · " + format(history) +
          " снимков истории. " + (status.message || ""), "good");
      } else {
        setStatus("API доступен, но база пока пуста. Загрузите реальные лоты браузерным сборщиком; демонстрационные котировки не подставляются.", "");
      }
    } catch (error) {
      setStatus("Аналитика не загружена: " + error.message, "error");
    } finally {
      refreshInFlight = false;
    }
  }
  window.HuevoObsidianAnalytics = { refresh };
  document.addEventListener("DOMContentLoaded", refresh);
  const refreshButton = document.getElementById("refresh");
  if (refreshButton) refreshButton.addEventListener("click", () => setTimeout(refresh, 1200));
  window.addEventListener("focus", refresh);
  window.setInterval(refresh, 30000);
})();