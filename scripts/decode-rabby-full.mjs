import { createPublicClient, http, parseAbi, decodeFunctionData, formatUnits } from 'viem';
import { readFileSync } from 'fs';
const data = readFileSync('/tmp/rabby-calldata.txt', 'utf8').trim();

const abi = parseAbi([
  'function transferAndMulticall(address[] tokens, uint256[] amounts, (address target, bool isDelegateCall, uint256 value, bytes data)[] calls, address p1, address p2, bytes extra) payable',
]);

const decoded = decodeFunctionData({ abi, data });
console.log('== tokens ==', decoded.args.tokens);
console.log('== amounts ==', decoded.args.amounts.map(a => a.toString()));
console.log('== p1 ==', decoded.args.p1);
console.log('== p2 ==', decoded.args.p2);
console.log('== extra.len ==', decoded.args.extra.length, decoded.args.extra.slice(0, 80));
console.log('== calls ==', decoded.args.calls.length);
decoded.args.calls.forEach((call, i) => {
  console.log(`\n--- call[${i}] target=${call.target} delegate=${call.isDelegateCall} value=${call.value}`);
  console.log('data.len =', (call.data.length - 2) / 2);
  console.log('data[0..10] =', call.data.slice(0, 10));
});
process.exit(0);
