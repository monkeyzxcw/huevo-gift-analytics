function constantTimeHexEqual(left, right) {
  const a = String(left || "").toLowerCase();
  const b = String(right || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) return false;
  let difference = a.length ^ b.length;
  for (let index = 0; index < 64; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}
function bytesToHex(value) {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
/** Verify all signed hu_* values, including fields added by huEVO later. */
export async function verifyHuevoLaunch(query, clientSecret, maxAgeSeconds = 86400) {
  if (!clientSecret || typeof query !== "string" || query.length > 8192) return null;
  const params = Object.create(null);
  const search = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
  for (const [key, value] of search.entries()) {
    if (!key.startsWith("hu_")) continue;
    if (Object.prototype.hasOwnProperty.call(params, key)) return null;
    params[key] = value;
  }
  const givenHash = params.hu_hash || "";
  const signed = Object.keys(params).filter((key) => key !== "hu_hash").sort()
    .map((key) => key + "=" + params[key]).join("\n");
  const encoder = new TextEncoder();
  const secretKey = await crypto.subtle.digest("SHA-256", encoder.encode(clientSecret));
  const hmacKey = await crypto.subtle.importKey("raw", secretKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expectedHash = bytesToHex(await crypto.subtle.sign("HMAC", hmacKey, encoder.encode(signed)));
  if (!constantTimeHexEqual(expectedHash, givenHash)) return null;
  const timestampText = params.hu_ts || "";
  if (!/^\d{1,12}$/.test(timestampText)) return null;
  const timestamp = Number(timestampText);
  const age = Math.floor(Date.now() / 1000) - timestamp;
  if (!Number.isSafeInteger(timestamp) || age < 0 || age > maxAgeSeconds) return null;
  return params;
}
