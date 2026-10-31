import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const app = await readFile(resolve(root, "cloudflare-site/app.js"), "utf8");

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, "expected function boundaries must exist");
  return source.slice(from, to);
}

test("Live and full-snapshot polling have independent backoff state", () => {
  assert.match(app, /let snapshotPollFailureCount = 0/);
  assert.match(app, /let snapshotPollBackoffUntil = 0/);
  assert.match(app, /let livePollFailureCount = 0/);
  assert.match(app, /let livePollBackoffUntil = 0/);
  assert.doesNotMatch(app, /\bpollFailureCount\b|\bpollBackoffUntil\b/, "legacy shared backoff state must not return");

  const snapshot = section(app, "async function pollFullSnapshot() {", "let fastLivePollRunning = false;");
  const live = section(app, "async function pollLive() {", "\n  function ");
  assert.match(snapshot, /snapshotPollBackoffUntil/);
  assert.match(snapshot, /snapshotPollFailureCount/);
  assert.doesNotMatch(snapshot, /livePollBackoffUntil|livePollFailureCount/);
  assert.match(live, /livePollBackoffUntil/);
  assert.match(live, /livePollFailureCount/);
  assert.doesNotMatch(live, /snapshotPollBackoffUntil|snapshotPollFailureCount/);
});

test("returning to a visible tab resets both polling lanes independently", () => {
  const visibility = section(app, 'document.addEventListener("visibilitychange"', "\n  });");
  assert.match(visibility, /snapshotPollBackoffUntil = 0/);
  assert.match(visibility, /snapshotPollFailureCount = 0/);
  assert.match(visibility, /livePollBackoffUntil = 0/);
  assert.match(visibility, /livePollFailureCount = 0/);
});
