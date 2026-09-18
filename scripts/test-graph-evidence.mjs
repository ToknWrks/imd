import { readFileSync } from "fs";

// Load .env the same way the app does (Settings tab writes it; scripts read it raw).
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^[\"']|[\"']$/g, "");
}

import { collectGraphTradeEvidence } from "../zooch-graph.mjs";

const IMD = "0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7";
const ev = await collectGraphTradeEvidence(IMD, { windowHours: 72 });
const clean = { ...ev };
delete clean._sells;
delete clean._buys;
if (clean.venues) clean.venues = clean.venues.map((v) => ({ ...v }));
console.log(JSON.stringify(clean, null, 2));
