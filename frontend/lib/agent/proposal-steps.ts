import { maxUint256, parseUnits, type Address } from "viem";

import { mockTokenAbi } from "../abi/MockToken";
import { riftMarketAbi } from "../abi/RiftMarket";
import { addresses, clients } from "../config";
import type { FlowStep } from "../tx";
import type { AgentAction } from "./types";

const market = { address: addresses.unichain.market, abi: riftMarketAbi } as const;
const token = { address: addresses.unichain.collateral, abi: mockTokenAbi } as const;

/** Approve step, skipped when the market can already take `needed`. */
const approve = (owner: Address, needed: () => Promise<bigint>): FlowStep => ({
  label: "Approve tUSD",
  explain: "Lets RiftMarket take the tUSD for this action. Skipped if it already can.",
  call: { ...token, functionName: "approve", args: [addresses.unichain.market, maxUint256] },
  skip: async () => (await clients.unichain.readContract({ ...token, functionName: "allowance", args: [owner, addresses.unichain.market] })) >= (await needed()),
});

const wad = (s?: string) => parseUnits(s ?? "0", 18);

/** The wallet transactions that carry out a co-pilot proposal, signed by the user. */
export function stepsFor(a: AgentAction, owner: Address): FlowStep[] {
  const p = a.params;
  switch (a.kind) {
    case "buy_cover": {
      const notional = wad(p.notional);
      const seconds = BigInt(Math.round((p.days ?? 1) * 86400));
      const premium = () => clients.unichain.readContract({ ...market, functionName: "quotePremium", args: [notional, seconds] });
      return [
        approve(owner, premium),
        { label: "Buy cover", explain: a.summary, call: { ...market, functionName: "buyProtection", args: [notional, seconds] } },
      ];
    }
    case "open_position": {
      const size = wad(p.size);
      const lev = BigInt(p.leverage ?? 1);
      const margin = (size + lev - 1n) / lev;
      return [
        approve(owner, async () => margin),
        { label: `Open ${p.side}`, explain: a.summary, call: { ...market, functionName: "openPosition", args: [p.side === "long", size, margin] } },
      ];
    }
    case "close_position":
      return [{ label: "Close position", explain: a.summary, call: { ...market, functionName: "closePosition" } }];
    case "deposit": {
      const assets = wad(p.amount);
      return [
        approve(owner, async () => assets),
        { label: "Deposit", explain: a.summary, call: { ...market, functionName: "deposit", args: [assets] } },
      ];
    }
    case "request_withdrawal":
      return [
        {
          label: "Request withdrawal",
          explain: a.summary,
          // Shares are read when the step runs, so the percentage is of what the wallet holds then.
          call: { ...market, functionName: "requestWithdraw", args: [0n] },
          prepare: async () => {
            const shares = await clients.unichain.readContract({ ...market, functionName: "sharesOf", args: [owner] });
            return { ...market, functionName: "requestWithdraw", args: [(shares * BigInt(Math.round((p.percent ?? 0) * 100))) / 10_000n] };
          },
        },
      ];
    case "cancel_withdrawal":
      return [{ label: "Cancel withdrawal", explain: a.summary, call: { ...market, functionName: "cancelWithdraw" } }];
    case "complete_withdrawal":
      return [{ label: "Withdraw", explain: a.summary, call: { ...market, functionName: "completeWithdraw" } }];
    case "claim":
      return [{ label: "Claim", explain: a.summary, call: { ...market, functionName: "claim", args: [BigInt(p.policyId ?? "0")] } }];
  }
}
