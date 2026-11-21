"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { Abi, ContractFunctionArgs, ContractFunctionName, Hash } from "viem";
import { useAccount, useWriteContract } from "wagmi";

import { mockTokenAbi } from "./abi/MockToken";
import { clients } from "./config";
import { describeError } from "./errors";
import { MARKET_CHAIN_ID } from "./wagmi";

export type TxState =
  | { status: "idle" }
  | { status: "simulating"; label: string }
  | { status: "signing"; label: string }
  | { status: "pending"; label: string; hash: Hash }
  | { status: "success"; label: string; hash: Hash }
  | { status: "error"; label: string; message: string; hash?: Hash };

type Call<abi extends Abi, fn extends ContractFunctionName<abi, "nonpayable" | "payable">> = {
  address: `0x${string}`;
  abi: abi;
  functionName: fn;
  args?: ContractFunctionArgs<abi, "nonpayable" | "payable", fn>;
};

/** Token errors (e.g. ERC20InsufficientBalance) can surface through any market call; decode them too. */
const tokenErrors = mockTokenAbi.filter((x) => x.type === "error");

/**
 * Gas headroom over the estimate. Estimates are exact for the state they ran against, but funding
 * accrues every second, so a close mined a second later can take an extra storage write and run out
 * of gas without it.
 */
const GAS_BUFFER_PCT = 125n;

/**
 * Runs one contract write end to end: simulate (so a revert shows its reason before anything is
 * signed), send, wait for the receipt, then refresh every query so the dashboard shows the result.
 * One instance tracks one action's progress.
 */
export function useTx() {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const queryClient = useQueryClient();
  const [state, setState] = useState<TxState>({ status: "idle" });

  const run = useCallback(
    async <abi extends Abi, fn extends ContractFunctionName<abi, "nonpayable" | "payable">>(
      label: string,
      call: Call<abi, fn>,
    ): Promise<boolean> => {
      if (!address) {
        setState({ status: "error", label, message: "Connect a wallet first." });
        return false;
      }
      let hash: Hash | undefined;
      try {
        setState({ status: "simulating", label });
        // Pre-flight: throws with the decoded revert reason before the wallet is involved.
        const withErrors = { ...call, abi: [...call.abi, ...tokenErrors], account: address };
        await clients.unichain.simulateContract(withErrors as Parameters<typeof clients.unichain.simulateContract>[0]);
        const estimate = await clients.unichain.estimateContractGas(
          withErrors as Parameters<typeof clients.unichain.estimateContractGas>[0],
        );
        setState({ status: "signing", label });
        hash = await writeContractAsync({
          ...call,
          chainId: MARKET_CHAIN_ID,
          gas: (estimate * GAS_BUFFER_PCT) / 100n,
        } as Parameters<typeof writeContractAsync>[0]);
        setState({ status: "pending", label, hash });
        const receipt = await clients.unichain.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error("The transaction reverted on-chain.");
        setState({ status: "success", label, hash });
        await queryClient.invalidateQueries();
        return true;
      } catch (err) {
        setState({ status: "error", label, message: describeError(err), hash });
        return false;
      }
    },
    [address, writeContractAsync, queryClient],
  );

  const busy = state.status === "simulating" || state.status === "signing" || state.status === "pending";
  return { run, state, busy, reset: () => setState({ status: "idle" }) };
}
