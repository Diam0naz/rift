import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import {
  coinbaseWallet,
  injectedWallet,
  metaMaskWallet,
  rabbyWallet,
  rainbowWallet,
  walletConnectWallet,
} from "@rainbow-me/rainbowkit/wallets";
import { http, createConfig } from "wagmi";
import { unichainSepolia } from "wagmi/chains";
import { mock } from "wagmi/connectors";

import { rpc } from "./config";

/**
 * Users only ever sign on Unichain Sepolia (RiftMarket and its collateral token live there).
 *
 * Wallets: RainbowKit's picker. Installed browser wallets (MetaMask, Phantom, Rabby, ...) are discovered
 * automatically (EIP-6963). With NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID set (a free Reown project ID), mobile
 * and QR-code wallets work too; without it, only browser-extension wallets are offered.
 *
 * NEXT_PUBLIC_E2E=1 adds a mock connector for automated browser tests against a local anvil fork: it has no
 * keys of its own and forwards eth_sendTransaction to the chain's default RPC, where anvil signs for its
 * unlocked test account. It is never included in a normal build.
 */
const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
const e2e = process.env.NEXT_PUBLIC_E2E === "1";
const e2eAccount = process.env.NEXT_PUBLIC_E2E_ACCOUNT as `0x${string}` | undefined;

export const WALLETCONNECT_ENABLED = !!projectId;

// In E2E mode the chain's default RPC must be the fork, because the mock connector sends there. Not done
// otherwise: wallets copy rpcUrls.default when adding the network, and a keyed RPC URL set for the
// dashboard's reads shouldn't end up in users' wallets.
const unichain = e2e ? { ...unichainSepolia, rpcUrls: { default: { http: [rpc.unichain] } } } : unichainSepolia;

const walletConnectors = connectorsForWallets(
  projectId
    ? [
        { groupName: "Popular", wallets: [metaMaskWallet, rabbyWallet, coinbaseWallet, rainbowWallet] },
        { groupName: "Other", wallets: [walletConnectWallet, injectedWallet] },
      ]
    : [{ groupName: "Browser wallets", wallets: [injectedWallet] }],
  // The project ID is only used by WalletConnect-based wallets, which are left out when it's missing.
  { appName: "Rift", projectId: projectId ?? "walletconnect-disabled" },
);

export const wagmiConfig = createConfig({
  chains: [unichain],
  connectors: [...walletConnectors, ...(e2e && e2eAccount ? [mock({ accounts: [e2eAccount] })] : [])],
  transports: { [unichain.id]: http(rpc.unichain) },
  ssr: true,
});

export const MARKET_CHAIN_ID = unichain.id;
export const E2E = e2e;

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
