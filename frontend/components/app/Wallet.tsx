"use client";

import { ConnectButton, useConnectModal } from "@rainbow-me/rainbowkit";
import { useEffect, useState } from "react";
import { useAccount, useConnect, useSwitchChain, useWatchAsset } from "wagmi";

import { mockTokenAbi } from "@/lib/abi/MockToken";
import { useAccountState } from "@/lib/account";
import { addresses } from "@/lib/config";
import { fmtToken, shortHex } from "@/lib/format";
import { useTx } from "@/lib/tx";
import { E2E, MARKET_CHAIN_ID } from "@/lib/wagmi";

import { TxStatus } from "./TxFlow";

/**
 * The header wallet control, in the site's style, driven by RainbowKit's state:
 * not connected → opens RainbowKit's sheet (installed wallets, rejected/pending requests handled there);
 * wrong network → one-click switch; connected → address + balance, opens the account sheet.
 */
export function WalletButton() {
  return (
    <ConnectButton.Custom>
      {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
        if (!mounted) return <span className="btn-ghost btn-sm opacity-0" aria-hidden>Connect wallet</span>;
        if (!account || !chain) {
          return (
            <div className="flex items-center gap-2">
              <button type="button" className="btn-brutal btn-sm" onClick={openConnectModal}>
                Connect wallet
              </button>
              {E2E && <TestWalletButton />}
            </div>
          );
        }
        if (chain.unsupported || chain.id !== MARKET_CHAIN_ID) {
          return (
            <button type="button" className="btn-brutal btn-sm" onClick={openChainModal}>
              Switch to Unichain
            </button>
          );
        }
        return (
          <button type="button" className="btn-ghost btn-sm" onClick={openAccountModal} aria-label="Wallet account">
            <span className="live-dot !h-1.5 !w-1.5" style={{ background: "var(--ok)" }} aria-hidden />
            {account.displayName}
            {account.displayBalance && <span className="opacity-60">· {account.displayBalance}</span>}
          </button>
        );
      }}
    </ConnectButton.Custom>
  );
}

/** E2E builds only: connects the anvil-backed mock connector. */
function TestWalletButton() {
  const { connectors, connect } = useConnect();
  const mock = connectors.find((c) => c.type === "mock");
  if (!mock) return null;
  return (
    <button type="button" className="btn-ghost btn-sm" onClick={() => connect({ connector: mock })}>
      Test wallet
    </button>
  );
}

/** Opens RainbowKit's connect sheet; for "Connect to buy" style CTAs inside forms. */
export function ConnectCta({ children = "Connect wallet" }: { children?: string }) {
  const { openConnectModal } = useConnectModal();
  return (
    <button type="button" className="btn-brutal btn-sm" onClick={openConnectModal}>
      {children}
    </button>
  );
}

/** Balances and the test-token faucet, shown under the page header when connected. */
export function AccountBar() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const { address, isConnected, chainId } = useAccount();
  const acct = useAccountState(isConnected && chainId === MARKET_CHAIN_ID ? address : undefined);
  const tx = useTx();
  if (!mounted || !isConnected) return null;
  const a = acct.data;
  return (
    <div
      className="app-panel mb-8 flex flex-wrap items-center justify-between gap-4 px-5 py-4"
      aria-label="Your balances"
    >
      <div className="flex flex-wrap gap-8">
        <div>
          <div className="kicker !text-[0.62rem]">tUSD</div>
          <div className="mono mt-1 text-lg">{a ? fmtToken(a.usd) : "…"}</div>
        </div>
        <div>
          <div className="kicker !text-[0.62rem]">ETH · gas</div>
          <div className="mono mt-1 text-lg" style={{ color: a && a.eth === 0n ? "var(--rift)" : undefined }}>
            {a ? fmtToken(a.eth, 4) : "…"}
          </div>
        </div>
        <div>
          <div className="kicker !text-[0.62rem]">Pool shares</div>
          <div className="mono mt-1 text-lg">{a ? fmtToken(a.shares) : "…"}</div>
        </div>
      </div>
      <div className="flex flex-col items-end gap-1">
        <button
          type="button"
          className="btn-ghost btn-sm"
          disabled={tx.busy || !a}
          onClick={() =>
            tx.run("Faucet", { address: addresses.unichain.collateral, abi: mockTokenAbi, functionName: "faucet" })
          }
        >
          Get {a ? fmtToken(a.faucetAmount, 0) : "10,000"} test tUSD
        </button>
        <TxStatus state={tx.state} />
        <AddTokenButton />
      </div>
    </div>
  );
}

/**
 * Imports tUSD into the connected wallet (EIP-747 wallet_watchAsset) on Unichain Sepolia, switching network
 * first if needed. Wallets only list a custom token after it's imported, and only on the right network.
 * The address stays visible with a copy button for wallets that don't support the request.
 */
function AddTokenButton() {
  const { chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { watchAssetAsync } = useWatchAsset();
  const [state, setState] = useState<{ kind: "idle" | "busy" | "added" | "error"; msg?: string }>({ kind: "idle" });
  const [copied, setCopied] = useState(false);
  const token = addresses.unichain.collateral;

  const add = async () => {
    setState({ kind: "busy" });
    try {
      if (chainId !== MARKET_CHAIN_ID) await switchChainAsync({ chainId: MARKET_CHAIN_ID });
      const ok = await watchAssetAsync({ type: "ERC20", options: { address: token, symbol: "tUSD", decimals: 18 } });
      setState(ok ? { kind: "added" } : { kind: "error", msg: "Your wallet didn't add it. Use the address below." });
    } catch (err) {
      const msg = err instanceof Error && /reject|denied/i.test(err.message) ? "You dismissed the request." : "Your wallet doesn't support adding tokens this way. Use the address below.";
      setState({ kind: "error", msg });
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked: the address is visible to copy by hand.
    }
  };

  return (
    <div className="flex flex-col items-end gap-1 pt-1">
      <button type="button" className="btn-ghost btn-sm" onClick={add} disabled={state.kind === "busy"}>
        {state.kind === "added" ? "tUSD added ✓" : state.kind === "busy" ? "Check your wallet…" : "Add tUSD to wallet"}
      </button>
      <span className="mono flex items-center gap-2 text-xs text-muted" aria-live="polite">
        {state.kind === "error" && <span style={{ color: "var(--warn)" }}>{state.msg}</span>}
        <span title={token}>tUSD {shortHex(token, 4)} · Unichain Sepolia (1301)</span>
        <button type="button" className="underline underline-offset-4 hover:text-[var(--bone)]" onClick={copy}>
          {copied ? "copied" : "copy"}
        </button>
      </span>
    </div>
  );
}
