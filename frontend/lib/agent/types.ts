/** Shared by the agent API (server) and the chat screen (browser). */

export type Provider = "gemini" | "claude";

/** co-pilot: actions become proposals the user signs. autopilot: the agent executes them through the vault. */
export type Mode = "copilot" | "autopilot";

export type ActionKind =
  | "buy_cover"
  | "open_position"
  | "close_position"
  | "deposit"
  | "request_withdrawal"
  | "cancel_withdrawal"
  | "complete_withdrawal"
  | "claim";

/** One action the agent took or proposed. Amounts are human tUSD strings ("1000.5"). */
export type AgentAction = {
  id: string;
  kind: ActionKind;
  params: {
    notional?: string;
    days?: number;
    side?: "long" | "short";
    size?: string;
    leverage?: number;
    amount?: string;
    percent?: number;
    policyId?: string;
  };
  summary: string;
  via: "wallet" | "vault";
  status: "proposed" | "done" | "rejected";
  tx?: string;
  reason?: string;
};

/** Proof that the caller controls `address`, signed once per day in the wallet (EIP-191). */
export type Session = { address: `0x${string}`; expires: number; signature: `0x${string}` };

export const sessionMessage = (address: string, expires: number) =>
  `Rift agent session\n\nAddress: ${address}\nExpires: ${new Date(expires * 1000).toISOString()}\n\nSigning this lets the Rift agent act for this address within your vault's limits. It costs nothing.`;

export type ChatRequest = {
  provider: Provider;
  mode: Mode;
  /** Connected wallet, if any (read-only context). */
  account?: `0x${string}`;
  /** Required for autopilot and the premium model. */
  session?: Session;
  /** The provider's native history from earlier turns, returned by the server as-is. */
  history?: unknown[];
  message: string;
};

export type ChatResponse = {
  provider: Provider;
  model: string;
  reply: string;
  history: unknown[];
  actions: AgentAction[];
  fee?: { amount: string; tx: string };
};

export type AgentConfig = {
  providers: {
    gemini: { available: boolean; model: string };
    claude: { available: boolean; model: string; premium: true; feePerMessage: string };
  };
  autopilot: {
    available: boolean;
    agent: string | null;
    factory: string;
    /** The background runner on this server. */
    background: { running: boolean; intervalSec: number; lastRunAt: number | null; lastError: string | null };
  };
};
