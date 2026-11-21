import { createPublicClient, defineChain, http, type Address } from "viem";
import { baseSepolia, unichainSepolia } from "viem/chains";

export const lasna = defineChain({
  id: 5318007,
  name: "Reactive Lasna",
  nativeCurrency: { name: "Lasna REACT", symbol: "lREACT", decimals: 18 },
  rpcUrls: { default: { http: ["https://lasna-rpc.rnk.dev/"] } },
  blockExplorers: { default: { name: "Reactscan", url: "https://lasna.reactscan.net" } },
});

const rpc = {
  base: process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC ?? "https://sepolia.base.org",
  unichain: process.env.NEXT_PUBLIC_UNICHAIN_SEPOLIA_RPC ?? "https://sepolia.unichain.org",
  lasna: process.env.NEXT_PUBLIC_LASNA_RPC ?? "https://lasna-rpc.rnk.dev/",
};

// Base and Unichain have Multicall3, so viem batches reads into one call. Lasna doesn't,
// so its reads go out as one batched JSON-RPC request instead.
export const clients = {
  base: createPublicClient({ chain: baseSepolia, transport: http(rpc.base), batch: { multicall: true } }),
  unichain: createPublicClient({
    chain: unichainSepolia,
    // The public endpoint rate-limits (HTTP 429); back off and retry instead of failing the poll.
    transport: http(rpc.unichain, { retryCount: 5, retryDelay: 600 }),
    batch: { multicall: true },
  }),
  lasna: createPublicClient({ chain: lasna, transport: http(rpc.lasna, { batch: true }) }),
};

/** Current deployment (README, "Deployed addresses & transaction hashes"). */
export const addresses = {
  base: {
    pool: "0xA5aB34c37F2d8C8f86a32BA007F6e421D0B5315D",
    vault: "0xCC83d90035bea5b69d3358479F046781146353e3",
    vaultAsset: "0x540bd620182C67b3A83375259EA11a1037DC7F58",
  },
  unichain: {
    pool: "0x3bE5C66453dB2b55412Bf96b4F2df46F34e239ce",
    market: "0x45c96DC6c9f5C5A8CFe0Ac8B88DCD7F49b16Bcb0",
    collateral: "0x7595790414E2C73ADAF3fcC70d8F07055fDDBeAA",
  },
  lasna: {
    reactive: "0xAD0983eBF145C8f8184bf219E795aC63fEE58B78",
  },
} as const satisfies Record<string, Record<string, Address>>;

/** Block the market was deployed in; event history is read from here. */
export const MARKET_DEPLOY_BLOCK = 68318062n;

/** Unichain's public RPC rejects eth_getLogs ranges over 1,000 blocks. */
export const LOG_CHUNK = 1000n;

export const explorers = {
  base: "https://sepolia.basescan.org",
  unichain: "https://sepolia.uniscan.xyz",
  lasna: "https://lasna.reactscan.net",
} as const;

export const POLL_MS = 4000;
