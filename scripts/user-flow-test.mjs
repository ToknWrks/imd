
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";
const BASE = "https://imd.illuminati.co";
const pk = readFileSync("/Users/lancepitman/accumulate-imd/.env", "utf8").match(/^AGENT_PRIVATE_KEY=(.*)$/m)[1].trim();
const account = privateKeyToAccount(pk);
const nres = await fetch(`${BASE}/api/auth/nonce`);
const { nonce, message } = await nres.json();
const signature = await account.signMessage({ message });
const vres = await fetch(`${BASE}/api/auth/verify`, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ address: account.address, signature, nonce }) });
const cookie = vres.headers.get("set-cookie").split(";")[0];
const t0 = Date.now();
const wres = await fetch(`${BASE}/api/user/wallet`, { headers: { cookie } });
const wj = await wres.json();
console.log("wallet API:", JSON.stringify(wj), "in", Date.now() - t0, "ms");
const kres = await fetch(`${BASE}/api/user/session-key`, { method: "POST", headers: {"Content-Type":"application/json", cookie }, body: "{}" });
console.log("generate:", JSON.stringify(await kres.json()), "in", Date.now() - t0, "ms");
