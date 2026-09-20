
  export const CHAIN_KEYS = ["ethereum"];
  export function getChain() {
    return {
      name: "Ethereum", viemChain: {}, httpRpc: () => "http://stub",
      dollar: "0x" + "a".repeat(40), dollarDecimals: 6,
      imdToken: "0x" + "b".repeat(40), imdDecimals: 18, imdSymbol: "IMD",
    };
  }
  export async function getEthUsdPriceFor() { return 4000; }
