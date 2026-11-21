import "server-only";

import { formatUnits, parseUnits, type Address } from "viem";

import { readAccount } from "../account-read";
import { riftMarketAbi } from "../abi/RiftMarket";
import { addresses, clients } from "../config";
import { fundingPerDay, liquidationMarkBps, marginHealth, newRiskBlocker } from "../market";
import { readMarket, readReactive } from "../reads";
import { computeRiskBand } from "../risk";
import { callVault, type VaultCall } from "./signer";
import type { ActionKind, AgentAction, Mode } from "./types";
import { readVault, type VaultState } from "./vault";

/**
 * The agent's tools, in a provider-neutral shape (each adapter converts them). Read tools return live
 * chain state. Action tools either become proposals the user signs (co-pilot) or run through the user's
 * RiftAgentVault with the agent key (autopilot), where the contract enforces the owner's limits.
 */

export type ToolDef = {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
};

export type ToolContext = {
  mode: Mode;
  /** Connected wallet (unverified: reads only). */
  account?: Address;
  /** Set when the caller proved control of `account` with a signed session. */
  verified?: Address;
  actions: AgentAction[];
};

const num = (description: string) => ({ type: "number", description });
const obj = (properties: Record<string, unknown>, required: string[]): ToolDef["parameters"] => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const TOOLS: ToolDef[] = [
  {
    name: "get_market",
    description:
      "Live state of the Rift market: perp mark, raw Unichain-Base spread, risk band and its drivers, pool value and utilization, open interest, funding, the cover price for 10k tUSD for 1 day, and whether the market is accepting new risk.",
    parameters: obj({}, []),
  },
  {
    name: "get_portfolio",
    description:
      "The user's holdings: their wallet (tUSD, open position with PnL and liquidation mark, pool shares, pending withdrawal) and their agent vault (balance, limits, what's left today, its position, shares, cover). Needs a connected wallet.",
    parameters: obj({}, []),
  },
  {
    name: "quote_cover",
    description: "Exact premium in tUSD for drain cover of `notional` tUSD over `days` days, at the current utilization and mark.",
    parameters: obj({ notional: num("Cover amount in tUSD, e.g. 1000"), days: num("Duration in days, 0.01-30") }, ["notional", "days"]),
  },
  {
    name: "get_recent_activity",
    description: "The user's latest on-chain events on this market (wallet and agent vault): cover, claims, positions, deposits, withdrawals.",
    parameters: obj({ limit: num("How many events, 1-30") }, ["limit"]),
  },
  {
    name: "buy_cover",
    description: "Buy drain protection that pays `notional` tUSD if the watched vault is drained within `days` days. Coverage starts after the market's cover delay.",
    parameters: obj({ notional: num("Cover amount in tUSD"), days: num("Duration in days, 0.01-30") }, ["notional", "days"]),
  },
  {
    name: "open_position",
    description:
      "Open a spread perp position. Long gains when the spread rises (Unichain priced above Base), short when it falls. Margin = size / leverage. One position per account.",
    parameters: obj(
      {
        side: { type: "string", enum: ["long", "short"] },
        size: num("Position size in tUSD"),
        leverage: num("1 to 10"),
      },
      ["side", "size", "leverage"],
    ),
  },
  { name: "close_position", description: "Close the open perp position and pay out its equity.", parameters: obj({}, []) },
  {
    name: "deposit",
    description: "Deposit tUSD into the underwriting pool for shares. The pool earns premiums and traders' losses and pays covered drains.",
    parameters: obj({ amount: num("tUSD to deposit") }, ["amount"]),
  },
  {
    name: "request_withdrawal",
    description: "Lock a percentage of pool shares for withdrawal. It completes after the 1-hour delay with complete_withdrawal.",
    parameters: obj({ percent: num("1 to 100") }, ["percent"]),
  },
  { name: "cancel_withdrawal", description: "Cancel the pending withdrawal request.", parameters: obj({}, []) },
  { name: "complete_withdrawal", description: "Complete an unlocked withdrawal request.", parameters: obj({}, []) },
  {
    name: "claim",
    description: "Claim a settled policy's payout or refund.",
    parameters: obj({ policy_id: num("Policy id") }, ["policy_id"]),
  },
];

