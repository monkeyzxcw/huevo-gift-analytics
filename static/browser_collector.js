(async () => {
  'use strict';
  if (location.hostname !== 'huevo.su') {
    alert('Сначала откройте https://huevo.su/market/gifts в авторизованном браузере.');
    return;
  }
  const dashboard = (prompt('Вставьте URL вашего Huevo Gift Analytics на Render (например, https://huevo-gift-analytics.onrender.com):', '') || '').trim().replace(/\/$/, '');
  if (!/^https:\/\//i.test(dashboard)) { alert('Нужен полный HTTPS URL приложения Render.'); return; }
  const token = (prompt('Введите INGEST_TOKEN, который вы задали в Environment на Render:', '') || '').trim();
  if (!token) { alert('Токен не указан.'); return; }
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const text = (root, selector) => root.querySelector(selector)?.textContent?.trim() || '';
  const parse = html => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return [...doc.querySelectorAll('a[href*="/market/lot/"]')].map(card => {
      const href = card.getAttribute('href') || '';
      const match = href.match(/\/market\/lot\/(\d+)/);
      if (!match) return null;
      const pick = (...selectors) => {
        for (const selector of selectors) {
          const value = text(card, selector);
          if (value) return value;
        }
        return '';
      };
      const priceText = pick('.mk-price', '.mk-gprice', '[class*="price"]', '[data-price]');
      const digits = priceText.replace(/[^0-9]/g, '');
      const img = card.querySelector('img');
      const title = pick('.mk-gtitle', '[class*="title"]', '[class*="name"]', 'h2', 'h3');
      const serial = pick('.mk-gserial', '[class*="serial"]', '[class*="number"]');
      const rarity = pick('.mk-gsub', '[class*="rarity"]', '[class*="collection"]');
      return {
        lot_id: match[1], title, serial, rarity, price: digits ? Number(digits) : null,
        status: pick('.mk-status', '[class*="status"]') || 'Неизвестно',
        image_url: img?.getAttribute('src') ? new URL(img.getAttribute('src'), location.origin).href : '',
        lot_url: new URL(href, location.origin).href
      };
    }).filter(Boolean);
  };
  const send = async lots => {
    const response = await fetch(`${dashboard}/api/ingest?token=${encodeURIComponent(token)}`, {
      method: 'POST', mode: 'cors', headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ lots })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.detail || `Ошибка передачи: HTTP ${response.status}`);
    return result.saved || 0;
  };
  let total = 0, page = 1, empty = 0;
  const seen = new Set();
  const status = document.createElement('div');
  status.style.cssText = 'position:fixed;z-index:2147483647;right:16px;top:16px;background:#171a1f;color:#fff;border:2px solid #55d98b;padding:14px 18px;border-radius:10px;font:14px/1.5 system-ui;max-width:360px;box-shadow:0 4px 24px #0008';
  status.textContent = 'Huevo Gift Analytics: сбор запускается…'; document.body.appendChild(status);
  try {
    while (page <= 500) {
      status.textContent = `Huevo Gift Analytics: страница ${page}; сохранено записей ${total}`;
      const url = new URL('/market/gifts', location.origin); url.searchParams.set('page', String(page));
      const response = await fetch(url.href, { credentials: 'same-origin', cache: 'no-store' });
      if (response.status === 418 || response.status === 429 || response.status === 403) {
        throw new Error(`Huevo вернул HTTP ${response.status} на странице ${page}. Сбор остановлен, чтобы не повторять запросы.`);
      }
      if (!response.ok) throw new Error(`Страница ${page}: HTTP ${response.status}`);
      const lots = parse(await response.text());
      const fresh = lots.filter(lot => !seen.has(lot.lot_id) && seen.add(lot.lot_id));
      if (!fresh.length) empty++; else empty = 0;
      if (fresh.length) total += await send(fresh);
      if (lots.length === 0 || empty >= 2) break;
      page++;
      await delay(2200);
    }
    status.textContent = `Готово. Передано ${total} записей с ${Math.max(0, page - 1)} страниц. Обновите вкладку аналитики.`;
    status.style.borderColor = '#55d98b';
  } catch (error) {
    status.textContent = `Сбор остановлен: ${error.message}`;
    status.style.borderColor = '#ff6969';
  }
})();
