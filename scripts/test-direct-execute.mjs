// One-off: can the session-key EOA call SCW.execute() DIRECTLY (not via EntryPoint)?
// If yes, the imported key works in ANY wallet (Rabby) to sweep SCW funds.
import { readFileSync } from "fs";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { parseAbi, privateKeyToAccount } from "viem/accounts";

process.env.MASTER_KEY = readFileSync(new URL("../.env", import.meta.url), "utf8").match(/^MASTER_KEY=(.*)$/m)[1].trim();
const key = readFileSync(new URL("../.env", import.meta.url), "utf8").match(/^ALCHEMY_API_KEY=(.*)$/m)[1].trim();
const pub = createPublicClient({ chain: mainnet, transport: http(`https://eth-mainnet.g.alchemy.com/v2/${key}`) });

const { resolveUserSessionKeyAsync } = await import("../smart-wallet-api.mjs");
const sk = await resolveUserSessionKeyAsync("0xa71Fb297aa443aDfc22Ff74981D8C067ec3475Cb");
const acct = privateKeyToAccount(sk);
console.log("owner EOA:", acct.address);

try {
  await pub.simulateContract({
    address: "0xd27a324A6b07736b694C7cE756514c7842387317",
    abi: parseAbi(["function execute(address dest, uint256 value, bytes func)"]),
    functionName: "execute",
    args: ["0xa71Fb297aa443aDfc22Ff74981D8C067ec3475Cb", 100000000000000n, "0x"],
    account: acct.address,
  });
  console.log("DIRECT owner execute: SUCCEEDED — owners can drive the SCW directly");
} catch (e) {
  console.log("DIRECT owner execute REVERTED:", String(e.shortMessage || e.message).slice(0, 140));
}
