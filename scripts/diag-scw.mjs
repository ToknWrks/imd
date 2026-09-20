// Read-only: inspect a user's SCW (deploy state, balance, nonce) via Alchemy.
// Usage: node scripts/diag-scw.mjs 0xa71Fb297aa443aDfc22Ff74981D8C067ec3475Cb
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { readFileSync } from "fs";

const owner = process.argv[2]?.toLowerCase();
if (!/^0x[0-9a-fA-F]{40}$/.test(owner ?? "")) {
  console.error("usage: node scripts/diag-scw.mjs <owner-address>");
  process.exit(1);
}
const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const key = env.match(/^ALCHEMY_API_KEY=(.*)$/m)?.[1]?.trim();
if (!key) { console.error("no ALCHEMY_API_KEY in .env"); process.exit(1); }
const pub = createPublicClient({ chain: mainnet, transport: http(`https://eth-mainnet.g.alchemy.com/v2/${key}`) });

const reg = JSON.parse(readFileSync(new URL("../data/connected-wallets.json", import.meta.url), "utf8"));
const wallets = reg.wallets ?? reg;
const rec = wallets[owner] ?? Object.entries(wallets).find(([a]) => a.toLowerCase() === owner.toLowerCase())?.[1];
const scw = rec?.scwAddress ?? rec?.scw;
if (!scw) { console.error("no SCW record for", owner); process.exit(1); }

const [code, bal, nonce] = await Promise.all([
  pub.getCode({ address: scw }).catch(() => "0x"),
  pub.getBalance({ address: scw }).catch(() => 0n),
  pub.getTransactionCount({ address: scw }).catch(() => -1),
]);
console.log("owner :        ", owner);
console.log("SCW  :         ", scw);
console.log("deployed:      ", code && code !== "0x" ? "YES" : "no");
console.log("balance ETH:   ", Number(bal) / 1e18);
console.log("outgoing nonce:", nonce, "(0 = SCW has never sent anything)");
