import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const read = path => readFile(resolve(root, path), "utf8");

test("community chat is a global top-level workspace for both market modes", async () => {
  const html = await read("cloudflare-site/index.html");
  assert.match(html, /id="communityOpen"/);
  assert.match(html, /id="communityWorkspace"/);
  assert.match(html, /id="communityMessages"/);
  assert.match(html, /id="communityComposer"/);
  assert.match(html, /id="usernameWorkspace"/);
  assert.match(html, /id="giftsWorkspace"/);
});

test("community chat API requires the huEVO session and protects message content", async () => {
  const auth = await read("src/auth.js");
  const worker = await read("src/worker.js");
  assert.match(worker, /GET" && path === "\/api\/community\/messages"/);
  assert.match(worker, /POST" && path === "\/api\/community\/messages"/);
  assert.match(auth, /authenticatedUser\(request, env\)/);
  assert.match(auth, /sameOriginMutation\(request\)/);
  assert.match(auth, /checkRateLimit\(env, "community:" \+ user\.user_id, 10, 60 \* 1000\)/);
  assert.match(auth, /length > 500/);
  assert.match(auth, /INSERT INTO community_messages/);
});

test("community chat schema ties every message to a huEVO account and indexes the feed", async () => {
  const migration = await read("migrations/0006_community_chat.sql");
  assert.match(migration, /user_id TEXT NOT NULL REFERENCES user_accounts\(user_id\) ON DELETE CASCADE/);
  assert.match(migration, /message TEXT NOT NULL CHECK \(length\(message\) BETWEEN 1 AND 500\)/);
  assert.match(migration, /idx_community_messages_created/);
});

test("chat frontend uses textContent, polls incrementally, and does not use push notifications", async () => {
  const chat = await read("cloudflare-site/community-chat.js");
  const html = await read("cloudflare-site/index.html");
  assert.match(chat, /text\.textContent = item\.message/);
  assert.match(chat, /\?after=" \+ lastId/);
  assert.match(chat, /setInterval\(\(\) => loadMessages\(false\), 3000\)/);
  assert.match(chat, /credentials: "same-origin"/);
  assert.doesNotMatch(chat, /serviceWorker|Notification\.requestPermission|new Notification/);
  assert.match(html, /community-chat\.js/);
});
