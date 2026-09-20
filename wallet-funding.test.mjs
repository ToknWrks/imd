import { test } from "node:test";
import assert from "node:assert/strict";
import { fundingTxParams } from "./wallet-slideout.js";

test("funding params echo the paying account as from", () => {
  const p = fundingTxParams({
    from: "0xa71Fb297aa443aDfc22Ff74981D8C067ec3475Cb",
    scwAddress: "0x" + "9".repeat(40),
    asset: "eth", amount: 0.001, chain: "ethereum",
  });
  assert.equal(p.from, "0xa71Fb297aa443aDfc22Ff74981D8C067ec3475Cb");
  assert.equal(p.chainId, "0x1");
  assert.equal(p.value, "0x" + BigInt(1e15).toString(16));
  assert.equal(p.to, "0x" + "9".repeat(40));
});

test("erc20 funding encodes transfer() to the token contract", () => {
  const token = "0x" + "c".repeat(40);
  const p = fundingTxParams({
    from: "0xa71Fb297aa443aDfc22Ff74981D8C067ec3475Cb",
    scwAddress: "0x" + "9".repeat(40),
    asset: "erc20", amount: 100, chain: "ethereum",
    tokenAddress: token, tokenDecimals: 18,
  });
  assert.equal(p.from, "0xa71Fb297aa443aDfc22Ff74981D8C067ec3475Cb");
  assert.equal(p.to, token);
  assert.match(p.data, /^0xa9059cbb/);
  assert.equal(p.data.length, 2 + 8 + 64 + 64);
});

test("rejects invalid addresses", () => {
  assert.throws(() => fundingTxParams({ from: "nope", scwAddress: "0x" + "9".repeat(40), asset: "eth", amount: 1, chain: "ethereum" }));
  assert.throws(() => fundingTxParams({ from: "0x" + "a".repeat(40), scwAddress: "nope", asset: "eth", amount: 1, chain: "ethereum" }));
});

test("chain ids map correctly", () => {
  const mk = (chain) => fundingTxParams({ from: "0x" + "a".repeat(40), scwAddress: "0x" + "9".repeat(40), asset: "eth", amount: 1, chain }).chainId;
  assert.equal(mk("ethereum"), "0x1");
  assert.equal(mk("base"), "0x2105");
  assert.equal(mk("robinhood"), "0x1237");
});
