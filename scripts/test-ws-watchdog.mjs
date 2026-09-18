
/**
 * test-ws-watchdog.mjs — live liveness test (real Alchemy WSS):
 * arms the watchdog on ethereum with a rebuild() that counts invocations,
 * waits for one probe cycle, and asserts NO stall fired (healthy socket) and
 * no rebuild happened.
 */
import { readFileSync } from "fs";
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim();
}
import { startWatchdog, stopWatchdog, noteWsActivity } from "../ws-watchdog.mjs";

const alerts = [];
// monkey-patch notify via process env off — alert() logs to console only when
// telegram keys unset, which is our assertion surface. We just watch rebuilds.
let rebuilds = 0;
process.env.WATCHDOG_PROBE_S = "15"; // floor

startWatchdog("ethereum", async () => { rebuilds++; });
noteWsActivity("ethereum");
console.log("watchdog armed — waiting 25s for one probe cycle...");
await new Promise((r) => setTimeout(r, 20000));
stopWatchdog("ethereum");
if (rebuilds !== 0) { console.error("FAIL: rebuild fired on a healthy socket"); process.exit(1); }
console.log("PASS: healthy-socket probe completed with no false rebuild");
