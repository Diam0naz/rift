import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from "viem";

import { fmtDuration } from "./risk";

/** Plain-language reasons for RiftMarket's and the token's custom errors. */
const reasons: Record<string, (args: readonly unknown[]) => string> = {
  IsTripped: () => "The market has tripped. New cover, positions and deposits are closed; claims and withdrawals still work.",
  NoMark: () => "No mark has reached the market yet, so it can't price new risk.",
  StaleMark: ([age]) =>
    `The last mark is ${fmtDuration(Number(age))} old. The market stops taking new risk until RiftReactive sends a fresh one.`,
  InsufficientLiquidity: () => "The pool doesn't have enough free capacity for this.",
  TooManyPolicies: () => "The market is at its 64 live policy limit. Try again after some expire.",
  BadDuration: () => "Duration must be between 1 minute and 30 days.",
  ZeroAmount: () => "Enter an amount above zero.",
  PositionExists: () => "You already have an open position. Close it before opening another.",
  NoPosition: () => "You don't have an open position.",
  TooMuchLeverage: () => "Size is more than 10× your margin.",
  NotLiquidatable: () => "That position is above maintenance margin, so it can't be liquidated.",
  NothingToClaim: () => "Nothing to claim on this policy.",
  WithdrawPending: () => "You already have a withdrawal request. Complete or cancel it first.",
  NoWithdrawRequest: () => "You don't have a withdrawal request.",
  WithdrawLocked: ([unlockAt]) =>
    `Your withdrawal unlocks at ${new Date(Number(unlockAt) * 1000).toLocaleTimeString()}.`,
  InsufficientShares: () => "You don't have that many pool shares.",
  PoolInsolvent: () => "The pool's value is zero, so new deposits can't be priced.",
  ERC20InsufficientBalance: () => "Not enough tUSD in your wallet. Use the faucet to get some.",
  ERC20InsufficientAllowance: () => "The market isn't approved to spend that much tUSD yet.",
  SafeCastOverflowedUintDowncast: () => "That amount is too large.",
};

/** A short, human message for any error thrown while simulating or sending a transaction. */
export function describeError(err: unknown): string {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return "You rejected the request in your wallet.";
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName;
      if (name && reasons[name]) return reasons[name](reverted.data?.args ?? []);
      if (name) return `The contract rejected this (${name}).`;
      if (reverted.reason) return reverted.reason;
    }
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}
