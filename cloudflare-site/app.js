"use strict";
(function () {
  const $ = id => document.getElementById(id);
  const fmt = value => value == null || !Number.isFinite(Number(value)) ? "—" : Number(value).toLocaleString("ru-RU", { maximumFractionDigits: 1 });
  const esc = value => String(value == null ? "" : value).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
  const timestamp = value => value ? new Date(value).toLocaleString("ru-RU", { dateStyle:"medium", timeStyle:"short", timeZone:"UTC" }) + " UTC" : "—";
  let data = null;

  async function start() {
    try {
      const response = await fetch("./data.json", { cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      data = await response.json();
      paint(data);
    } catch (error) {
      $("stateText").textContent = "Не удалось загрузить data.json";
      $("stateDot").className = "dot err";
      $("warning").textContent = "Статический каталог пока не опубликован. Запусти workflow Cloudflare в GitHub Actions после добавления необходимых секретов. Подробность: " + error.message;
      $("warning").classList.remove("hide");
    }
  }

  function paint(d) {
    const lots = Array.isArray(d.lots) ? d.lots : [];
    const priced = lots.filter(x => Number.isFinite(Number(x.price)) && x.price !== null);
    $("count").textContent = fmt(lots.length);
    $("avg").textContent = fmt(d.stats && d.stats.avg) + " ◉";
    $("min").textContent = fmt(d.stats && d.stats.min) + " ◉";
    $("median").textContent = fmt(d.stats && d.stats.median) + " ◉";
    $("updated").textContent = "Последний снимок: " + timestamp(d.generated_at);
    $("footStatus").textContent = "Лотов с ценой: " + fmt(priced.length) + " · страниц: " + fmt(d.collector && d.collector.pages);
    const collector = d.collector || {};
    const blocked = collector.status === "blocked" || Boolean(collector.blocked_until);
    $("stateText").textContent = blocked ? "Сбор на паузе" : collector.status === "ok" ? "Данные обновлены" : "Ожидает первого сбора";
    $("stateDot").className = "dot " + (blocked ? "err" : collector.status === "ok" ? "ok" : "");
    if (collector.status && collector.status !== "ok") {
      $("warning").textContent = "Последняя попытка сборщика: " + (collector.message || collector.status) + (collector.blocked_until ? " Пауза до " + timestamp(collector.blocked_until) + "." : "");
      $("warning").classList.remove("hide");
    }
    $("historyCount").textContent = (d.snapshots || []).length + " снимков";
    $("rangeNote").textContent = (d.snapshots || []).length > 1 ? "С " + timestamp(d.snapshots[0].observed_at) : "История накопится со временем";
    drawChart(d.snapshots || []);
    fillFacets(lots);
    renderDeals(d.deals || []);
    renderRows();
  }

  function drawChart(snapshots) {
    const svg = $("chart");
    const points = snapshots.filter(s => Number.isFinite(Number(s.median_price))).slice(-60);
    if (points.length < 2) {
      svg.innerHTML = '<text x="350" y="100" text-anchor="middle" fill="#a0a8c0" font-size="12">Для графика нужны минимум два снимка</text>';
      return;
    }
    const width = 700, height = 210, pad = 28;
    const values = points.map(p => Number(p.median_price));
    const min = Math.min.apply(null, values), max = Math.max.apply(null, values);
    const span = max - min || Math.max(1, max * 0.05);
    const coords = points.map((p, i) => ({
      x: pad + i * (width - 2 * pad) / (points.length - 1),
      y: height - pad - (Number(p.median_price) - min) / span * (height - 2 * pad)
    }));
    const line = coords.map(p => p.x.toFixed(1) + "," + p.y.toFixed(1)).join(" ");
    svg.innerHTML = '<line x1="' + pad + '" y1="' + (height-pad) + '" x2="' + (width-pad) + '" y2="' + (height-pad) + '" stroke="#2a3043"/>' +
      '<text x="2" y="16" fill="#a0a8c0" font-size="10">' + esc(fmt(max)) + '</text>' +
      '<text x="2" y="' + (height-10) + '" fill="#a0a8c0" font-size="10">' + esc(fmt(min)) + '</text>' +
      '<polyline points="' + line + '" fill="none" stroke="#9a82ff" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>';
  }

  function fillFacets(lots) {
    const rarity = $("rarity"), status = $("status");
    const oldR = rarity.value, oldS = status.value;
    const rarities = Array.from(new Set(lots.map(x => x.rarity).filter(Boolean))).sort();
    const statuses = Array.from(new Set(lots.map(x => x.status).filter(Boolean))).sort();
    rarity.innerHTML = '<option value="">Все редкости</option>' + rarities.map(x => '<option value="' + esc(x) + '">' + esc(x) + '</option>').join("");
    status.innerHTML = '<option value="">Все статусы</option>' + statuses.map(x => '<option value="' + esc(x) + '">' + esc(x) + '</option>').join("");
    rarity.value = rarities.includes(oldR) ? oldR : "";
    status.value = statuses.includes(oldS) ? oldS : "";
  }

  function renderDeals(deals) {
    const box = $("deals");
    if (!deals.length) {
      box.innerHTML = '<div class="empty">Пока мало сопоставимых предложений для расчёта скидки.</div>';
      return;
    }
    box.innerHTML = deals.slice(0, 5).map(d => '<div class="deal"><div class="gift-icon">🎁</div><div><div class="deal-name">' + esc(d.title || ("Лот #" + d.lot_id)) + '</div><div class="deal-meta">Медиана ' + esc(fmt(d.median)) + ' ◉ · выборка ' + esc(d.group_size) + '</div></div><div class="deal-price ' + (d.suspicious ? "bad" : "good") + '">' + esc(fmt(d.price)) + ' ◉<div class="deal-meta">−' + esc(fmt(d.discount_pct)) + '%</div></div></div>').join("");
  }

  function renderRows() {
    if (!data) return;
    const search = $("search").value.trim().toLocaleLowerCase("ru");
    const rarity = $("rarity").value, status = $("status").value, sort = $("sort").value;
    let lots = (data.lots || []).filter(l => {
      const text = [l.lot_id, l.title, l.serial, l.rarity, l.status].join(" ").toLocaleLowerCase("ru");
      return text.includes(search) && (!rarity || l.rarity === rarity) && (!status || l.status === status);
    });
    lots.sort((a, b) => {
      if (sort === "price_desc") return (Number(b.price) || 0) - (Number(a.price) || 0);
      if (sort === "name") return String(a.title || "").localeCompare(String(b.title || ""), "ru");
      if (sort === "discount") {
        const histA = a.history || [], histB = b.history || [];
        const prevA = histA.length > 1 ? Number(histA[histA.length - 2].price) : Number(a.price);
        const prevB = histB.length > 1 ? Number(histB[histB.length - 2].price) : Number(b.price);
        return (prevB - Number(b.price || 0)) - (prevA - Number(a.price || 0));
      }
      return (Number(a.price) || 0) - (Number(b.price) || 0);
    });
    $("rowCount").textContent = "Показано " + fmt(lots.length) + " лотов";
    $("rows").innerHTML = lots.length ? lots.map(l => {
      const image = l.image_url && /^https:\/\//i.test(l.image_url) ? '<img src="' + esc(l.image_url) + '" alt="" loading="lazy" referrerpolicy="no-referrer" style="height:34px;width:34px;object-fit:cover;border-radius:9px;background:#26213f" onerror="this.style.display=\'none\'">' : '<span class="gift-icon">🎁</span>';
      const url = l.lot_url && /^https:\/\/(huevo\.su|huevo\.departament\.site)\//i.test(l.lot_url) ? l.lot_url : "https://huevo.su/market/lot/" + encodeURIComponent(l.lot_id);
      return '<tr><td><div class="lot">' + image + '<div><strong>' + esc(l.title || "Без названия") + '</strong><small>#' + esc(l.lot_id) + (l.serial ? " · " + esc(l.serial) : "") + '</small></div></div></td><td class="price">' + esc(fmt(l.price)) + ' ◉</td><td><span class="status-chip">' + esc(l.rarity || "Редкость не указана") + '</span><div class="muted" style="margin-top:5px">' + esc(l.status || "Неизвестно") + '</div></td><td>' + esc(timestamp(l.last_seen)) + '</td><td><a class="btn secondary" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">Открыть ↗</a></td></tr>';
    }).join("") : '<tr><td colspan="5" class="empty">Лоты не найдены.</td></tr>';
  }

  ["search", "rarity", "status", "sort"].forEach(id => $(id).addEventListener(id === "search" ? "input" : "change", renderRows));
  start();
})();
