
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

  // 6. v1 removed: a legacy (non-v2) record is REFUSED loudly, never overwritten
  const legacy = "0x" + "e".repeat(40);
  __store()[legacy] = { scwAddress: "0x" + "7".repeat(40), sessionKeyEnc: "enc:0x" + "1".repeat(64) };
  let threw = null;
  try { await mod.ensureWalletSession(legacy, "ethereum"); } catch (e) { threw = e.message; }
  out.push(["v1-record-refused", threw !== null && /v1/.test(threw) && __store()[legacy].scwAddress === "0x" + "7".repeat(40) && !__store()[legacy].schema]);
  // ...and it yields NO session key (v1 keys are never used to sign)
  out.push(["v1-key-ignored", (await mod.resolveUserSessionKeyAsync(legacy)) === null]);
  // granted v2 key resolves
  __store()[probe.toLowerCase()].sessionKeyEnc = "enc:0x" + "2".repeat(64);
  out.push(["v2-key-resolves", (await mod.resolveUserSessionKeyAsync(probe)) === "0x" + "2".repeat(64)]);
  __store()[probe.toLowerCase()].sessionKeyEnc = null;
  out.push(["v1-api-gone", typeof mod.moveFunds === "undefined" && typeof mod.generateUserSessionKey === "undefined" && typeof mod.generateSessionKey === "undefined"]);

  // 7. quoteDirectSweepV2 guards (2026-09-20 direct-execute sweep): needs a v2
  //    record and a positive amount — both checked BEFORE any RPC call.
  //    probe HAS a record by now (step 1), so the no-record check uses a fresh
  //    address; the no-amount check fires before RPC for any address.
  threw = null;
  const bare = "0x" + "b".repeat(39) + "1";
  try { await mod.quoteDirectSweepV2(bare, "ethereum", { asset: "eth", amount: 0.1 }); }
  catch (e) { threw = e.message; }
  out.push(["direct-sweep-needs-record", threw !== null && /no v2 record/.test(threw)]);
  threw = null;
  try { await mod.quoteDirectSweepV2(probe, "ethereum", { asset: "eth", amount: 0 }); }
  catch (e) { threw = e.message; }
  out.push(["direct-sweep-needs-amount", threw !== null && /positive amount/.test(threw)]);

  const fails = out.filter(([, ok]) => !ok);
  for (const [name, ok] of out) console.log((ok ? "PASS" : "FAIL") + " " + name);
  process.exit(fails.length ? 1 : 0);
