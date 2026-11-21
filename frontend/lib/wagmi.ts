import { http, createConfig } from "wagmi";
import { unichainSepolia } from "wagmi/chains";
import { injected, mock } from "wagmi/connectors";

import { rpc } from "./config";

/**
 * Users only ever sign on Unichain Sepolia (RiftMarket and its collateral token live there).
 *
 * NEXT_PUBLIC_E2E=1 adds a mock connector for automated browser tests against a local anvil fork:
 * it has no keys of its own and forwards eth_sendTransaction to the chain's default RPC, where anvil
 * signs for its unlocked test account. It is never included in a normal build.
 */
const e2e = process.env.NEXT_PUBLIC_E2E === "1";
const e2eAccount = process.env.NEXT_PUBLIC_E2E_ACCOUNT as `0x${string}` | undefined;

// In E2E mode the chain's default RPC must be the fork, because the mock connector sends there.
// Not done otherwise: wallets copy rpcUrls.default when adding the network, and a keyed RPC URL
// set for the dashboard's reads shouldn't end up in users' wallets.
const unichain = e2e ? { ...unichainSepolia, rpcUrls: { default: { http: [rpc.unichain] } } } : unichainSepolia;

export const wagmiConfig = createConfig({
  chains: [unichain],
  connectors: [injected(), ...(e2e && e2eAccount ? [mock({ accounts: [e2eAccount] })] : [])],
  transports: { [unichain.id]: http(rpc.unichain) },
  ssr: true,
});

export const MARKET_CHAIN_ID = unichain.id;

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
