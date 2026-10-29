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
  let marketMode = true;
  let selectedTrendLot = "";
  let marketTrendRequest = 0;
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
    $("avg").textContent = stats.avgp === null || stats.avgp === undefined ? "—" : format(stats.avgp) + " ◉";
    $("min").textContent = stats.minp === null || stats.minp === undefined ? "—" : format(stats.minp) + " ◉";
    $("max").textContent = stats.maxp === null || stats.maxp === undefined ? "—" : format(stats.maxp) + " ◉";
  }
  function renderPriceBins(lots) {
    const values = lots.map(lot => price(lot.price)).filter(n => n !== null).sort((a, b) => a - b);
    $("priceBinCount").textContent = values.length + " цен";
    if (!values.length) {
      $("priceBins").innerHTML = '<div class="empty">Пока нет импортированных цен.</div>';
      return;
    }
    const low = values[0], high = values[values.length - 1];
    const bins = low === high
      ? [{ label: format(low), count: values.length }]
      : Array.from({ length: 4 }, (_, index) => {
          const left = low + (high - low) * index / 4;
          const right = low + (high - low) * (index + 1) / 4;
          const count = values.filter(value => index === 0
            ? value <= right
            : index === 3 ? value > left : value > left && value <= right).length;
          const label = index === 0 ? "≤ " + format(right)
            : index === 3 ? "> " + format(left)
            : format(left) + "–" + format(right);
          return { label, count };
        });
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
  async function renderMarketTrend() {
    const requestId = ++marketTrendRequest;
    const svg = $("chart");
    const periodSelect = $("marketTrendPeriod");
    const days = Math.max(1, Math.min(90, Number(periodSelect && periodSelect.value) || 30));
    if (!marketMode || !svg) return;
    $("historyLabel").textContent = "Общая история · " + days + " дней";
    $("chartNote").textContent = "Загрузка сохранённых наблюдений цены…";
    svg.innerHTML = '<text x="350" y="95" text-anchor="middle" class="chart-label">Загрузка истории рынка…</text>';
    try {
      const response = await api("/api/analytics/price-history?days=" + days);
      if (requestId !== marketTrendRequest || !marketMode) return;
      const points = (response.points || []).filter(point =>
        point.avg_price !== null && point.avg_price !== undefined && Number.isFinite(Number(point.avg_price))
      );
      if (!points.length) {
        svg.innerHTML = '<text x="350" y="83" text-anchor="middle" class="chart-label">История рынка пока не накоплена</text>' +
          '<text x="350" y="105" text-anchor="middle" class="chart-label">Нужно несколько сохранённых снимков цены.</text>';
        $("chartNote").textContent = "График появится, когда сборщик сохранит изменения цены.";
        return;
      }
      const values = points.map(point => Number(point.avg_price));
      const low = Math.min(...values), high = Math.max(...values);
      const span = high - low || Math.max(1, Math.abs(high) * .04);
      const width = 700, height = 190, pad = 25;
      const coords = points.map((point, index) => ({
        x: pad + index * (width - pad * 2) / Math.max(1, points.length - 1),
        y: height - pad - (Number(point.avg_price) - low) / span * (height - pad * 2),
        date: point.day,
        value: Number(point.avg_price),
        snapshots: point.snapshots
      }));
      const line = coords.map(point => point.x.toFixed(2) + "," + point.y.toFixed(2)).join(" ");
      const area = pad + "," + (height - pad) + " " + line + " " + (width - pad) + "," + (height - pad);
      const grid = [0,.25,.5,.75,1].map(t =>
        '<line x1="' + pad + '" y1="' + (pad + t * (height - pad * 2)) +
        '" x2="' + (width - pad) + '" y2="' + (pad + t * (height - pad * 2)) +
        '" stroke="var(--line)" stroke-dasharray="4 5"/>'
      ).join("");
      const short = n => Math.abs(n) >= 1000000
        ? (n / 1000000).toLocaleString("ru-RU",{maximumFractionDigits:1}) + "м"
        : Math.abs(n) >= 1000
          ? (n / 1000).toLocaleString("ru-RU",{maximumFractionDigits:1}) + "к"
          : format(n);
      const labels = '<g class="chart-label"><text x="1" y="' + (pad + 3) + '">' + esc(short(high)) +
        '</text><text x="1" y="' + (height - pad) + '">' + esc(short(low)) +
        '</text><text x="' + pad + '" y="' + (height - 3) + '">' + esc(coords[0].date) +
        '</text><text x="' + (width - pad) + '" y="' + (height - 3) + '" text-anchor="end">' +
        esc(coords[coords.length - 1].date) + "</text></g>";
      const dots = coords.map(point =>
        '<circle cx="' + point.x + '" cy="' + point.y + '" r="3.2" fill="var(--gold)" stroke="var(--panel)" stroke-width="1.5">' +
        "<title>" + esc(point.date) + " · " + esc(format(point.value)) + " монет · " +
        esc(point.snapshots) + " снимков</title></circle>"
      ).join("");
      svg.innerHTML = '<defs><linearGradient id="marketTrendFill" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="var(--gold)" stop-opacity=".24"/>' +
        '<stop offset="100%" stop-color="var(--gold)" stop-opacity="0"/></linearGradient></defs>' +
        grid + labels + '<polygon points="' + area + '" fill="url(#marketTrendFill)"/>' +
        '<polyline points="' + line + '" fill="none" stroke="var(--gold)" stroke-width="2.8" ' +
        'stroke-linejoin="round" stroke-linecap="round"/>' + dots;
      $("chartNote").textContent = coords.length + " дней с наблюдениями · среднее по сохранённым снимкам изменений, не полный дневной снимок рынка и не завершённые сделки.";
    } catch (error) {
      if (requestId === marketTrendRequest && marketMode) {
        svg.innerHTML = '<text x="350" y="95" text-anchor="middle" class="chart-label">Не удалось загрузить историю рынка</text>';
        $("chartNote").textContent = error.message;
      }
    }
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
      if (marketMode) renderMarketTrend();
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
  window.HuevoObsidianAnalytics = { refresh, get marketMode() { return marketMode; } };
  document.addEventListener("DOMContentLoaded", refresh);
  const trendButton = $("marketTrendButton");
  if (trendButton) trendButton.addEventListener("click", () => {
    marketMode = true;
    selectedTrendLot = "";
    try { selectedId = null; } catch (_) {}
    renderMarketTrend();
  });
  const trendPeriod = $("marketTrendPeriod");
  if (trendPeriod) trendPeriod.addEventListener("change", () => {
    if (marketMode) renderMarketTrend();
  });
  document.addEventListener("click", event => {
    const button = event.target && event.target.closest ? event.target.closest("[data-history]") : null;
    if (button) {
      selectedTrendLot = String(button.getAttribute("data-history") || "");
      marketMode = false;
    }
  });
  const refreshButton = document.getElementById("refresh");
  if (refreshButton) refreshButton.addEventListener("click", () => setTimeout(refresh, 1200));
  window.addEventListener("focus", refresh);
  window.setInterval(refresh, 30000);
})();