import type { Abi, Address } from "viem";

// ABIs are generated into the frontend (frontend/scripts/export-abis.mjs); both packages read the same files.
import { mockVaultAbi } from "../../frontend/lib/abi/MockVault.ts";
import { riftMarketAbi } from "../../frontend/lib/abi/RiftMarket.ts";
import { riftPoolAbi } from "../../frontend/lib/abi/RiftPool.ts";
import { riftReactiveAbi } from "../../frontend/lib/abi/RiftReactive.ts";

export type Contract = { name: string; address: Address; abi: Abi; fromBlock: bigint };

export type Chain = {
  key: "unichain" | "base" | "lasna";
  id: number;
  name: string;
  rpc: string;
  /** Widest eth_getLogs range the RPC accepts. Public limits: Unichain 1,000, Base 200, Lasna 30,000. */
  chunk: bigint;
  /** Stay this many blocks behind head so a shallow reorg can't leave a dropped event in the index. */
  confirmations: bigint;
  /** Requests in flight at once (the public RPCs rate-limit). */
  concurrency: number;
  contracts: Contract[];
};

const env = (k: string) => process.env[k] || undefined;
const big = (k: string, d: bigint) => (env(k) ? BigInt(env(k)!) : d);

/** Current deployment (README, "Deployed addresses & transaction hashes"); start blocks from broadcast/. */
export const CHAINS: Chain[] = [
  {
    key: "unichain",
    id: 1301,
    name: "Unichain Sepolia",
    rpc: env("UNICHAIN_SEPOLIA_RPC") ?? "https://sepolia.unichain.org",
    chunk: big("UNICHAIN_CHUNK", 1000n),
    confirmations: big("UNICHAIN_CONFIRMATIONS", 2n),
    concurrency: 3,
    contracts: [
      { name: "market", address: "0x45c96DC6c9f5C5A8CFe0Ac8B88DCD7F49b16Bcb0", abi: riftMarketAbi as Abi, fromBlock: big("UNICHAIN_FROM_BLOCK", 68318062n) },
      { name: "unichainPool", address: "0x3bE5C66453dB2b55412Bf96b4F2df46F34e239ce", abi: riftPoolAbi as Abi, fromBlock: big("UNICHAIN_FROM_BLOCK", 68318003n) },
    ],
  },
  {
    key: "base",
    id: 84532,
    name: "Base Sepolia",
    rpc: env("BASE_SEPOLIA_RPC") ?? "https://sepolia.base.org",
    chunk: big("BASE_CHUNK", 200n),
    confirmations: big("BASE_CONFIRMATIONS", 2n),
    concurrency: 4,
    contracts: [
      { name: "basePool", address: "0xA5aB34c37F2d8C8f86a32BA007F6e421D0B5315D", abi: riftPoolAbi as Abi, fromBlock: big("BASE_FROM_BLOCK", 61242644n) },
      { name: "vault", address: "0xCC83d90035bea5b69d3358479F046781146353e3", abi: mockVaultAbi as Abi, fromBlock: big("BASE_FROM_BLOCK", 61242649n) },
    ],
  },
  {
    key: "lasna",
    id: 5318007,
    name: "Reactive Lasna",
    rpc: env("LASNA_RPC") ?? "https://lasna-rpc.rnk.dev/",
    chunk: big("LASNA_CHUNK", 30000n),
    confirmations: big("LASNA_CONFIRMATIONS", 0n),
    concurrency: 2,
    contracts: [
      { name: "reactive", address: "0xAD0983eBF145C8f8184bf219E795aC63fEE58B78", abi: riftReactiveAbi as Abi, fromBlock: big("LASNA_FROM_BLOCK", 8804462n) },
    ],
  },
];

/** INDEX_CHAINS=unichain,base limits which chains are followed (the E2E run indexes only its fork). */
export function enabledChains(): Chain[] {
  const only = env("INDEX_CHAINS")?.split(",").map((s) => s.trim());
  return only ? CHAINS.filter((c) => only.includes(c.key)) : CHAINS;
}
