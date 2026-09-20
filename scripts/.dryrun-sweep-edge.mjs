/** Edge case: SCW holds exactly N ETH → sweep sends ALL of it (SCW left at 0). */
import { createPublicClient, createWalletClient, http, encodeFunctionData, parseAbi, toHex, parseEther, formatEther, getAddress } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { mainnet } from "viem/chains";
import { predictModularAccountV2Address } from "@account-kit/smart-contracts";

const ANVIL = "http://127.0.0.1:8545";
const FACTORY = "0x00000000000017c61b5bEe81050EC8eFc9c6fecd";
const pub = createPublicClient({ chain: mainnet, transport: http(ANVIL) });
const owner = privateKeyToAccount(generatePrivateKey());
const scwAddress = getAddress(predictModularAccountV2Address({ factoryAddress: FACTORY, implementationAddress: "0x000000000000c5A9089039570Dd36455b5C07383", salt: 0n, type: "SMA", ownerAddress: owner.address }));
await pub.request({ method: "anvil_setBalance", params: [owner.address, toHex(parseEther("1"))] });
await pub.request({ method: "anvil_setBalance", params: [scwAddress, toHex(parseEther("0.0173"))] }); // exact, no dust
const beneficiary = getAddress("0xbeef00000000000000000000000000000000beef");
const ownerWallet = createWalletClient({ account: owner, chain: mainnet, transport: http(ANVIL) });
const factoryAbi = parseAbi(["function createSemiModularAccount(address owner, uint256 salt) returns (address)"]);
const depHash = await ownerWallet.sendTransaction({ to: FACTORY, data: encodeFunctionData({ abi: factoryAbi, functionName: "createSemiModularAccount", args: [owner.address, 0n] }), gas: 200000n });
await pub.waitForTransactionReceipt({ hash: depHash });

const FULL = await pub.getBalance({ address: scwAddress });
console.log("[edge] SCW balance:", formatEther(FULL), "ETH — sweeping 100%");
const scwAbi = parseAbi(["function execute(address target, uint256 value, bytes data)"]);
const h = await ownerWallet.sendTransaction({
  to: scwAddress,
  data: encodeFunctionData({ abi: scwAbi, functionName: "execute", args: [beneficiary, FULL, "0x"] }),
  gas: 200000n,
});
const r = await pub.waitForTransactionReceipt({ hash: h });
const bAfter = await pub.getBalance({ address: beneficiary });
const sAfter = await pub.getBalance({ address: scwAddress });
console.log("[edge] status:", r.status, " beneficiary got:", formatEther(bAfter - 0n), " SCW left:", formatEther(sAfter));
if (r.status === "success" && sAfter === 0n && bAfter === FULL) console.log("\n✅ 100.0000% SWEEP WORKS — SCW left at exactly 0.\n");
else throw new Error("edge case failed");
