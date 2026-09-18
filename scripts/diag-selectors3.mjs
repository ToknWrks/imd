#!/usr/bin/env node
// diag-selectors3.mjs — resolve unknown selectors via openchain + 4byte dbs.
const sels = ["0x6a12f104", "0xff633a38"];
for (const base of [
  "https://api.openchain.xyz/signature-database/v1/lookup?function=" + sels.join(","),
  "https://www.4byte.directory/api/v1/signatures/?hex_signature=" + sels[0],
  "https://www.4byte.directory/api/v1/signatures/?hex_signature=" + sels[1],
]) {
  try {
    const r = await fetch(base, { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    console.log(new URL(base).host, "→", JSON.stringify(j).slice(0, 500));
  } catch (e) {
    console.log(new URL(base).host, "err:", e.message.slice(0, 100));
  }
}