const ACTIONS = new Set<string>(["buy_cover", "open_position", "close_position", "deposit", "request_withdrawal", "cancel_withdrawal", "complete_withdrawal", "claim"]);

// ---------------------------------------------------------------- formatting for the model

const t = (x: bigint, dp = 2) => Number(formatUnits(x, 18)).toFixed(dp);
const pct = (bps: bigint | number) => `${(Number(bps) / 100).toFixed(2)}%`;

function describePosition(p: { isLong: boolean; size: bigint; margin: bigint; entryMark: bigint; equity: bigint; pnl: bigint; funding: bigint }, markBps: bigint) {
  const liq = liquidationMarkBps({ ...p, fundingOwed: p.funding });
  return {
    side: p.isLong ? "long" : "short",
    size_tusd: t(p.size),
    margin_tusd: t(p.margin),
    entry_mark: pct(p.entryMark),
    mark_now: pct(markBps),
    unrealized_pnl_tusd: t(p.pnl),
    funding_paid_tusd: t(p.funding),
    equity_tusd: t(p.equity),
    margin_health: `${marginHealth(p.equity, p.size).toFixed(2)}x maintenance (1.00 = liquidatable)`,
    liquidation_mark: Number.isFinite(liq) ? pct(Math.round(liq)) : "n/a",
  };
}

function describeVault(v: VaultState, markBps: bigint) {
  const allowed = Object.entries({ trade: 1, protect: 2, underwrite: 4 })
    .filter(([, bit]) => v.limits.allowed & bit)
    .map(([k]) => k);
  return {
    address: v.address,
    agent_authorized: v.agentActive,
    paused: v.paused,
    balance_tusd: t(v.balance),
    limits: {
      max_spend_per_day_tusd: t(v.limits.maxSpendPerDay),
      max_notional_tusd: t(v.limits.maxNotional),
      max_leverage: v.limits.maxLeverage,
      max_agent_fee_per_day_tusd: t(v.limits.maxFeePerDay),
      allowed_actions: allowed,
    },
    left_today: { spend_tusd: t(v.spendLeft), fees_tusd: t(v.feesLeft) },
    position: v.position ? describePosition(v.position, markBps) : null,
    pool_shares: t(v.shares),
    pending_withdrawal: v.withdrawal ? { shares: t(v.withdrawal.shares), unlocks_at: new Date(Number(v.withdrawal.unlockAt) * 1000).toISOString() } : null,
    live_policy_ids: v.policyIds.map(String),
  };
}

// ---------------------------------------------------------------- read tools

async function getMarket() {
  const [m, r] = await Promise.all([readMarket(), readReactive()]);
  const band = computeRiskBand(m, r);
  return {
    accepting_new_risk: newRiskBlocker(m) === null,
    blocker: newRiskBlocker(m),
    tripped: m.tripped,
    perp_mark: pct(m.markBps),
    mark_age_seconds: Number(m.now - m.markReceivedAt),
    raw_spread: pct(r.spreadBps),
    smoothed_spread: pct(r.smoothedSpreadBps),
    trip_rule: `|spread| >= ${pct(r.params.tripSpreadBps)} sustained ${r.params.sustainSeconds}s AND vault outflow >= ${pct(r.params.tripOutflowBps)} within ${Number(r.params.windowSeconds) / 60} min`,
    vault_outflow_now: pct(r.outflowBps),
    risk_band: { level: band.level, headline: band.headline, drivers: band.drivers.map((d) => ({ check: d.label, level: d.level, value: d.value })) },
    pool: {
      value_tusd: t(m.poolValue),
      cash_tusd: t(m.poolAssets),
      utilization: `${((Number(m.utilizationWad) / 1e18) * 100).toFixed(1)}%`,
      share_price: m.totalShares > 0n ? (Number(m.poolValue) / Number(m.totalShares)).toFixed(4) : "1.0000",
    },
    open_interest: { long_tusd: t(m.openLongSize), short_tusd: t(m.openShortSize) },
    funding: m.markBps === 0n ? "none (spread flat)" : `${m.markBps > 0n ? "longs" : "shorts"} pay ${pct(m.markBps < 0n ? -m.markBps : m.markBps)} of size per day`,
    cover_quote_10k_1day_tusd: m.quote != null ? t(m.quote) : "no capacity",
    cover_delay_minutes: Number(m.coverDelay) / 60,
    max_leverage: 10,
  };
}

