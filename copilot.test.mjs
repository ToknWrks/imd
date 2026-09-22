/**
 * copilot.test.mjs — unit tests for copilot.mjs request lifecycle.
 * Uses a temp COPILOT_TIMEOUT_S so expiry is fast; does NOT touch the network
 * or any wallet — the SSE broadcast just no-ops with no clients connected.
 *
 * 2026-09-22 (cross-process rework): the engine no longer blocks on an
 * in-memory waiter — awaitBrowserSignature polls the shared SQLite row
 * (awaitRequestResolution), so approval works even when the resolve POST
 * lands in a DIFFERENT process than the one that enqueued the request (the
 * hosted imd-watcher/imd-dashboard split where every engine co-pilot buy
 * failed with "no waiter (server restarted?)"). These tests exercise exactly
 * that: enqueue in this process, settle via resolveRequest/declineRequest —
 * the same row-level path a second process would take.
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
const { buildCoPilotSigner, withCopilotContext, resolveRequest, declineRequest, listPending, listRecent, getRequest, pendingCount } = await import("./copilot.mjs");

test("decline settles the waiting callContract via the shared row", async () => {
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

test("timeout (expires_at sweep) expires the request and the engine skips", async () => {
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

test("resolve settles with the browser tx hash — even from another process's perspective", async () => {
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
  assert.equal(r.ok, true, "resolve must succeed with NO in-memory waiter — the engine polls the row");
  assert.equal(await p, "0xdeadbeef");
  const row = getRequest(req.id);
  assert.equal(row.status, "approved");
  assert.equal(row.tx_hash, "0xdeadbeef");
});

test("resolveRequest on non-pending id returns error, does not throw", async () => {
  const r = resolveRequest("cp_nope", "0x1");
  assert.equal(r.ok, false);
});

test("withCopilotContext stamps product/symbol/summary on enqueued requests", async () => {
  const signer = await buildCoPilotSigner("ethereum");
  const p = withCopilotContext(
    { product: "dip", symbol: "IMD", kind: "buy", summary: "SCHEDULED BUY · IMD · $25" },
    () => signer.callContract({
      address: "0x0000000000000000000000000000000000000005",
      abi: [{ name: "swap", type: "function", inputs: [], outputs: [] }],
      functionName: "swap", args: [], value: 500n,
    }),
  );
  const req = listPending().at(-1);
  assert.equal(req.product, "dip");
  assert.equal(req.symbol, "IMD");
  assert.equal(req.summary, "SCHEDULED BUY · IMD · $25");
  assert.equal(req.kind, "buy");
  resolveRequest(req.id, "0xfeedface");
  assert.equal(await p, "0xfeedface");
});

test("explicit copilot opts beat the context", async () => {
  const signer = await buildCoPilotSigner("ethereum");
  const p = withCopilotContext(
    { product: "dip", symbol: "IMD", summary: "context summary" },
    () => signer.callContract({
      address: "0x0000000000000000000000000000000000000006",
      abi: [{ name: "approve", type: "function", inputs: [], outputs: [] }],
      functionName: "approve", args: [],
      copilot: { kind: "approve", product: "sniper", summary: "explicit summary" },
    }),
  );
  const req = listPending().at(-1);
  assert.equal(req.product, "sniper");
  assert.equal(req.summary, "explicit summary");
  assert.equal(req.kind, "approve");
  declineRequest(req.id);
  await assert.rejects(p, /declined/);
});

test("dip buys get the 5-minute window; others keep COPILOT_TIMEOUT_S", async () => {
  const signer = await buildCoPilotSigner("ethereum");
  const p = withCopilotContext(
    { product: "dip", symbol: "IMD", kind: "buy" },
    () => signer.callContract({
      address: "0x0000000000000000000000000000000000000007",
      abi: [{ name: "swap", type: "function", inputs: [], outputs: [] }],
      functionName: "swap", args: [], value: 1n,
    }),
  );
  const req = listPending().at(-1);
  // expires_at ≈ now + 300s (dip window), NOT the 1s test base
  const expiry = Date.parse(req.expires_at + "Z");
  const created = Date.parse(req.created_at + "Z");
  const windowS = (expiry - created) / 1000;
  assert.ok(windowS >= 290, `dip window should be ~300s, got ${windowS}s`);
  resolveRequest(req.id, "0x0005");
  assert.equal(await p, "0x0005");
});

test("approving AFTER the poll started still settles (late resolve)", async () => {
  const signer = await buildCoPilotSigner("ethereum");
  const p = signer.callContract({
    address: "0x0000000000000000000000000000000000000008",
    abi: [{ name: "swap", type: "function", inputs: [], outputs: [] }],
    functionName: "swap", args: [], value: 100n,
  });
  // resolve a tick later — simulates the dashboard process writing the row
  // while the engine's poll loop is mid-sleep
  await new Promise((r) => setTimeout(r, 2500));
  const req = listRecent(5).find((r2) => r2.status === "pending");
  assert.ok(req, "request should still be pending (maxMs backstop hasn't fired)");
  assert.equal(resolveRequest(req.id, "0xlate").ok, true);
  assert.equal(await p, "0xlate");
});
