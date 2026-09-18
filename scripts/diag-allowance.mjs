import { readFileSync } from "fs";
for (const line of readFileSync(".env","utf8").split("\n")) { const m = line.match(/^([^#=\s][^=]*)=(.*)$/); if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g,""); }
const { getChain, httpClient } = await import("../chains.mjs");
const { resolveSigner } = await import("../signer.mjs");
const dep = getChain("base");
const signer = await resolveSigner("base");
const ERC20 = [{name:'allowance',type:'function',stateMutability:'view',inputs:[{type:'address'},{type:'address'}],outputs:[{type:'uint256'}]}];
const wethAllowance = await httpClient("base").readContract({ address: dep.weth, abi: ERC20, functionName: 'allowance', args: [signer.address, dep.v3.swapRouter02] });
console.log('WETH allowance to SwapRouter02:', wethAllowance.toString());
