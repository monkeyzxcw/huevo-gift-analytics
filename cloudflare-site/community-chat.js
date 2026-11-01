"use strict";
(function () {
  const $ = (id) => document.getElementById(id);
  const button = $("communityOpen");
  const workspace = $("communityWorkspace");
  const marketNav = $("marketTypeNav");
  const gifts = $("giftsWorkspace");
  const usernames = $("usernameWorkspace");
  if (!button || !workspace || !marketNav || !gifts || !usernames) return;

  const messages = $("communityMessages");
  const input = $("communityInput");
  const send = $("communitySend");
  const form = $("communityComposer");
  const connection = $("communityConnection");
  const guest = $("communityGuest");
  const unread = $("communityUnread");
  let active = false;
  let polling = false;
  let sending = false;
  let lastId = 0;
  let unreadCount = 0;
  let pollHandle = null;

  function status(value, error) {
    connection.textContent = value;
    connection.dataset.tone = error ? "error" : "normal";
  }
  function escapeAvatar(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" && (parsed.hostname === "huevo.su" || parsed.hostname.endsWith(".huevo.su") ||
        parsed.hostname === "huevo.departament.site" || parsed.hostname.endsWith(".huevo.departament.site")) ? parsed.href : "";
    } catch (_) { return ""; }
  }
  function appendMessage(item) {
    if (!item || !Number.isSafeInteger(Number(item.id)) || Number(item.id) <= lastId) return;
    const row = document.createElement("article");
    row.className = "community-message" + (item.mine ? " mine" : "");
    const avatar = document.createElement("span");
    avatar.className = "community-avatar";
    const avatarUrl = escapeAvatar(item.avatar_url);
    if (avatarUrl) {
      const image = document.createElement("img");
      image.src = avatarUrl;
      image.alt = "";
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
      image.onerror = () => { image.remove(); avatar.textContent = (item.display_name || "U").slice(0, 1).toUpperCase(); };
      avatar.append(image);
    } else avatar.textContent = (item.display_name || "U").slice(0, 1).toUpperCase();

    const bubble = document.createElement("div");
    bubble.className = "community-bubble";
    const meta = document.createElement("div");
    meta.className = "community-message-meta";
    const name = document.createElement("b");
    name.textContent = item.display_name || item.username || "Пользователь huEVO";
    const time = document.createElement("small");
    const date = new Date(item.created_at);
    time.textContent = Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    meta.append(name, time);
    const text = document.createElement("div");
    text.className = "community-message-text";
    text.textContent = item.message || "";
    bubble.append(meta, text);
    row.append(avatar, bubble);
    const shouldStick = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 90;
    const empty = messages.querySelector(".community-empty");
    if (empty) empty.remove();
    messages.append(row);
    lastId = Number(item.id);
    if (shouldStick || item.mine) messages.scrollTop = messages.scrollHeight;
    if (!active && !item.mine) {
      unreadCount += 1;
      unread.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
      unread.hidden = false;
    }
  }
  function showGuest() {
    guest.classList.remove("hide");
    input.disabled = true;
    send.disabled = true;
  }
  function hideGuest() {
    guest.classList.add("hide");
    input.disabled = false;
    send.disabled = false;
  }
  async function request(url, options) {
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Accept": "application/json", ...(options && options.headers || {}) },
      ...(options || {})
    });
    let data;
    try { data = await response.json(); } catch (_) { throw new Error("Сервер вернул некорректный ответ."); }
    if (!response.ok) {
      const error = new Error(data.error || "Ошибка чата (HTTP " + response.status + ").");
      error.status = response.status;
      throw error;
    }
    return data;
  }
  function updateUnread() {
    unread.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
    unread.hidden = unreadCount === 0 || active;
  }
  async function loadMessages(initial) {
    if (polling || !active) return;
    polling = true;
    try {
      const data = await request("./api/community/messages" + (initial ? "" : "?after=" + lastId));
      hideGuest();
      const items = Array.isArray(data.messages) ? data.messages : [];
      if (initial) {
        messages.replaceChildren();
        lastId = 0;
        if (!items.length) {
          const empty = document.createElement("div");
          empty.className = "community-empty";
          empty.textContent = "Пока сообщений нет. Начни разговор первым!";
          messages.append(empty);
        } else items.forEach(appendMessage);
        messages.scrollTop = messages.scrollHeight;
        unreadCount = 0;
        updateUnread();
      } else items.forEach(appendMessage);
      status("На связи · обновление каждые 3 секунды");
    } catch (error) {
      if (error.status === 401) {
        showGuest();
        status("Требуется вход через huEVO", true);
      } else status(error.message || "Не удалось обновить чат", true);
    } finally { polling = false; }
  }
  async function pollUnread() {
    if (active || polling) return;
    polling = true;
    try {
      const data = await request("./api/community/messages" + (lastId ? "?after=" + lastId : ""));
      const items = Array.isArray(data.messages) ? data.messages : [];
      for (const item of items) {
        const id = Number(item.id);
        if (!Number.isSafeInteger(id) || id <= lastId) continue;
        lastId = id;
        if (!item.mine) unreadCount += 1;
      }
      updateUnread();
    } catch (_) {
      // The chat remains usable; retry on the next background poll.
    } finally { polling = false; }
  }
  async function establishUnreadBaseline() {
    try {
      const data = await request("./api/community/messages");
      const items = Array.isArray(data.messages) ? data.messages : [];
      if (items.length) lastId = Math.max(...items.map(item => Number(item.id) || 0));
    } catch (_) {
      // Guests will see the normal sign-in prompt when they open the chat.
    }
    pollHandle = setInterval(() => active ? loadMessages(false) : pollUnread(), 3000);
  }
  function openChat() {
    active = true;
    button.setAttribute("aria-expanded", "true");
    button.classList.add("is-active");
    marketNav.classList.add("hide");
    gifts.classList.add("hide");
    usernames.classList.add("hide");
    workspace.classList.remove("hide");
    unreadCount = 0;
    updateUnread();
    loadMessages(true);
  }
  function closeChat() {
    active = false;
    button.setAttribute("aria-expanded", "false");
    button.classList.remove("is-active");
    workspace.classList.add("hide");
    marketNav.classList.remove("hide");
    const usernameMode = document.body.dataset.marketWorkspace === "usernames";
    gifts.classList.toggle("hide", usernameMode);
    usernames.classList.toggle("hide", !usernameMode);
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = null;
  }
  button.addEventListener("click", () => active ? closeChat() : openChat());
  $("communityRefresh").addEventListener("click", () => loadMessages(!lastId));
  $("communityLogin").addEventListener("click", () => {
    const account = $("accountDialog");
    if (account && typeof account.showModal === "function") account.showModal();
    else $("accountButton").click();
  });
  input.addEventListener("input", () => {
    $("communityCharCount").textContent = String([...input.value].length);
    send.disabled = sending || !input.value.trim() || [...input.value].length > 500;
  });
  input.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message || sending || [...message].length > 500) return;
    sending = true;
    send.disabled = true;
    status("Отправляем сообщение…");
    try {
      const data = await request("./api/community/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message })
      });
      if (data.message) appendMessage(data.message);
      input.value = "";
      $("communityCharCount").textContent = "0";
      status("Сообщение отправлено");
      input.focus();
    } catch (error) {
      if (error.status === 401) showGuest();
      status(error.message || "Не удалось отправить сообщение", true);
    } finally {
      sending = false;
      send.disabled = !input.value.trim();
    }
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && active && !event.target.closest("dialog")) closeChat();
  });
})();
