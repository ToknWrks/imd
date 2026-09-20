
  process.env.MASTER_KEY = "stub";
  const mod = await import("../smart-wallet-api.mjs");
  const regMod = await import("./stubs-v2/registry-v2.stub.mjs");
  const __store = regMod.__store;
  const probe = "0x" + "c".repeat(40);
  const out = [];

  // 1. New wallet → v2 derivation, no key minted, needsActivate
  const r1 = await mod.ensureWalletSession(probe, "ethereum");
  out.push(["new-wallet-v2", r1.ok === true && r1.schema === 2 && r1.sessionKeyAddress === null && r1.needsActivate === true && r1.scwAddress === "0x" + "d".repeat(40)]);
  const rec = __store()[probe.toLowerCase()];
  out.push(["record-shape", rec && rec.schema === 2 && rec.ownerEoa === probe && rec.sessionKeyEnc === null && rec.grantStatus === "none"]);

  // 2. Reconnect → same address, still no key minted (case-insensitive —
  //    the reconnect path returns the record's EIP-55-checksummed address)
  const r2 = await mod.ensureWalletSession(probe, "ethereum");
  out.push(["reconnect-stable", r2.scwAddress.toLowerCase() === r1.scwAddress.toLowerCase() && r2.created === false && r2.sessionKeyAddress === null]);

  // 3. resolveUserSessionKeyAsync → null (co-pilot), never throws
  const skNull = await mod.resolveUserSessionKeyAsync(probe);
  out.push(["null-key-copilot", skNull === null]);

  // 4. Read wallet straight from the record (case-insensitive compare — EIP-55
  //    checksumming of an all-same-nibble address is mixed case)
  const read = await mod.resolveUserReadWallet(probe, "ethereum");
  out.push(["read-wallet-v2", read && read.toLowerCase() === ("0x" + "d".repeat(40))]);
  const reads = await mod.resolveUserReadWallets(probe, "ethereum");
  out.push(["read-wallets-v2", reads.some((a) => a.toLowerCase() === ("0x" + "d".repeat(40))) && reads.some((a) => a.toLowerCase() === probe)]);

  // 5. activateSmartWallet → browser payload, owner = EOA, not self-owned
  const act = await mod.activateSmartWallet("ethereum", { browserFrom: probe, userId: probe });
  out.push(["activate-browser", act.ok === true && act.browserSign === true && act.factory && act.callData.length > 10]);
  out.push(["activate-owner", act.owner && act.owner.toLowerCase() === probe && act.owner.toLowerCase() !== act.scwAddress.toLowerCase()]);

  // 6. moveFunds('out') for v2 → explicit browser-sign error (no silent server key use)
  let threw = null;
  try { await mod.moveFunds({ direction: "out", asset: "eth", amount: 0.1, chainKey: "ethereum", userId: probe }); }
  catch (e) { threw = e.message; }
  out.push(["moveout-blocked", threw !== null && /browser/.test(threw)]);

  const fails = out.filter(([, ok]) => !ok);
  for (const [name, ok] of out) console.log((ok ? "PASS" : "FAIL") + " " + name);
  process.exit(fails.length ? 1 : 0);
