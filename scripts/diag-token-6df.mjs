// Deep-dive 0x6Df52cC6… on mainnet: bytecode size, ERC-20 call revert data,
// and any V4 Initialize events naming this address as currency0 or currency1.
const { readFileSync } = await import("fs");
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const { createPublicClient, http, parseAbi, toHex } = await import("viem");
const { ethereum } = await import("viem/chains");
const c = createPublicClient({ chain: ethereum, transport: http(`https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`) });

const T = "0x6Df52cC6E2E6f6531E4ceB4b083CF49864A89020";

const code = await c.getBytecode({ address: T });
console.log("bytecode size:", ((code?.length ?? 2) - 2) / 2, "bytes");
// EOAs have no code
console.log("is EOA:", code === "0x");

// raw eth_call to see the revert reason
const r = await c.request({ method: "eth_call", params: [{ to: T, data: "0x95d89b41" }, "latest"] }).catch((e) => ({ err: e.message.slice(0, 160) }));
console.log("symbol() raw:", JSON.stringify(r).slice(0, 300));

// V4 PoolManager Initialize events with this address as currency0 or currency1
const PM = "0x000000000004444c5dc75cB358380D2e3dE08A90";
const INIT_TOPIC = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
const head = await c.getBlockNumber();
const T_ADDR = "0x0000000000000000000000006df52cc6e2e6f6531e4ceb4b083cf49864a89020";
let found = 0;
for (let i = 0; i < 5 && found === 0; i++) {
  const to = head - BigInt(i * 9);
  const logs = await c.getLogs({
    address: PM,
    topics: [
      "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438",
      null,
      T_ADDR, // currency1 candidate (indexed topic3)
    ],
    fromBlock: to - 9n,
    toBlock: to,
  });
  for (const l of logs) found++;
}
console.log("recent Initialize logs with token as currency1 (last ~45 blocks):", found);
