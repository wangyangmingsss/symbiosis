/**
 * X Layer chain configuration for SYMBIOSIS agent economy.
 * X Layer is OKX's L2 built on Polygon CDK (zkEVM).
 */

export interface ChainConfig {
  name: string;
  chainId: number;
  rpcUrl: string;
  blockTimeMs: number;
  nativeToken: string;
  explorerUrl: string;
}

/** X Layer Mainnet (Chain ID 196) */
export const XLAYER_MAINNET: ChainConfig = {
  name: "X Layer Mainnet",
  chainId: 196,
  rpcUrl: "https://rpc.xlayer.tech",
  blockTimeMs: 1000, // ~1 second block time
  nativeToken: "OKB",
  explorerUrl: "https://www.oklink.com/xlayer",
};

/** X Layer Testnet (Chain ID 1952) */
export const XLAYER_TESTNET: ChainConfig = {
  name: "X Layer Testnet",
  chainId: 1952,
  rpcUrl: "https://testrpc.xlayer.tech",
  blockTimeMs: 1000,
  nativeToken: "OKB",
  explorerUrl: "https://www.okx.com/web3/explorer/xlayer-test",
};

/**
 * Select chain config based on NETWORK env var.
 * Defaults to testnet for safety.
 */
export function getChainConfig(): ChainConfig {
  const network = process.env.NETWORK ?? "testnet";
  return network === "mainnet" ? XLAYER_MAINNET : XLAYER_TESTNET;
}