async function getPortfolio(ctx: ToolContext) {
  const who = ctx.verified ?? ctx.account;
  if (!who) return { error: "No wallet connected. Ask the user to connect one." };
  const [m, a, v] = await Promise.all([readMarket(), readAccount(who), readVault(who)]);
  return {
    wallet: {
      address: who,
      tusd: t(a.usd),
      eth_for_gas: Number(formatUnits(a.eth, 18)).toFixed(5),
      position: a.position ? describePosition(a.position, m.markBps) : null,
      pool_shares: t(a.shares),
      pending_withdrawal: a.withdrawal ? { shares: t(a.withdrawal.shares), unlocks_at: new Date(Number(a.withdrawal.unlockAt) * 1000).toISOString() } : null,
      live_policies: m.policies
        .filter((p) => p.buyer.toLowerCase() === who.toLowerCase())
        .map((p) => ({ id: String(p.id), notional_tusd: t(p.notional), active_at: new Date(Number(p.activeAt) * 1000).toISOString(), expiry: new Date(Number(p.expiry) * 1000).toISOString(), owed_tusd: t(p.owed), settled: p.settled })),
    },
    agent_vault: v ? describeVault(v, m.markBps) : null,
    mode: ctx.mode,
    autopilot_ready: !!(ctx.verified && v && v.agentActive && !v.paused),
  };
}

async function quoteCover(notional: bigint, seconds: bigint) {
  try {
    const premium = await clients.unichain.readContract({
      address: addresses.unichain.market,
      abi: riftMarketAbi,
      functionName: "quotePremium",
      args: [notional, seconds],
    });
    return { premium_tusd: t(premium, 4), notional_tusd: t(notional), days: Number(seconds) / 86400 };
  } catch {
    return { error: "No quote: the pool doesn't have capacity for that much cover right now." };
  }
}

async function recentActivity(ctx: ToolContext, limit: number) {
  const who = ctx.verified ?? ctx.account;
  if (!who) return { error: "No wallet connected." };
  const indexer = process.env.NEXT_PUBLIC_INDEXER_URL;
  if (!indexer) return { error: "History needs the indexer, which isn't configured here." };
  const v = await readVault(who).catch(() => null);
  const out: { at: string; owner: "wallet" | "vault"; event: string; tx: string; args: unknown }[] = [];
  for (const [owner, addr] of [["wallet", who], ...(v ? [["vault", v.address]] : [])] as ["wallet" | "vault", string][]) {
    const res = await fetch(`${indexer.replace(/\/$/, "")}/events?chain=1301&contract=market&account=${addr}&limit=${limit}`, { cache: "no-store" });
    if (!res.ok) continue;
    const body = (await res.json()) as { events: { ts: number; event: string; txHash: string; args: unknown }[] };
    for (const e of body.events) out.push({ at: new Date(e.ts * 1000).toISOString(), owner, event: e.event, tx: e.txHash, args: e.args });
  }
  return { events: out.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, limit) };
}

// ---------------------------------------------------------------- action tools

const amount = (x: unknown, what: string, max = 10_000_000) => {
  const n = Number(x);
  if (!Number.isFinite(n) || n <= 0 || n > max) throw new Error(`${what} must be a number above 0 and at most ${max.toLocaleString()}`);
  return parseUnits(n.toFixed(6), 18);
};

type Planned = { kind: ActionKind; params: AgentAction["params"]; summary: string; vaultCall: (target: Address) => Promise<VaultCall> };

