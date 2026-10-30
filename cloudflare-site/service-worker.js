"use strict";

self.addEventListener("install", event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", event => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    payload = { body: event.data ? event.data.text() : "" };
  }
  const title = String(payload.title || "AMNYAM · новое уведомление").slice(0, 120);
  const body = String(payload.body || "Проверь избранные лоты и целевые цены.").slice(0, 300);
  const options = {
    body,
    tag: String(payload.tag || "amnyam-push"),
    renotify: false,
    requireInteraction: false,
    timestamp: Number.isFinite(Date.parse(payload.sent_at || "")) ? Date.parse(payload.sent_at) : Date.now(),
    data: {
      url: typeof payload.url === "string" ? payload.url : "/",
      lot_id: String(payload.lot_id || "")
    }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const raw = event.notification.data && event.notification.data.url || "/";
  let target;
  try {
    target = new URL(raw, self.location.origin);
    const allowed = target.origin === self.location.origin ||
      target.hostname === "huevo.su" || target.hostname.endsWith(".huevo.su") ||
      target.hostname === "huevo.departament.site" || target.hostname.endsWith(".huevo.departament.site");
    if (!allowed || target.protocol !== "https:" && target.origin !== self.location.origin) {
      target = new URL("/", self.location.origin);
    }
  } catch (_) {
    target = new URL("/", self.location.origin);
  }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (client.url.startsWith(self.location.origin)) {
        if (client.navigate) await client.navigate(target.href).catch(() => undefined);
        await client.focus();
        return;
      }
    }
    await self.clients.openWindow(target.href);
  })());
});
