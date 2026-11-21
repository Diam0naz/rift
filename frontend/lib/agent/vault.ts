import { zeroAddress, type Address } from "viem";

import { mockTokenAbi } from "../abi/MockToken";
import { riftAgentVaultAbi } from "../abi/RiftAgentVault";
import { riftAgentVaultFactoryAbi } from "../abi/RiftAgentVaultFactory";
import { riftMarketAbi } from "../abi/RiftMarket";
import { addresses, clients } from "../config";

/** Runs in the browser (vault panel) and on the server (the agent's tools). */

export const factory = { address: addresses.agent.factory, abi: riftAgentVaultFactoryAbi } as const;
const market = { address: addresses.unichain.market, abi: riftMarketAbi } as const;
const token = { address: addresses.unichain.collateral, abi: mockTokenAbi } as const;

export const ALLOW = { trade: 1, protect: 2, underwrite: 4 } as const;

export type VaultLimits = {
  maxSpendPerDay: bigint;
  maxNotional: bigint;
  maxFeePerDay: bigint;
  maxLeverage: number;
  allowed: number;
};

export type VaultState = {
  address: Address;
  agent: Address;
  agentActive: boolean;
  paused: boolean;
  balance: bigint;
  limits: VaultLimits;
  spendLeft: bigint;
  feesLeft: bigint;
  position: { isLong: boolean; size: bigint; margin: bigint; entryMark: bigint; equity: bigint; pnl: bigint; funding: bigint } | null;
  shares: bigint;
  withdrawal: { shares: bigint; unlockAt: bigint } | null;
  policyIds: bigint[];
};

export async function vaultAddressOf(owner: Address): Promise<Address | null> {
  const v = await clients.unichain.readContract({ ...factory, functionName: "vaultOf", args: [owner] });
  return v === zeroAddress ? null : v;
}

/** The owner's vault and everything the agent and the panel need about it, or null if there isn't one. */
export async function readVault(owner: Address): Promise<VaultState | null> {
  const address = await vaultAddressOf(owner);
  if (!address) return null;
  const c = clients.unichain;
  const vault = { address, abi: riftAgentVaultAbi } as const;
  const [agent, paused, limits, remaining, balance, position, equity, shares, request, policyIds] = await Promise.all([
    c.readContract({ ...vault, functionName: "agent" }),
    c.readContract({ ...vault, functionName: "paused" }),
    c.readContract({ ...vault, functionName: "limits" }),
    c.readContract({ ...vault, functionName: "remainingToday" }),
    c.readContract({ ...token, functionName: "balanceOf", args: [address] }),
    c.readContract({ ...market, functionName: "positions", args: [address] }),
    c.readContract({ ...market, functionName: "equityOf", args: [address] }),
    c.readContract({ ...market, functionName: "sharesOf", args: [address] }),
    c.readContract({ ...market, functionName: "withdrawRequests", args: [address] }),
    c.readContract({ ...market, functionName: "activePolicyIds" }),
  ]);
  const [maxSpendPerDay, maxNotional, maxFeePerDay, maxLeverage, allowed] = limits;
  const [open, isLong, size, margin, entryMark] = position;
  const [eq, pnl, funding] = equity;
  const [lockedShares, unlockAt] = request;
  const mine = await Promise.all(
    policyIds.map(async (id) => ({ id, p: await c.readContract({ ...market, functionName: "policy", args: [id] }) })),
  );
  return {
    address,
    agent,
    agentActive: agent !== zeroAddress,
    paused,
    balance,
    limits: { maxSpendPerDay, maxNotional, maxFeePerDay, maxLeverage, allowed },
    spendLeft: remaining[0],
    feesLeft: remaining[1],
    position: open ? { isLong, size, margin, entryMark, equity: eq, pnl, funding } : null,
    shares,
    withdrawal: lockedShares > 0n ? { shares: lockedShares, unlockAt } : null,
    policyIds: mine.filter((x) => x.p.buyer.toLowerCase() === address.toLowerCase()).map((x) => x.id),
  };
}