async function plan(name: string, a: Record<string, unknown>): Promise<Planned> {
  switch (name) {
    case "buy_cover": {
      const notional = amount(a.notional, "notional");
      const days = Number(a.days);
      if (!(days >= 0.01 && days <= 30)) throw new Error("days must be between 0.01 and 30");
      const seconds = BigInt(Math.round(days * 86400));
      const q = await quoteCover(notional, seconds);
      return {
        kind: "buy_cover",
        params: { notional: formatUnits(notional, 18), days },
        summary: `Buy ${t(notional, 0)} tUSD of drain cover for ${days} day${days === 1 ? "" : "s"}${"premium_tusd" in q ? ` (premium ≈ ${q.premium_tusd} tUSD)` : ""}`,
        vaultCall: async () => ({ fn: "buyProtection", args: [notional, seconds] }),
      };
    }
    case "open_position": {
      const side = a.side === "short" ? "short" : a.side === "long" ? "long" : null;
      if (!side) throw new Error("side must be long or short");
      const size = amount(a.size, "size");
      const leverage = Math.round(Number(a.leverage));
      if (!(leverage >= 1 && leverage <= 10)) throw new Error("leverage must be 1 to 10");
      const margin = (size + BigInt(leverage) - 1n) / BigInt(leverage);
      const m = await readMarket();
      const fund = fundingPerDay(side === "long", size, m.markBps);
      return {
        kind: "open_position",
        params: { side, size: formatUnits(size, 18), leverage },
        summary: `Open a ${t(size, 0)} tUSD ${side} at ${leverage}× (${t(margin)} margin) at mark ${pct(m.markBps)}; funding now ${fund === 0n ? "none" : `${fund > 0n ? "pays" : "earns"} ${t(fund < 0n ? -fund : fund)} tUSD/day`}`,
        vaultCall: async () => ({ fn: "openPosition", args: [side === "long", size, margin] }),
      };
    }
    case "close_position":
      return { kind: "close_position", params: {}, summary: "Close the open position and pay out its equity", vaultCall: async () => ({ fn: "closePosition", args: [] }) };
    case "deposit": {
      const assets = amount(a.amount, "amount");
      return { kind: "deposit", params: { amount: formatUnits(assets, 18) }, summary: `Deposit ${t(assets)} tUSD into the underwriting pool`, vaultCall: async () => ({ fn: "deposit", args: [assets] }) };
    }
    case "request_withdrawal": {
      const p = Number(a.percent);
      if (!(p >= 1 && p <= 100)) throw new Error("percent must be 1 to 100");
      return {
        kind: "request_withdrawal",
        params: { percent: p },
        summary: `Request withdrawal of ${p}% of pool shares (unlocks after 1 hour)`,
        vaultCall: async (target) => {
          const shares = await clients.unichain.readContract({ address: addresses.unichain.market, abi: riftMarketAbi, functionName: "sharesOf", args: [target] });
          return { fn: "requestWithdraw", args: [(shares * BigInt(Math.round(p * 100))) / 10_000n] };
        },
      };
    }
    case "cancel_withdrawal":
      return { kind: "cancel_withdrawal", params: {}, summary: "Cancel the pending withdrawal request", vaultCall: async () => ({ fn: "cancelWithdraw", args: [] }) };
    case "complete_withdrawal":
      return { kind: "complete_withdrawal", params: {}, summary: "Complete the unlocked withdrawal", vaultCall: async () => ({ fn: "completeWithdraw", args: [] }) };
    case "claim": {
      const id = Number(a.policy_id);
      if (!Number.isInteger(id) || id < 0) throw new Error("policy_id must be a whole number");
      return { kind: "claim", params: { policyId: String(id) }, summary: `Claim policy #${id}`, vaultCall: async () => ({ fn: "claim", args: [BigInt(id)] }) };
    }
  }
  throw new Error(`unknown action ${name}`);
}

