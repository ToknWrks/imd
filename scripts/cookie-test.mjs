import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";
const BASE = "https://imd.illuminati.co";
const pk = readFileSync("/Users/lancepitman/accumulate-imd/.env", "utf8").match(/^AGENT_PRIVATE_KEY=(.*)$/m)[1].trim();
const account = privateKeyToAccount(pk);
const nres = await fetch(`${BASE}/api/auth/nonce`);
const { nonce, message } = await nres.json();
const signature = await account.signMessage({ message });
const vres = await fetch(`${BASE}/api/auth/verify`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ address: account.address, signature, nonce }) });
const cookie = vres.headers.get("set-cookie");
console.log("status:", vres.status);
console.log("set-cookie raw:", cookie);
const body = await vres.json();
console.log("body:", JSON.stringify(body));
// Test cookie actually authenticates:
const pres = await fetch(`${BASE}/settings`, { headers: { cookie } });
const phtml = await pres.text();
console.log("settings with cookie: status", pres.status, "| is dashboard:", phtml.includes("nav-link"), "| is login page:", phtml.includes("walletLogin"));
// Also test /api/user/wallet with the cookie:
const wres = await fetch(`${BASE}/api/user/wallet`, { headers: { cookie } });
console.log("wallet API:", JSON.stringify(await wres.json()));
