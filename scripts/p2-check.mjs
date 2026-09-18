import { createPublicClient, http, parseAbi, parseAbiParameters, encodeAbiParameters, getAddress, keccak256 } from 'viem';

const c = createPublicClient({ transport: http('https://rpc.mainnet.chain.robinhood.com') });
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const UR = '0x8876789976decbfcbbbe364623c63652db8c0904';
const PROXY = '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be';
const ATL = '0x26915c10e8Ce9fb86B836fE8B129A1c5c3771E18';
const SELLER = '0x217C05f5D1D1E595BBae94534540B803bfC4563B';

// read Permit2 allowance via the contract (amount, expiration, nonce)
const ABI = parseAbi(['function allowance(address,address,address) view returns (uint160 amount, uint48 expiration, uint48 nonce)']);
for (const [label, spender] of [['UR', UR], ['RelayProxy', PROXY]]) {
  const a = await c.readContract({ address: PERMIT2, abi: ABI, functionName: 'allowance', args: [SELLER, getAddress(ATL), getAddress(spender)] });
  console.log(`Permit2 allowance seller ATL -> ${label}:`, Array.isArray(a) ? a.map(x => x.toString()).join(', ') : JSON.stringify(a));
}
process.exit(0);