async function runAction(name: string, args: Record<string, unknown>, ctx: ToolContext) {
  const p = await plan(name, args);
  const id = `${Date.now().toString(36)}-${ctx.actions.length}`;
  if (ctx.mode === "copilot") {
    ctx.actions.push({ id, kind: p.kind, params: p.params, summary: p.summary, via: "wallet", status: "proposed" });
    return {
      status: "proposed",
      summary: p.summary,
      note: "Shown to the user as a card to review and sign in their wallet. It has NOT been executed; don't say it has.",
    };
  }
  // Autopilot: through the verified owner's vault, with the agent key. The vault contract enforces the limits.
  if (!ctx.verified) return { status: "rejected", reason: "Autopilot needs the user to sign a session first." };
  const v = await readVault(ctx.verified);
  if (!v) return { status: "rejected", reason: "The user has no agent vault yet. They can create one in the Agent screen." };
  const call = await p.vaultCall(v.address);
  const r = await callVault(v.address, call);
  const action: AgentAction = r.ok
    ? { id, kind: p.kind, params: p.params, summary: p.summary, via: "vault", status: "done", tx: r.tx }
    : { id, kind: p.kind, params: p.params, summary: p.summary, via: "vault", status: "rejected", reason: r.reason };
  ctx.actions.push(action);
  return r.ok ? { status: "done", summary: p.summary, tx: r.tx } : { status: "rejected", summary: p.summary, reason: r.reason };
}

// ---------------------------------------------------------------- dispatch

/** Runs one tool call; always resolves to a JSON-serialisable result (errors included) for the model. */
export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  try {
    if (ACTIONS.has(name)) return await runAction(name, args ?? {}, ctx);
    switch (name) {
      case "get_market":
        return await getMarket();
      case "get_portfolio":
        return await getPortfolio(ctx);
      case "quote_cover": {
        const days = Number(args.days);
        if (!(days >= 0.01 && days <= 30)) return { error: "days must be between 0.01 and 30" };
        return await quoteCover(amount(args.notional, "notional"), BigInt(Math.round(days * 86400)));
      }
      case "get_recent_activity":
        return await recentActivity(ctx, Math.min(30, Math.max(1, Math.round(Number(args.limit) || 10))));
    }
    return { error: `Unknown tool ${name}` };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export function systemPrompt(mode: Mode, account?: string) {
  return `You are Rift's trading agent, inside the Rift app on testnet (Unichain Sepolia, test tokens with no real value).

Rift has three products on one index, the price spread between twin pools on Unichain and Base:
- Protect: drain cover. Pays its notional if the watched Base vault is drained, which the market detects when |spread| stays past the trip threshold AND the vault's outflow passes its threshold. Payouts are fixed in the trip transaction, seconds after the drain, settled by Reactive Network.
- Trade: a perp on the spread, up to 10x. Long gains when the spread rises. Funding: longs pay when the mark is positive, shorts when negative. One position per account; there's no add-margin, so rebalancing means closing and reopening at a new size, leverage or side, or hedging with cover.
- Underwrite: deposit into the pool that sells cover and is every trader's counterparty. Withdrawals take two steps with a 1-hour delay.

How you work:
- Always read live state with tools before giving numbers or recommending anything. Never invent prices, balances or limits.
- Amounts are in tUSD. Be concise and concrete: say what you'd do, why, the numbers, and the main risk.
- Mode now: ${mode === "copilot"
    ? "CO-PILOT. Action tools create proposals the user reviews and signs in their wallet. Nothing executes until they sign. Say 'I've proposed …', never 'I've done …'."
    : "AUTOPILOT. Action tools execute immediately from the user's agent vault with your key. The vault contract enforces the owner's limits (daily spend, size, leverage, allowed actions); if a call is rejected, explain the limit and suggest what fits. Act only on what the user asked for or clearly approved; for anything large or irreversible, confirm first."}
- If an action fails, report the exact reason the tool returned.
- This is a testnet demo, not financial advice; say so briefly only if the user asks for advice on real funds.
${account ? `Connected wallet: ${account}` : "No wallet is connected."}`;
}

export const isActionTool = (name: string) => ACTIONS.has(name);
