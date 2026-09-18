import { readFileSync } from "fs";

const envText = readFileSync(new URL("../.env", import.meta.url), "utf8");
for (const line of envText.split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const key = process.env.THEGRAPH_API_KEY;

// V3: recent swaps on the IMD V3 pool (feeTier is the correct field name)
const r3 = await fetch(
  `https://gateway.thegraph.com/api/${key}/subgraphs/id/5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `{
        pool(id: "0xd6a822d028bbf7b6edfa1533e110ee40c08551d9") { id feeTier liquidity }
        swaps(first: 5, orderBy: timestamp, orderDirection: desc,
              where: { pool: "0xd6a822d028bbf7b6edfa1533e110ee40c08551d9" }) {
          amount0 amount1 amountUSD timestamp
        }
      }`,
    }),
  }
);
console.log("V3 HTTP", r3.status, (await r3.text()).slice(0, 600));

// V4: recent swaps on IMD's V4 poolId
const r4 = await fetch(
  `https://gateway.thegraph.com/api/${key}/subgraphs/id/DiYPVdygkfjDWhbxGSqAQxwBKmfKnkWQojqeM2rkLb3G`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `{
        swaps(first: 5, orderBy: timestamp, orderDirection: desc,
              where: { pool: "0xb07d640fd9e2eb9dc81b953c8e4fd006bdfeaf276010fb5418eb763ca15abfb3" }) {
          amount0 amount1 timestamp
        }
      }`,
    }),
  }
);
console.log("V4 HTTP", r4.status, (await r4.text()).slice(0, 600));
