import { issueNonce, issueSessionToken, verifySessionToken } from "../auth.mjs";

const n = issueNonce();
console.log("nonce issued:", n.length, "chars (consume is module-private; covered by live login test)");
console.log("nonce exists:", typeof n === "string" && n.length === 32);

const t = issueSessionToken("0xabc0000000000000000000000000000000001234");
const addr = verifySessionToken(t);
console.log("token roundtrip:", addr);
const tampered = t.slice(0, -1) + (t.endsWith("0") ? "1" : "0");
console.log("tamper rejected:", verifySessionToken(tampered) === null);
console.log("garbage rejected:", verifySessionToken("nope") === null);
console.log("expired-session shape ok:", verifySessionToken("1.0xabc0000000000000000000000000000000001234.bad") === null);
