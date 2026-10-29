(async () => {
  'use strict';
  const allowedHosts = new Set(['huevo.su', 'www.huevo.su', 'huevo.departament.site', 'www.huevo.departament.site']);
  if (!allowedHosts.has(location.hostname.toLowerCase())) {
    alert('Откройте маркет Huevo в уже авторизованной вкладке.');
    return;
  }

  // Keep the destination fixed to this project's Render service so the token
  // cannot be redirected to an arbitrary host through a prompt.
  const dashboard = 'https://huevo-gift-analytics.onrender.com';
  const token = (prompt('Введите INGEST_TOKEN из Environment вашего сервиса Render:') || '').trim();
  if (!token) { alert('Токен не указан; сбор отменён.'); return; }

  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const readText = (root, selector) => root.querySelector(selector)?.textContent?.trim() || '';
  const parseCards = html => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return [...doc.querySelectorAll('a[href*="/market/lot/"]')].map(card => {
      const href = card.getAttribute('href') || '';
      const match = href.match(/\/market\/lot\/(\d+)/);
      if (!match) return null;
      const selectors = ['.mk-price', '.mk-gprice', '[class*="price"]', '[data-price]'];
      const priceNode = card.querySelector(selectors.join(','));
      const priceText = selectors.map(s => readText(card, s)).find(Boolean) ||
        priceNode?.getAttribute('data-price') || priceNode?.getAttribute('content') || '';
      const digits = priceText.replace(/[^0-9]/g, '');
      const image = card.querySelector('img');
      const hrefUrl = new URL(href, location.origin);
      return {
        lot_id: match[1],
        title: readText(card, '.mk-gtitle') || readText(card, '[class*="title"]') || image?.alt || '',
        serial: readText(card, '.mk-gserial') || readText(card, '[class*="serial"]'),
        rarity: readText(card, '.mk-gsub') || readText(card, '[class*="rarity"]'),
        price: digits ? Number(digits) : null,
        status: readText(card, '.mk-status') || readText(card, '[class*="status"]') || 'Неизвестно',
        image_url: image?.getAttribute('src') ? new URL(image.getAttribute('src'), location.origin).href : '',
        lot_url: hrefUrl.href
      };
    }).filter(Boolean);
  };
  const sendLots = async lots => {
    const response = await fetch(dashboard + '/api/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ lots })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.detail || ('Ошибка импорта: HTTP ' + response.status));
    return Number(result.saved || 0);
  };

  const status = document.createElement('div');
  status.style.cssText = 'position:fixed;z-index:2147483647;right:16px;top:16px;background:#171a1f;color:#fff;border:2px solid #55d98b;padding:14px 18px;border-radius:10px;font:14px/1.5 system-ui;max-width:360px;box-shadow:0 4px 24px #0008';
  document.body.appendChild(status);
  const seen = new Set();
  let total = 0;
  let reachedEnd = false;
  try {
    for (let page = 1; page <= 500; page++) {
      status.textContent = 'Huevo Gift Analytics: читаю страницу ' + page + '; импортировано ' + total;
      const url = new URL('/market/gifts', location.origin);
      url.searchParams.set('page', String(page));
      const response = await fetch(url.href, { credentials: 'same-origin', cache: 'no-store' });
      if ([403, 418, 429].includes(response.status)) {
        throw new Error('Huevo вернул HTTP ' + response.status + '; сбор остановлен без повторных запросов.');
      }
      if (!response.ok) throw new Error('Страница ' + page + ': HTTP ' + response.status);
      const cards = parseCards(await response.text());
      const fresh = cards.filter(lot => !seen.has(lot.lot_id) && seen.add(lot.lot_id));
      if (!fresh.length) { reachedEnd = true; break; }
      total += await sendLots(fresh);
      await delay(2200);
    }
    if (total > 0) {
      const response = await fetch(dashboard + '/api/ingest/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ reached_end: reachedEnd })
      });
      if (!response.ok) throw new Error('Не удалось завершить импорт: HTTP ' + response.status);
    }
    status.textContent = total ? 'Готово: импортировано ' + total + ' записей. Обновите панель аналитики.' : 'Карточки не найдены; данные не импортированы.';
    status.style.borderColor = total ? '#55d98b' : '#ff6969';
  } catch (error) {
    status.textContent = 'Сбор остановлен: ' + error.message;
    status.style.borderColor = '#ff6969';
  }
})();