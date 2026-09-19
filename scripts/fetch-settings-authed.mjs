
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "fs";
const BASE = "https://imd.illuminati.co";
const pk = readFileSync("/Users/lancepitman/accumulate-imd/.env", "utf8").match(/^AGENT_PRIVATE_KEY=(.*)$/m)[1].trim();
const account = privateKeyToAccount(pk);
const nres = await fetch(`${BASE}/api/auth/nonce`);
const { nonce, message } = await nres.json();
const signature = await account.signMessage({ message });
const vres = await fetch(`${BASE}/api/auth/verify`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ address: account.address, signature, nonce }) });
const cookie = vres.headers.get("set-cookie").split(";")[0];
const res = await fetch(`${BASE}/settings`, { headers: { cookie } });
const html = await res.text();
writeFileSync("/tmp/authed-settings.html", html);
console.log("status:", res.status, "len:", html.length, "| has loadUserWallet:", html.includes("loadUserWallet"), "| has userWalletBox:", html.includes("userWalletBox"));
