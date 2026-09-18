
import { privateKeyToAccount } from "viem/accounts";

const BASE = "http://localhost:4299";
const nres = await fetch(`${BASE}/api/auth/nonce`);
const { nonce, message } = await nres.json();

const pk = (await import("fs")).readFileSync("/Users/lancepitman/accumulate-imd/.env", "utf8")
  .match(/^AGENT_PRIVATE_KEY=(.*)$/m)?.[1]?.trim();
const account = privateKeyToAccount(pk.startsWith("0x") ? pk : "0x" + pk);
console.log("signing as:", account.address);

const signature = await account.signMessage({ message });
const vres = await fetch(`${BASE}/api/auth/verify`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ address: account.address, signature, nonce }),
});
const cookie = vres.headers.get("set-cookie");
const vj = await vres.json();
console.log("verify:", JSON.stringify(vj), "| cookie set:", !!cookie);

const page = await fetch(`${BASE}/overview`, { headers: { cookie } });
const body = await page.text();
console.log("authenticated overview:", page.status, "| has nav:", body.includes("nav-link"), "| length:", body.length);

const anon = await fetch(`${BASE}/overview`);
console.log("anon overview is login page:", (await anon.text()).includes("walletLogin"));
