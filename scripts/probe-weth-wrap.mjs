/** Test: does Robinhood WETH support deposit()? Does UR WRAP work? (read-only) */
import { createPublicClient, http, parseEther, parseAbi, encodeFunctionData, encodeAbiParameters, parseAbiParameters, getAddress } from "viem";
const key = process.env.ALCHEMY_API_KEY;
const url = key ? `https://robinhood-mainnet.g.alchemy.com/v2/${key}` : "https://rpc.mainnet.chain.robinhood.com";
const c = createPublicClient({ transport: http(url) });
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const signer = getAddress("0xa71Fb297aa443aDfc22Ff74981D8C067ec3475Cb");
const UR = "0x8876789976decbfcbbbe364623c63652db8c0904";
const EX = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
const wrapInput = (recipient) => encodeAbiParameters(parseAbiParameters("uint256 amount, address recipient"), [parseEther("0.001"), recipient]);

// 1) direct deposit() — the standard WETH9 interface
try {
  const gas = await c.estimateContractGas({ address: WETH, abi: parseAbi(["function deposit() payable"]), functionName: "deposit", value: parseEther("0.001"), account: signer });
  console.log("1. WETH.deposit():                PASS  gas", gas.toString());
} catch (e) { console.log("1. WETH.deposit():                FAIL —", String(e.message).slice(0, 140)); }

// 2) UR WRAP alone, recipient = router (what the fixed code does)
try {
  const data = encodeFunctionData({ abi: EX, functionName: "execute", args: ["0x0c", [wrapInput(UR)], BigInt(Math.floor(Date.now() / 1000) + 300)] });
  const gas = await c.estimateGas({ to: UR, data, value: parseEther("0.001"), account: signer });
  console.log("2. UR WRAP alone → router:        PASS  gas", gas.toString());
} catch (e) { console.log("2. UR WRAP alone → router:        FAIL —", String(e.message).slice(0, 140)); }

// 3) UR WRAP alone, recipient = user (what the buggy code did)
try {
  const data = encodeFunctionData({ abi: EX, functionName: "execute", args: ["0x0c", [wrapInput(signer)], BigInt(Math.floor(Date.now() / 1000) + 300)] });
  const gas = await c.estimateGas({ to: UR, data, value: parseEther("0.001"), account: signer });
  console.log("3. UR WRAP alone → user wallet:   PASS  gas", gas.toString());
} catch (e) { console.log("3. UR WRAP alone → user wallet:   FAIL —", String(e.message).slice(0, 140)); }
