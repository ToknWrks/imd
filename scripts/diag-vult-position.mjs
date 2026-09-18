// Verify computeWalletPosition prices VULT correctly via the USDC pool.
import { readFileSync } from "fs";
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const { computeWalletPosition } = await import("../wallet-position.mjs");
const pos = await computeWalletPosition({
  contractAddress: "0xb788144DF611029C60b859DF47e79B7726C4DEBa",
  decimals: 18,
  walletAddress: "0xa71Fb297aa443aDfc22Ff74981D8C067ec3475Cb",
  chainKey: "ethereum",
});
console.log(JSON.stringify({
  balance: pos.balance,
  priceUsd: pos.priceUsd,
  balanceUsd: pos.balanceUsd,
  costBasisUsd: pos.costBasisUsd,
  unrealizedPlUsd: pos.unrealizedPlUsd,
  unrealizedPlPct: pos.unrealizedPlPct,
}, null, 2));
