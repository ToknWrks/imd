/**
 * swap.test.mjs — /swap route contract: serves the page on GET /swap,
 * falls through on everything else. Run: node --test swap.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleSwapRequest } from "./swap-routes.mjs";

test("GET /swap renders the page through shell and returns true", async () => {
  const sent = [];
  const shell = (title, body, active) => `<shell title=${title} active=${active}>${body}</shell>`;
  const handled = await handleSwapRequest("/swap", "GET", { send: (h) => sent.push(h), shell });
  assert.equal(handled, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /<swapkit-widget/);
  assert.match(sent[0], /active=swap/);
  assert.match(sent[0], /swapkit-widget\.js/);
});

test("other paths/methods return false (fall through)", async () => {
  const noop = () => {};
  assert.equal(await handleSwapRequest("/swap", "POST", { send: noop, shell: noop }), false);
  assert.equal(await handleSwapRequest("/swapx", "GET", { send: noop, shell: noop }), false);
  assert.equal(await handleSwapRequest("/api/swap", "GET", { send: noop, shell: noop }), false);
});
