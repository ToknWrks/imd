import { createPublicClient, http, parseAbi, parseAbiParameters, encodeAbiParameters, getAddress, keccak256 } from 'viem';

const c = createPublicClient({ transport: http('https://rpc.mainnet.chain.robinhood.com') });
const ATL  = '0x26915c10e8Ce9fb86B836fE8B129A1c5c3771E18';
const SELLER = '0x217C05f5D1D1E595BBae94534540B803bfC4563B';
const ERC20_ABI = parseAbi(['function balanceOf(address) view returns (uint256)']);
const bal = await c.readContract({ address: ATL, abi: ERC20_ABI, functionName: 'balanceOf', args: [SELLER] });
console.log('seller bal:', bal.toString());

// scan simple mapping slots 0..60
for (let slot = 0; slot <= 60; slot++) {
  const key = keccak256(encodeAbiParameters(parseAbiParameters('address, uint256'), [getAddress(SELLER), BigInt(slot)]));
  const raw = await c.getStorageAt({ address: ATL, slot: key });
  if (BigInt(raw) === bal) { console.log('FOUND simple mapping slot', slot); process.exit(0); }
}

// scan raw slots 0..30 (unhashed — maybe balances not a mapping but under a struct base)
for (let slot = 0; slot <= 30; slot++) {
  const raw = await c.getStorageAt({ address: ATL, slot: BigInt(slot) });
  if (BigInt(raw) === bal) { console.log('FOUND at raw slot', slot); process.exit(0); }
}

// ERC-7201 namespaced: try common namespace ids by hashing strings
const names = ['erc7201:atlantis', ' ATLANTIS', 'atlantis.storage', 'openzeppelin.storage'];
for (const ns of names) {
  const base = keccak256(new TextEncoder().encode(ns));
  const key = keccak256(encodeAbiParameters(parseAbiParameters('address, uint256'), [getAddress(SELLER), base]));
  const raw = await c.getStorageAt({ address: ATL, slot: key });
  if (BigInt(raw) === bal) { console.log('FOUND namespaced', ns); process.exit(0); }
}
console.log('slot not found by simple scans');
process.exit(0);
