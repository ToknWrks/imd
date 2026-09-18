import { createPublicClient, http, parseAbi, parseAbiParameters, encodeFunctionData, encodeAbiParameters, getAddress, keccak256 } from 'viem';

const c = createPublicClient({ transport: http('https://rpc.mainnet.chain.robinhood.com') });
const UR = '0x8876789976decbfcbbbe364623c63652db8c0904';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const PROXY = '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be';
const MU   = '0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD';
const ATL  = '0x26915c10e8Ce9fb86B836fE8B129A1c5c3771E18';
const HOOK = '0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544';
const SELLER = '0x217C05f5D1D1E595BBae94534540B803bfC4563B';
const DEADLINE = BigInt(Math.floor(Date.now() / 0x1000 + 600));

const ERC20_ABI = parseAbi(['function allowance(address,address) view returns (uint256)']);

// Check the seller's allowances (who can pull their ATLANTIS?)
for (const [label, spender] of [['Permit2', PERMIT2], ['RelayProxy', PROXY], ['UR', UR]]) {
  const a = await c.readContract({ address: ATL, abi: ERC20_ABI, functionName: 'allowance', args: [SELLER, getAddress(spender)] });
  console.log('seller ATL allowance ->', label, a.toString());
}

// Where does the hook expect swaps from? probe hook for beforeSwap selector etc.
// Permit2 allowance slot: mapping at slot 2? — Permit2's AllowanceTransfer allowance slot = 2? Actually:
// Permit2 AllowanceTransfer: mapping(address => mapping(address => mapping(address => Allowance))) at slot 1? (from source: slot 2)
// Use probe: compute keccak(spender, keccak(token, keccak(owner, 1))) and keccak(...,2), read both
const wn = (x) => BigInt(x).toString(16).padStart(64, '0');
const ad = (a) => getAddress(a).slice(2).toLowerCase().padStart(64, '0');
for (const baseSlot of [0, 1, 2, 3, 4, 5, 6]) {
  const inner = keccak256(encodeAbiParameters(parseAbiParameters('address, uint256'), [getAddress(SELLER), BigInt(baseSlot)]));
  const middle = keccak256(encodeAbiParameters(parseAbiParameters('address, uint256'), [getAddress(ATL), BigInt('0x' + inner.slice(2), 16)]));
  const key = keccak256(encodeAbiParameters(parseAbiParameters('address, uint256'), [getAddress(UR), BigInt('0x' + middle.slice(2), 16)]));
  const raw = await c.getStorageAt({ address: PERMIT2, slot: key });
  const amount = BigInt('0x' + raw.slice(2, 34)) & ((1n << 160n) - 1n);
  if (amount > 0n) console.log(`Permit2 slot base=${baseSlot}: UR allowance amount = ${amount}`);
}
console.log('done');
process.exit(0);
