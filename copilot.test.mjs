/**
 * copilot.test.mjs — unit tests for copilot.mjs request lifecycle.
 * Uses a temp COPILOT_TIMEOUT_S so expiry is fast; does NOT touch the network
 * or any wallet — the SSE broadcast just no-ops with no clients connected.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";

process.env.COPILOT_TIMEOUT_S = "1";
process.env.COPILOT_ACTIVE = "true";
process.env.CONNECTED_WALLET = "0x0000000000000000000000000000000000000001";

// copilot.mjs resolves its DB relative to its own directory — copy it to a
// temp dir so tests never touch data/accumulate.db.
const tmp = mkdtempSync(join(tmpdir(), "copilot-test-"));
execSync(`cp ${new URL("./copilot.mjs", import.meta.url).pathname} ${tmp}/`);
process.chdir(tmp);
const { awaitBrowserSignatureSignal, buildCoPilotSigner, resolveRequest, declineRequest, listPending, listRecent, getRequest, pendingCount } = await import("./copilot.mjs");

test("decline rejects the waiting callContract promise", async () => {
  const signer = await buildCoPilotSigner("ethereum");
  const p = signer.callContract({
    address: "0x0000000000000000000000000000000000000002",
    abi: [{ name: "approve", type: "function", inputs: [], outputs: [] }],
    functionName: "approve", args: [],
  });
  const req1 = listPending().at(-1);
  assert.equal(declineRequest(req1.id).ok, true);
  await assert.rejects(p, /declined/);
  // after rejection the row should be marked declined
  const rows = listRecent(5);
  assert.equal(rows[0].status, "declined");
});

test("timeout rejects with the skip-and-log message", async () => {
  const signer = await buildCoPilotSigner("ethereum");
  const p = signer.callContract({
    address: "0x0000000000000000000000000000000000000003",
    abi: [{ name: "swap", type: "function", inputs: [], outputs: [] }],
    functionName: "swap", args: [], value: 1000n,
  });
  await assert.rejects(p, /skipped/);
  const rows = listRecent(5);
  assert.equal(rows[0].status, "expired");
});

test("resolve settles with the browser tx hash", async () => {
  const signer = await buildCoPilotSigner("ethereum");
  const p = signer.callContract({
    address: "0x0000000000000000000000000000000000000004",
    abi: [{ name: "swap", type: "function", inputs: [], outputs: [] }],
    functionName: "swap", args: [], value: 500n,
  });
  const pendingBefore = pendingCount();
  assert.ok(pendingBefore >= 1, "request should be pending");
  const req = listPending().at(-1);
  const r = resolveRequest(req.id, "0xdeadbeef");
  assert.equal(r.ok, true);
  assert.equal(await p, "0xdeadbeef");
  const row = getRequest(req.id);
  assert.equal(row.status, "approved");
  assert.equal(row.tx_hash, "0xdeadbeef");
});

test("resolveRequest on non-pending id returns error, does not throw", async () => {
  const r = resolveRequest("cp_nope", "0x1");
  assert.equal(r.ok, false);
});
