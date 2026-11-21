"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import type { Abi, ContractFunctionArgs, ContractFunctionName, Hash } from "viem";
import { useAccount, useWriteContract } from "wagmi";

import { mockTokenAbi } from "./abi/MockToken";
import { clients } from "./config";
import { describeError } from "./errors";
import { MARKET_CHAIN_ID } from "./wagmi";

/** Token errors (e.g. ERC20InsufficientBalance) can surface through any market call; decode them too. */
const tokenErrors = mockTokenAbi.filter((x) => x.type === "error");

/**
 * Gas headroom over the estimate. Estimates are exact for the state they ran against, but funding accrues
 * every second, so a close mined a second later can take an extra storage write and run out of gas without it.
 */
const GAS_BUFFER_PCT = 125n;

export type Call<
  abi extends Abi = Abi,
  fn extends ContractFunctionName<abi, "nonpayable" | "payable"> = ContractFunctionName<abi, "nonpayable" | "payable">,
> = {
  address: `0x${string}`;
  abi: abi;
  functionName: fn;
  args?: ContractFunctionArgs<abi, "nonpayable" | "payable", fn>;
};

type Phase = "simulating" | "signing" | "pending";

export type TxState =
  | { status: "idle" }
  | { status: Phase; label: string; hash?: Hash }
  | { status: "success"; label: string; hash: Hash; block: bigint }
  | { status: "error"; label: string; message: string; hash?: Hash };

/**
 * Sends one call end to end: simulate (a revert shows its reason before the wallet opens), estimate gas
 * with headroom, sign, wait for the receipt. Reports progress through `onPhase`.
 */
function useSend() {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  return useCallback(
    async (call: Call, onPhase: (p: Phase, hash?: Hash) => void): Promise<{ hash: Hash; block: bigint }> => {
      if (!address) throw new Error("Connect a wallet first.");
      onPhase("simulating");
      const withErrors = { ...call, abi: [...call.abi, ...tokenErrors], account: address };
      await clients.unichain.simulateContract(withErrors as Parameters<typeof clients.unichain.simulateContract>[0]);
      const estimate = await clients.unichain.estimateContractGas(
        withErrors as Parameters<typeof clients.unichain.estimateContractGas>[0],
      );
      onPhase("signing");
      const hash = await writeContractAsync({
        ...call,
        chainId: MARKET_CHAIN_ID,
        gas: (estimate * GAS_BUFFER_PCT) / 100n,
      } as Parameters<typeof writeContractAsync>[0]);
      onPhase("pending", hash);
      const receipt = await clients.unichain.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw Object.assign(new Error("The transaction reverted on-chain."), { hash });
      return { hash, block: receipt.blockNumber };
    },
    [address, writeContractAsync],
  );
}

/** One action (claim, faucet, close...). */
export function useTx() {
  const send = useSend();
  const queryClient = useQueryClient();
  const [state, setState] = useState<TxState>({ status: "idle" });

  const run = useCallback(
    async <abi extends Abi, fn extends ContractFunctionName<abi, "nonpayable" | "payable">>(
      label: string,
      call: Call<abi, fn>,
    ): Promise<boolean> => {
      let hash: Hash | undefined;
      try {
        const r = await send(call as unknown as Call, (status, h) => {
          if (h) hash = h;
          setState({ status, label, hash: h });
        });
        setState({ status: "success", label, hash: r.hash, block: r.block });
        await queryClient.invalidateQueries();
        return true;
      } catch (err) {
        setState({ status: "error", label, message: describeError(err), hash });
        return false;
      }
    },
    [send, queryClient],
  );

  const busy = state.status === "simulating" || state.status === "signing" || state.status === "pending";
  return { run, state, busy, reset: () => setState({ status: "idle" }) };
}

// ---------------------------------------------------------------- multi-step flows

export type FlowStep = {
  /** Short label, e.g. "Approve tUSD". */
  label: string;
  /** What signing this step does, in plain words (shown before the wallet opens). */
  explain: string;
  call: Call;
  /** Checked right before the step runs; true skips it (e.g. allowance already sufficient). */
  skip?: () => boolean | Promise<boolean>;
  /** Builds the call right before it runs, when its arguments depend on state at that moment. */
  prepare?: () => Promise<Call>;
};

export type StepState =
  | { status: "waiting" | "skipped" }
  | { status: Phase; hash?: Hash }
  | { status: "done"; hash: Hash; block: bigint }
  | { status: "failed"; message: string; hash?: Hash };

/**
 * Runs a sequence of signatures (e.g. approve, then buy) with per-step progress, and retry from the step
 * that failed. Used by the TxFlow component.
 */
export function useTxFlow() {
  const send = useSend();
  const queryClient = useQueryClient();
  const [steps, setSteps] = useState<FlowStep[]>([]);
  const [states, setStates] = useState<StepState[]>([]);
  const [running, setRunning] = useState(false);
  const stepsRef = useRef<FlowStep[]>([]);

  const runFrom = useCallback(
    async (list: FlowStep[], start: number, initial: StepState[]): Promise<boolean> => {
      setRunning(true);
      const next = [...initial];
      const update = (i: number, s: StepState) => {
        next[i] = s;
        setStates([...next]);
      };
      try {
        for (let i = start; i < list.length; i++) {
          const step = list[i];
          if (step.skip && (await step.skip())) {
            update(i, { status: "skipped" });
            continue;
          }
          let hash: Hash | undefined;
          try {
            const call = step.prepare ? await step.prepare() : step.call;
            const r = await send(call, (status, h) => {
              if (h) hash = h;
              update(i, { status, hash: h });
            });
            update(i, { status: "done", hash: r.hash, block: r.block });
          } catch (err) {
            update(i, { status: "failed", message: describeError(err), hash });
            return false;
          }
        }
        await queryClient.invalidateQueries();
        return true;
      } finally {
        setRunning(false);
      }
    },
    [send, queryClient],
  );

  const start = useCallback(
    (list: FlowStep[]) => {
      stepsRef.current = list;
      setSteps(list);
      const initial: StepState[] = list.map(() => ({ status: "waiting" }));
      setStates(initial);
      return runFrom(list, 0, initial);
    },
    [runFrom],
  );

  const retry = useCallback(() => {
    const failedAt = states.findIndex((s) => s.status === "failed");
    if (failedAt < 0) return Promise.resolve(false);
    const initial = states.map((s, i) => (i >= failedAt ? ({ status: "waiting" } as StepState) : s));
    setStates(initial);
    return runFrom(stepsRef.current, failedAt, initial);
  }, [states, runFrom]);

  const done = states.length > 0 && states.every((s) => s.status === "done" || s.status === "skipped");
  const failed = states.some((s) => s.status === "failed");
  const reset = () => {
    setSteps([]);
    setStates([]);
  };
  return { start, retry, reset, steps, states, running, done, failed };
}
