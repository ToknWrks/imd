import { createPublicClient, http, parseAbi, parseAbiParameters, encodeFunctionData, encodeAbiParameters, getAddress } from 'viem';

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

// V4 SWAP_EXACT_IN single-hop through the hooked pool
function swapParamsFor(currencyIn, currencyOut, amountIn, minOut, recipient) {
  const HEAD_WORDS = 5, PATH_WORDS = 8;
  const pathOffset = HEAD_WORDS * 32;
  const emptyFieldOffset = pathOffset + PATH_WORDS * 32;
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

// 1 ATL sell, recipient = seller (their own funds, their own address)
const SMALL = 10n ** 15n; // 0.001 ATL — dust
const sellData = executeData(buildV4Payload(swapParamsFor(ATL, MU, SMALL, 0n), ATL, MU, SELLER));

async function estimate(label, from, to, data, value = '0x0') {
  try {
    const res = await c.request({ method: 'eth_estimateGas', params: [{ from, to, data, value }, 'latest'] });
    console.log('PASS', label, 'gas =', BigInt(res).toString());
    return true;
  } catch (e) {
    // walk cause chain for revert data
    let err = e, details = '';
    while (err) {
      if (err.details) details = err.details;
      if (err.shortMessage) details += ' | ' + err.shortMessage;
      err = err.cause || null;
    }
    console.log('FAIL:', label, '::', (details || String(e)).slice(0, 400).replace(/\n/g, ' '));
    return false;
  }
}

// TEST 1: direct UR swap from the seller (tests whether the hook truly locks outsiders)
await estimate('UR sell 0.001 ATL->MU (from Rabby seller)', SELLER, UR, sellData);

// TEST 2: same but through Relay router address (to see if Relay path differs)
await estimate('UR sell via Relay router addr', SELLER, '0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f', sellData);

console.log('done');
process.exit(0);
