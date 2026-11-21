import "server-only";

import { createWalletClient, http, type Abi, type Address, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { unichainSepolia } from "viem/chains";

import { mockTokenAbi } from "../abi/MockToken";
import { riftAgentVaultAbi } from "../abi/RiftAgentVault";
import { riftMarketAbi } from "../abi/RiftMarket";
import { clients, rpc } from "../config";
import { describeError } from "../errors";

/**
 * The agent's own key (AGENT_PRIVATE_KEY, server-only). It can do nothing on its own: RiftAgentVault lets
 * it call the market only through a user's vault, inside that user's limits, and pay itself only up to
 * the user's daily fee cap. A leaked key is bounded by those same limits, and owners can pause or revoke it.
 */

const errorsOnly = (abi: Abi) => abi.filter((x) => x.type === "error");
// Reverts from the market and the token bubble up through the vault: decode all three.
const vaultAbi = [...riftAgentVaultAbi, ...errorsOnly(riftMarketAbi as Abi), ...errorsOnly(mockTokenAbi as Abi)] as const;

export function agentAccount() {
  const pk = process.env.AGENT_PRIVATE_KEY;
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) return null;
  return privateKeyToAccount(pk as `0x${string}`);
}

export const agentConfigured = () => agentAccount() !== null;

export type VaultCall =
  | { fn: "openPosition"; args: [boolean, bigint, bigint] }
  | { fn: "closePosition"; args: [] }
  | { fn: "buyProtection"; args: [bigint, bigint] }
  | { fn: "claim"; args: [bigint] }
  | { fn: "deposit"; args: [bigint] }
  | { fn: "requestWithdraw"; args: [bigint] }
  | { fn: "cancelWithdraw"; args: [] }
  | { fn: "completeWithdraw"; args: [] }
  | { fn: "chargeFee"; args: [bigint, string] };

export type VaultResult = { ok: true; tx: Hash } | { ok: false; reason: string };

/**
 * Simulates first, so a limit or market rule comes back as a plain reason without spending gas, then
 * sends and waits for the receipt. One call at a time per process: the agent key's nonce is shared.
 */
let queue: Promise<unknown> = Promise.resolve();
export function callVault(vault: Address, call: VaultCall): Promise<VaultResult> {
  const run = async (): Promise<VaultResult> => {
    const account = agentAccount();
    if (!account) return { ok: false, reason: "The agent key isn't configured on this server." };
    const c = clients.unichain;
    try {
      const { request } = await c.simulateContract({
        account,
        address: vault,
        abi: vaultAbi,
        functionName: call.fn,
        args: call.args as never,
      });
      const gas = await c.estimateContractGas({ ...request, account } as never);
      const wallet = createWalletClient({ account, chain: unichainSepolia, transport: http(rpc.unichain) });
      const tx = await wallet.writeContract({ ...request, gas: (gas * 125n) / 100n } as never);
      const receipt = await c.waitForTransactionReceipt({ hash: tx, timeout: 60_000 });
      if (receipt.status !== "success") return { ok: false, reason: `The transaction reverted (${tx}).` };
      return { ok: true, tx };
    } catch (e) {
      return { ok: false, reason: describeError(e) };
    }
  };
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}
