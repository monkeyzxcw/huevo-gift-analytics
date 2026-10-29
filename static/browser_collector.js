/* Huevo browser collector.
 * Run in DevTools Console on an ALREADY AUTHORIZED huevo.su tab. It reads the market pages with
 * your own session (cookies never leave the browser), sends parsed lots to your dashboard with
 * the INGEST_TOKEN, and stops on 403/418/429/5xx or a login page. It does not bypass protection:
 * no proxies, no IP/header tricks, no retries after a refusal. Honors Retry-After.
 *
 * Optional settings (before pasting): window.HUEVO_COLLECTOR = { dashboard: "http://localhost:8000", delayMs: 2500, maxPages: 300 }
 */
(async () => {
  'use strict';
  const opts = Object.assign({}, window.HUEVO_COLLECTOR || {});
  const log = (...a) => console.log('%c[huevo-collector]', 'color:#8b5cf6', ...a);
  const warn = (...a) => console.warn('[huevo-collector]', ...a);

  // ---- where may the token be sent?
  const DEFAULT_DASHBOARD = 'http://localhost:8000';
  const dashboardOk = (u) => {
    try {
      const x = new URL(u);
      const local = x.protocol === 'http:' && (x.hostname === 'localhost' || x.hostname === '127.0.0.1');
      return local && !x.username && !x.password && x.pathname === '/' ? x.origin : '';
    } catch (_) { return ''; }
  };
  const dashboard = dashboardOk(opts.dashboard || DEFAULT_DASHBOARD);
  if (!dashboard) { alert('Адрес панели не разрешён. Допустимы HTTPS API-сервер, который вы контролируете, и http://localhost. Токен никуда не отправлен.'); return; }

  const HOSTS = new Set(['huevo.su', 'www.huevo.su', 'huevo.departament.site', 'www.huevo.departament.site']);
  if (!HOSTS.has(location.hostname.toLowerCase())) { alert('Откройте маркет Huevo в уже авторизованной вкладке и запустите сборщик там.'); return; }

  const token = (prompt('Введите INGEST_TOKEN вашего собственного FastAPI API-сервера (он не сохраняется):') || '').trim();
  if (!token) { alert('Токен не указан; сбор отменён.'); return; }

  const delayMs = Math.max(opts.allowFast ? 0 : 1500, Number.isFinite(Number(opts.delayMs)) && opts.delayMs !== undefined ? Number(opts.delayMs) : 2500);
  const maxPages = Math.max(1, Math.min(Number(opts.maxPages) || 500, 1000));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- parsing (mirrors lot_parser.py)
  const parsePrice = (text) => {
    if (!text) return null;
    const m = String(text).match(/\d[\d\s   .,]*/);
    if (!m) return null;
    const raw = m[0].replace(/[\s   ]/g, '').replace(/[.,]+$/, '');
    if (!raw) return null;
    const dec = raw.match(/^(\d+)[.,](\d{1,2})$/);
    if (dec) return Number(dec[1] + '.' + dec[2]);
    const digits = raw.replace(/[.,]/g, '');
    return digits ? Number(digits) : null;
  };
  const textOf = (card, selectors) => {
    for (const s of selectors) {
      const el = card.querySelector(s);
      if (!el) continue;
      let v = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!v) for (const a of ['data-price', 'data-title', 'content', 'value', 'aria-label']) { v = (el.getAttribute(a) || '').trim(); if (v) break; }
      if (v) return v;
    }
    return '';
  };
  const httpsUrl = (u) => { try { const x = new URL(u, location.origin); return x.protocol === 'https:' && !x.username && !x.password ? x.href : ''; } catch (_) { return ''; } };
  const parseCards = (html) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    let cards = [...doc.querySelectorAll("a.mk-gcard[href*='/market/lot/']")];
    if (!cards.length) cards = [...doc.querySelectorAll("a[href*='/market/lot/']")];
    const seen = new Set(), rows = [];
    for (const card of cards) {
      const m = (card.getAttribute('href') || '').match(/\/market\/lot\/(\d+)/);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      const img = card.querySelector('img');
      let src = '';
      if (img) for (const a of ['src', 'data-src', 'data-original', 'data-lazy-src']) { src = (img.getAttribute(a) || '').trim(); if (src && !src.startsWith('data:')) break; }
      if (src.startsWith('data:')) src = '';
      rows.push({
        lot_id: m[1],
        title: (textOf(card, ['.mk-gtitle', "[class*='title']", "[class*='name']", 'h2', 'h3']) || (img && img.getAttribute('alt')) || card.getAttribute('aria-label') || 'Без названия').slice(0, 500),
        serial: textOf(card, ['.mk-gserial', "[class*='serial']", "[class*='number']"]).slice(0, 200),
        rarity: textOf(card, ['.mk-gsub', "[class*='rarity']", "[class*='collection']"]).slice(0, 100),
        price: parsePrice(textOf(card, ['.mk-price', '.mk-gprice', "[class*='price']", '[data-price]'])),
        status: (textOf(card, ['.mk-status', "[class*='status']"]) || 'Неизвестно').slice(0, 100),
        image_url: src ? httpsUrl(src) : '',
        lot_url: location.origin + '/market/lot/' + m[1],
      });
    }
    return { rows, links: cards.length, doc };
  };
  const looksLikeLogin = (doc, url) => /\/(login|signin|auth)(\/|$)/i.test(new URL(url).pathname) || !!doc.querySelector("input[type='password']");

  // ---- network
  const stats = { pages: 0, cards: 0, unique: 0, sent: 0, rejected: 0, newLots: 0, errors: [], stop: '' };
  const seenIds = new Set();
  const post = async (path, body) => {
    const r = await fetch(dashboard + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
    let data = {}; try { data = await r.json(); } catch (_) {}
    if (!r.ok) { const e = new Error(data.detail || ('HTTP ' + r.status)); e.status = r.status; throw e; }
    return data;
  };

  let reachedEnd = false, aborted = false, previous = [];
  try {
    for (let page = 1; page <= maxPages; page++) {
      const url = `${location.origin}/market/gifts?page=${page}`;
      let resp;
      try { resp = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'text/html' } }); }
      catch (e) { stats.stop = 'сеть: ' + (e && e.message || e); aborted = true; break; }
      if ([403, 418, 429].includes(resp.status)) {
        const ra = resp.headers.get('Retry-After');
        stats.stop = `Huevo ограничил доступ (HTTP ${resp.status}${ra ? ', Retry-After ' + ra : ''}). Сбор остановлен без повторов.`;
        aborted = true; break;
      }
      if (resp.status >= 500) { stats.stop = `Ошибка сервера Huevo (HTTP ${resp.status}); повторите позже.`; aborted = true; break; }
      if (!resp.ok) { stats.stop = `Неожиданный ответ HTTP ${resp.status}.`; aborted = true; break; }
      const html = await resp.text();
      const { rows, links, doc } = parseCards(html);
      stats.pages = page; stats.cards += links;
      if (looksLikeLogin(doc, resp.url || url) && !rows.length) { stats.stop = 'Открылась страница входа: войдите в аккаунт в этой вкладке.'; aborted = true; break; }
      if (!rows.length) {
        if (page === 1) { stats.stop = 'На первой странице нет карточек: изменилась разметка или каталог пуст. Данные не отправлены.'; aborted = true; }
        else reachedEnd = true;
        break;
      }
      const ids = rows.map((r) => r.lot_id);
      if (page > 1 && ids.every((id) => previous.includes(id))) { reachedEnd = true; stats.stop = 'Страница не принесла новых лотов: конец каталога.'; break; }
      previous = ids;
      ids.forEach((id) => seenIds.add(id));
      for (let i = 0; i < rows.length; i += 200) {
        try {
          const r = await post('/api/ingest', { lots: rows.slice(i, i + 200) });
          stats.sent += r.saved; stats.rejected += r.rejected || 0; stats.newLots += r.new || 0;
        } catch (e) { stats.errors.push(e.message); stats.stop = 'Панель отклонила данные: ' + e.message; aborted = true; break; }
      }
      if (aborted) break;
      log(`страница ${page}: ${rows.length} лотов (всего уникальных ${seenIds.size})`);
      await sleep(delayMs);
    }
    if (!aborted && !reachedEnd && !stats.stop) stats.stop = `Достигнут лимит ${maxPages} страниц: конец каталога не подтверждён.`;
  } catch (e) {
    aborted = true; stats.stop = 'Сбой сборщика: ' + (e && e.message || e);
  } finally {
    stats.unique = seenIds.size;
    let complete = null;
    try { complete = await post('/api/ingest/complete', { reached_end: reachedEnd && !aborted, pages: stats.pages, unique: stats.unique }); }
    catch (e) { stats.errors.push('complete: ' + e.message); }
    const summary = { ...stats, reachedEnd: reachedEnd && !aborted, serverComplete: complete && complete.complete, deactivated: complete && complete.deactivated, warning: complete && complete.warning };
    window.HUEVO_COLLECTOR_RESULT = summary;
    (aborted || !summary.reachedEnd ? warn : log)('итог', summary);
    if (aborted) alert('Сбор остановлен: ' + stats.stop);
  }
})();
