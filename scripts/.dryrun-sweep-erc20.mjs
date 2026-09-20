/** ERC-20 direct execute: owner calls execute(WETH, 0, transfer(beneficiary, amt)) on the SCW. */
import { createPublicClient, createWalletClient, http, encodeFunctionData, parseAbi, toHex, parseEther, formatEther, formatUnits, getAddress } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { mainnet } from "viem/chains";
import { predictModularAccountV2Address } from "@account-kit/smart-contracts";

const ANVIL = "http://127.0.0.1:8545";
const FACTORY = "0x00000000000017c61b5bEe81050EC8eFc9c6fecd";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const pub = createPublicClient({ chain: mainnet, transport: http(ANVIL) });
const owner = privateKeyToAccount(generatePrivateKey());
const scwAddress = getAddress(predictModularAccountV2Address({ factoryAddress: FACTORY, implementationAddress: "0x000000000000c5A9089039570Dd36455b5C07383", salt: 0n, type: "SMA", ownerAddress: owner.address }));
await pub.request({ method: "anvil_setBalance", params: [owner.address, toHex(parseEther("2"))] });
await pub.request({ method: "anvil_setBalance", params: [scwAddress, toHex(parseEther("0.01"))] });
const beneficiary = getAddress("0xbeef00000000000000000000000000000000beef");
const ownerWallet = createWalletClient({ account: owner, chain: mainnet, transport: http(ANVIL) });
const factoryAbi = parseAbi(["function createSemiModularAccount(address owner, uint256 salt) returns (address)"]);
const depHash = await ownerWallet.sendTransaction({ to: FACTORY, data: encodeFunctionData({ abi: factoryAbi, functionName: "createSemiModularAccount", args: [owner.address, 0n] }), gas: 200000n });
await pub.waitForTransactionReceipt({ hash: depHash });

const weth = parseAbi(["function deposit() payable", "function transfer(address to, uint256 amount) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
// owner wraps 1 ETH → WETH, sends 1 WETH to the SCW
await ownerWallet.sendTransaction({ to: WETH, data: encodeFunctionData({ abi: weth, functionName: "deposit" }), value: parseEther("1"), gas: 100000n });
await ownerWallet.sendTransaction({ to: WETH, data: encodeFunctionData({ abi: weth, functionName: "transfer", args: [scwAddress, parseEther("1")] }), gas: 100000n });
console.log("[erc20] SCW WETH:", formatUnits(await pub.readContract({ address: WETH, abi: weth, functionName: "balanceOf", args: [scwAddress] }), 18));

const scwAbi = parseAbi(["function execute(address target, uint256 value, bytes data)"]);
const callData = encodeFunctionData({ abi: weth, functionName: "transfer", args: [beneficiary, parseEther("1")] });
const h = await ownerWallet.sendTransaction({ to: scwAddress, data: encodeFunctionData({ abi: scwAbi, functionName: "execute", args: [WETH, 0n, callData] }), gas: 200000n });
const r = await pub.waitForTransactionReceipt({ hash: h });
const got = await pub.readContract({ address: WETH, abi: weth, functionName: "balanceOf", args: [beneficiary] });
console.log("[erc20] status:", r.status, " beneficiary WETH:", formatUnits(got, 18));
if (r.status === "success" && got === parseEther("1")) console.log("\n✅ ERC-20 DIRECT EXECUTE WORKS — token sweeps can also skip the EntryPoint.\n");
else throw new Error("erc20 direct execute failed");
