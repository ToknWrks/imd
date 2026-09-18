import { createPublicClient, http, parseAbi, parseAbiParameters, encodeFunctionData, encodeAbiParameters, getAddress, keccak256 } from 'viem';

const c = createPublicClient({ transport: http('https://rpc.mainnet.chain.robinhood.com') });

const UR = '0x8876789976decbfcbbbe364623c63652db8c0904';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const MU   = '0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD';
const ATL  = '0x26915c10e8Ce9fb86B836fE8B129A1c5c3771E18';
const HOOK = '0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544';
const WALLET = '0xa71Fb297aa443aDfc22Ff74981D8C067ec3475Cb';
const SELLER = '0x217C05f5D1D1E595BBae94534540B803bfC4563B';
const DEADLINE = BigInt(Math.floor(Date.now() / 1000) + 600);
const ERC20_ABI = parseAbi(['function balanceOf(address) view returns (uint256)']);

// ---------- 1. find ATLANTIS balanceOf storage slot using the Rabby seller ----------
async function findBalanceSlot(token, holder) {
  const bal = await c.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [holder] });
  if (bal === 0n) return { bal, slot: null };
  for (let slot = 0; slot <= 12; slot++) {
    const key = keccak256(encodeAbiParameters(parseAbiParameters('address, uint256'), [getAddress(holder), BigInt(slot)]));
    const raw = await c.getStorageAt({ address: token, slot: key });
    if (BigInt(raw) === bal) return { bal, slot };
  }
  return { bal, slot: null };
}
const atlSlot = await findBalanceSlot(ATL, SELLER);
console.log('ATL balanceOf slot:', atlSlot.slot === null ? 'NOT FOUND' : atlSlot.slot.toString(), '| seller bal:', atlSlot.bal.toString());
if (atlSlot.slot === null) { console.log('cannot proceed without slot'); process.exit(1); }

// ---------- 2. build UR calldata: SELL ATL->MU and BUY MU->ATL ----------
const wn = (x) => BigInt(x).toString(16).padStart(64, '0');
const ad = (a) => getAddress(a).slice(2).toLowerCase().padStart(64, '0');

function swapParamsFor(currencyIn, currencyOut, amountIn, minOut) {
  const HEAD_WORDS = 5, PATH_WORDS = 8;
  const pathOffset = HEAD_WORDS * 32;
  const emptyFieldOffset = pathOffset + PATH_WORDS * 32;
  const tuple = [
    ad(currencyIn), wn(pathOffset), wn(emptyFieldOffset), wn(amountIn), wn(minOut),
    wn(1), wn(0x20), ad(currencyOut), wn(8388608), wn(8), ad(HOOK), wn(0xa0), wn(0), wn(0),
  ];
  return '0x' + wn(0x20) + tuple.join('');
}
function buildV4Payload(swapParams, currencyIn, currencyOut) {
  const settleParams = encodeAbiParameters(parseAbiParameters('address currency, uint256 amount, bool payerIsUser'), [currencyIn, 0n, true]);
  const takeParams = encodeAbiParameters(parseAbiParameters('address currency, address recipient, uint256 amount'), [currencyOut, getAddress(WALLET), 0n]);
  return encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), ['0x070b0e', [swapParams, settleParams, takeParams]]);
}
function executeData(payload) {
  return encodeFunctionData({
    abi: parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']),
    functionName: 'execute', args: ['0x10', [payload], DEADLINE],
  });
}

const AMOUNT = 10n ** 18n; // 1 ATL / 1 MU
const sellData = urExecute(buildV4Payload(swapParamsFor(ATL, MU, AMOUNT, 0n), ATL, MU));
const buyData  = urExecute(buildV4Payload(swapParamsFor(MU, ATL, AMOUNT, 0n), MU, ATL));

// ---------- 3. state overrides: wallet holds 1000 ATL + unlimited Permit2 allowance ----------
const SLOT = atlSlot.slot;
const FAKE_BAL = 1000n * 10n ** 18n;
const balKey = keccak256(encodeAbiParameters(parseAbiParameters('address, uint256'), [getAddress(WALLET), SLOT]));
const overrides = {
  [ATL]: { stateDiff: { [balKey]: '0x' + FAKE_BAL.toString(16).padStart(64, '0') } },
  // Permit2: allowance[owner][token][spender] mapping-of-mapping: keccak(spender ++ keccak(token ++ owner))... compute below
};
// Permit2 allowance storage: mapping(address owner => mapping(address token => mapping(address spender => Allowance)))
// slot layout per Permit2 source: allowance slot 6? — probe instead: use Permit2 allowanceSlot via known derivation
// Allowance struct {uint160 amount; uint48 expiration; uint48 nonce} packed in one slot
const p2Key = keccak256(encodeAbiParameters(parseAbiParameters('address, uint256'), [getAddress(UR), BigInt(0)]))
// correct key: keccak256(abi.encode(token, keccak256(abi.encode(owner, SLOT_ALLOWANCE)))) then keccak with spender
console.log('stage2 built');

// ---------- 4. estimateGas both directions ----------
async function estimate(label, data) {
  try {
    const res = await c.request({ method: 'eth_estimateGas', params: [{ from: WALLET, to: UR, data, value: '0x0' }, 'latest', overrides] });
    console.log('PASS', label, 'gas =', BigInt(res).toString());
    return true;
  } catch (e) {
    console.log('FAIL:', String(e).slice(0, 400).replace(/\n/g, ' '));
    return false;
  }
}
await estimate('SELL 1 ATL -> MU', UR, sellData);
await estimate('BUY 1 MU -> ATLANTIS', UR, buyData);
console.log('done');
process.exit(0);
