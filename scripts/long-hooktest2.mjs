import { createPublicClient, http, parseAbi, parseAbiParameters, encodeFunctionData, encodeAbiParameters, getAddress, keccak256 } from 'viem';

const c = createPublicClient({ transport: http('https://rpc.mainnet.chain.robinhood.com') });
const UR = '0x8876789976decbfcbbbe364623c63652db8c0904';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const MU   = '0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD';
const ATL  = '0x26915c10e8Ce9fb86B836fE8B129A1c5c3771E18';
const HOOK = '0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544';
const SELLER = '0x217C05f5D1D1E595BBae94534540B803bfC4563B';
const DEADLINE = BigInt(Math.floor(Date.now() / 1000) + 600);

const wn = (x) => BigInt(x).toString(16).padStart(64, '0');
const ad = (a) => getAddress(a).slice(2).toLowerCase().padStart(64, '0');

function swapParamsFor(currencyIn, currencyOut, amountIn, minOut) {
  const pathOffset = 5 * 32, emptyFieldOffset = 5 * 32 + 8 * 32;
  const tuple = [
    ad(currencyIn), wn(pathOffset), wn(emptyFieldOffset), wn(amountIn), wn(minOut),
    wn(1), wn(0x20), ad(currencyOut), wn(8388608), wn(8), ad(HOOK), wn(0xa0), wn(0), wn(0),
  ];
  return '0x' + wn(0x20) + tuple.join('');
}
function buildV4Payload(swapParams, currencyIn, currencyOut, recipient) {
  const settleParams = encodeAbiParameters(parseAbiParameters('address currency, uint256 amount, bool payerIsUser'), [currencyIn, 0n, true]);
  const takeParams = encodeAbiParameters(parseAbiParameters('address currency, address recipient, uint256 amount'), [currencyOut, getAddress(recipient), 0n]);
  return encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), ['0x070b0e', [swapParams, settleParams, takeParams]]);
}
function executeData(payload) {
  return encodeFunctionData({
    abi: parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']),
    functionName: 'execute', args: ['0x10', [payload], DEADLINE],
  });
}

const SMALL = 10n ** 15n;
const sellData = executeData(encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), ['0x070b0e', [
  swapParamsFor(ATL, MU, SMALL, 0n),
  encodeAbiParameters(parseAbiParameters('address currency, uint256 amount, bool payerIsUser'), [ATL, 0n, true]),
  encodeAbiParameters(parseAbiParameters('address currency, address recipient, uint256 amount'), [MU, getAddress(SELLER), 0n]),
]]));

// Permit2 allowance storage diff for several candidate base slots:
const stateDiff = {};
for (const base of [0, 1, 2, 3, 4, 5]) {
  const k1 = keccak256(encodeAbiParameters(parseAbiParameters('address, uint256'), [getAddress(SELLER), BigInt(base)]));
  const k2 = keccak256(encodeAbiParameters(parseAbiParameters('address, uint256'), [getAddress(ATL), BigInt(k1)]));
  const key = keccak256(encodeAbiParameters(parseAbiParameters('address, uint256'), [getAddress(UR), BigInt(k2)]));
  // uint160 amount (max) | uint48 expiration (max) | (nonce low bits) — pack as one 32-byte word
  const amount = (1n << 160n) - 1n;
  const expiration = (1n << 48n) - 1n;
  const word = (amount << 96n) | (expiration << 48n) | 0n;
  stateDiff[key] = '0x' + word.toString(16).padStart(64, '0');
}
const ovr = { [PERMIT2]: { stateDiff } };

async function estimate(label, from, to, data, o) {
  try {
    const res = await c.request({ method: 'eth_estimateGas', params: [{ from, to, data, value: '0x0' }, 'latest', o] });
    console.log('PASS', label, 'gas =', BigInt(res).toString());
    return true;
  } catch (e) {
    let err = e, details = '';
    while (err) { if (err.details) details = err.details; err = err.cause || null; }
    console.log('FAIL:', label, '::', (details || String(e)).slice(0, 300).replace(/\n/g, ' '));
    return false;
  }
}

await estimate('SELL 0.001 ATL->MU (Permit2 overridden)', SELLER, UR, sellData, ovr);

// BUY direction: MU -> ATL (wallet = seller; seller has no MU, so override MU balance too)
const buyData = executeData(encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), ['0x070b0e', [
  swapParamsFor(MU, ATL, 10n ** 17n, 0n),
  encodeAbiParameters(parseAbiParameters('address currency, uint256 amount, bool payerIsUser'), [MU, 0n, true]),
  encodeAbiParameters(parseAbiParameters('address currency, address recipient, uint256 amount'), [ATL, getAddress(SELLER), 0n]),
]]));
const buyOvr = JSON.parse(JSON.stringify(ovr));
// add MU balance override for seller (find slot like ATL — try same slot patterns; MU is likely same deploy)
for (const base of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
  const kb = keccak256(encodeAbiParameters(parseAbiParameters('address, uint256'), [getAddress(SELLER), BigInt(base)]));
  buyOvr[MU] = buyOvr[MU] || { stateDiff: {} };
  buyOvr[MU].stateDiff[kb] = '0x' + (10n ** 20n).toString(16).padStart(64, '0');
}
// note: simple-slot balance guesses may miss; if BUY fails with balance/transfer err, we'll do slot discovery for MU
await estimate('BUY 0.1 MU->ATL (Permit2 + MU bal overridden)', SELLER, UR, buyData, buyOvr);
console.log('done');
process.exit(0);
