// Collect distinct topic0s from the Aerodrome V2 pool and identify each via 4byte.
const { readFileSync } = await import("fs");
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const { createPublicClient, http } = await import("viem");
const { base } = await import("viem/chains");
const c = createPublicClient({ chain: base, transport: http(`https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`) });

const head = await c.getBlockNumber();
const topics = new Map();
for (let i = 1; i <= 5; i++) {
  const logs = await c.getLogs({ address: "0x0F5A4039d809D93413fe9a67c465dd4336B9C63e", fromBlock: head - 9n * BigInt(i), toBlock: head - 9n * BigInt(i - 1) });
  for (const l of logs) {
    const t = l.topics[0];
    const n = topics.get(t) ?? { count: 0, dataBytes: (l.data.length - 2) / 2, nTopics: l.topics.length };
    n.count++;
    topics.set(t, n);
  }
}
for (const [t, n] of topics) {
  const r = await fetch(`https://www.4byte.directory/api/v1/event-signatures/?hex_signature=${t.slice(0, 10)}`).then((r) => r.json()).catch(() => null);
  const names = (r?.results ?? []).map((x) => x.text_signature).join(" | ") || "?";
  console.log(`${t.slice(0, 12)} ×${n.count} data=${n.dataBytes}B topics=${n.nTopics} → ${names}`);
}
