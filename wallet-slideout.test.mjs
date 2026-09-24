/**
 * wallet-slideout render test — runs the SERVED browser script (the exact
 * <script> body walletSlideoutHtml() emits) in a vm sandbox with a tiny DOM
 * stub, then renders the v2 smart-wallet card for deployed/granted, pending,
 * and undeployed states. Any "x is not defined" (the 2026-09-24 `bal`
 * regression that blanked the whole card) or other render-time throw fails
 * the test. Server-side tests never execute this script — this one does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { walletSlideoutHtml } from "./wallet-slideout.js";

function servedScript() {
  const html = walletSlideoutHtml();
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(m, "walletSlideoutHtml() must embed a <script> block");
  return m[1];
}

function makeSandbox() {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) {
      els.set(id, {
        id, innerHTML: "", textContent: "", value: "", style: {}, disabled: false,
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        addEventListener() {}, querySelector() { return null; }, appendChild() {}, insertBefore() {}, remove() {},
        parentElement: { classList: { toggle() {} } },
      });
    }
    return els.get(id);
  };
  const document = {
    getElementById: el,
    createElement: () => el("__created" + els.size),
    addEventListener() {},
    body: { appendChild() {}, removeChild() {} },
    execCommand() { return true; },
  };
  const sandbox = {
    document, console,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: false }) }),
    navigator: { clipboard: { writeText: async () => {} } },
    location: { reload() {} },
    alert() {}, confirm: () => true,
    BigInt, Number, String, Math, JSON, Promise, Date, Error, Object, Array, parseFloat, parseInt, isNaN, encodeURIComponent,
    _wcAddress: "0xa71fb297aa443adfc22ff74981d8c067ec3475cb",
  };
  sandbox.window = sandbox;
  return { sandbox, el };
}

const SCW = "0x3C733086DDB1E335c340A4a330b6ad274FA14021";
const baseState = (over = {}) => ({
  ok: true, chain: "ethereum", schema: 2, custodyLabel: "your EOA owns it",
  ethUsd: 4000, imdPerEth: 450, imdSymbol: "IMD", grantStatus: "granted",
  ownerEoa: "0xa71fb297aa443adfc22ff74981d8c067ec3475cb", hasSessionKey: true,
  owner: { address: "0xa71fb297aa443adfc22ff74981d8c067ec3475cb", eth: 0.5, usd: 12.3, dollarDecimals: 6, imd: 3 },
  scw: { address: SCW, eth: 0.028, activated: true, usd: 6.06, imd: 5.88 },
  gasReserveEth: 0.0008, dollarSymbol: "USDC",
  dollarToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  imdToken: "0xD34a99Bc0f67aE1bbd63C660e6d0b0dd03E263B7",
  ...over,
});

for (const [label, state, expect] of [
  ["deployed + automation granted", baseState(), /automation on/],
  ["deployed + grant pending", baseState({ grantStatus: "pending" }), /Enable automated trading/],
  ["not deployed", baseState({ scw: { address: SCW, eth: 0, activated: false, usd: null, imd: null } }), /Activate smart wallet/],
  ["with watched-token rows", baseState(), /VANGUARD/],
]) {
  test(`slideout v2 card renders without throwing: ${label}`, () => {
    const { sandbox, el } = makeSandbox();
    if (label.includes("watched")) {
      sandbox._walletData = { tokens: [{ address: "0x" + "5".repeat(40), symbol: "VANGUARD", decimals: 18, chain: "ethereum", balance: 10, ownerBalance: 4, scwBalance: 6, priceUsd: 0.01 }] };
    }
    vm.createContext(sandbox);
    vm.runInContext(servedScript(), sandbox, { filename: "wallet-slideout.served.js" });
    sandbox._swState = state;
    vm.runInContext("_swState = globalThis._swState; renderSmartWalletSection();", sandbox);
    const html = el("smartWalletSection").innerHTML;
    assert.ok(html.length > 200, "card HTML should be rendered");
    assert.match(html, new RegExp(SCW.slice(2, 8), "i"), "card shows the SCW address");
    assert.match(html, expect);
  });
}
