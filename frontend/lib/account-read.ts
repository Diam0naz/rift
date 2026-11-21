import type { Address } from "viem";

import { mockTokenAbi } from "./abi/MockToken";
import { riftMarketAbi } from "./abi/RiftMarket";
import { addresses, clients } from "./config";

const market = { address: addresses.unichain.market, abi: riftMarketAbi } as const;
const token = { address: addresses.unichain.collateral, abi: mockTokenAbi } as const;

/** Everything about one wallet the action forms need, read in one Multicall. */
export async function readAccount(user: Address) {
  const c = clients.unichain;
  const [eth, usd, allowance, shares, request, position, equity, withdrawDelay, maxLeverage, faucetAmount] =
    await Promise.all([
      c.getBalance({ address: user }),
      c.readContract({ ...token, functionName: "balanceOf", args: [user] }),
      c.readContract({ ...token, functionName: "allowance", args: [user, addresses.unichain.market] }),
      c.readContract({ ...market, functionName: "sharesOf", args: [user] }),
      c.readContract({ ...market, functionName: "withdrawRequests", args: [user] }),
      c.readContract({ ...market, functionName: "positions", args: [user] }),
      c.readContract({ ...market, functionName: "equityOf", args: [user] }),
      c.readContract({ ...market, functionName: "WITHDRAW_DELAY" }),
      c.readContract({ ...market, functionName: "MAX_LEVERAGE" }),
      c.readContract({ ...token, functionName: "FAUCET_AMOUNT" }),
    ]);
  const [lockedShares, unlockAt] = request;
  const [open, isLong, size, margin, entryMark] = position;
  const [eq, pnl, funding] = equity;
  return {
    eth,
    usd,
    allowance,
    shares,
    withdrawal: lockedShares > 0n ? { shares: lockedShares, unlockAt } : null,
    position: open ? { isLong, size, margin, entryMark, equity: eq, pnl, funding } : null,
    withdrawDelay,
    maxLeverage,
    faucetAmount,
  };
}

export type AccountState = Awaited<ReturnType<typeof readAccount>>;
