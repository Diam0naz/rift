"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { formatUnits, parseUnits, type Address } from "viem";
import { useAccount } from "wagmi";

import { mockTokenAbi } from "@/lib/abi/MockToken";
import { riftAgentVaultAbi } from "@/lib/abi/RiftAgentVault";
import { useAccountState } from "@/lib/account";
import { stepsFor } from "@/lib/agent/proposal-steps";
import { useAgentSession } from "@/lib/agent/session";
import type { AgentAction, AgentConfig, ChatRequest, ChatResponse, Mode, Provider } from "@/lib/agent/types";
import { ALLOW, factory, readVault, type VaultState } from "@/lib/agent/vault";
import { addresses, explorers } from "@/lib/config";
import { fmtToken, shortHex } from "@/lib/format";
import { useTx, useTxFlow } from "@/lib/tx";
import { MARKET_CHAIN_ID } from "@/lib/wagmi";

import { Card, Skeleton } from "../../ui";
import { AutopilotRules } from "../AutopilotRules";
import { PageHeader } from "../AppShell";
import { Field, Rows } from "../bits";
import { TxFlowView, TxStatus } from "../TxFlow";
import { ConnectCta } from "../Wallet";

type Line = { role: "user" | "agent" | "note"; text: string; actions?: AgentAction[]; fee?: ChatResponse["fee"]; model?: string };

const SUGGESTIONS = [
  "How's the market right now, and what's the risk?",
  "What's in my portfolio?",
  "Quote 5,000 tUSD of cover for 2 days",
  "Open a 1,000 tUSD long at 3x",
  "Hedge my position",
  "Should I underwrite? Deposit 500 if it makes sense",
];

const useConfig = () =>
  useQuery({
    queryKey: ["agent-config"],
    queryFn: async () => (await (await fetch("/api/agent")).json()) as AgentConfig,
    staleTime: 60_000,
  });

const useVault = (owner?: Address) =>
  useQuery({ queryKey: ["agent-vault", owner], queryFn: () => readVault(owner!), enabled: !!owner, refetchInterval: 8_000 });

export function AgentScreen() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const { address, isConnected, chainId } = useAccount();
  const owner = mounted && isConnected && chainId === MARKET_CHAIN_ID ? address : undefined;
  const config = useConfig();
  const vault = useVault(owner);
  const session = useAgentSession();

  return (
    <>
      <PageHeader
        kicker="07 / Agent · co-pilot and autopilot"
        title="Agent"
        intro="Ask about the market, your positions and cover. In co-pilot it proposes and you sign. In autopilot it acts from your agent vault, inside limits the contract enforces."
      />
      <div className="grid gap-5 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-8">
          <Chat config={config.data} owner={owner} vault={vault.data ?? null} session={session} />
        </div>
        <div className="space-y-5 lg:col-span-4">
          <VaultPanel config={config.data} owner={owner} vault={vault.data} loading={vault.isLoading} session={session} />
          {owner && vault.data && <AutopilotRules session={session} />}
          <HowItWorks />
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- chat

function Chat({
  config,
  owner,
  vault,
  session,
}: {
  config?: AgentConfig;
  owner?: Address;
  vault: VaultState | null;
  session: ReturnType<typeof useAgentSession>;
}) {
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState<Provider>("gemini");
  const [mode, setMode] = useState<Mode>("copilot");
  const [lines, setLines] = useState<Line[]>([]);
  const [history, setHistory] = useState<Record<Provider, unknown[]>>({ gemini: [], claude: [] });
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  // Braces matter: newer browsers return a Promise from scrollIntoView, and React would call it as a cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [lines.length, busy]);

  const premium = config?.providers.claude;
  const autopilotBlock = !owner
    ? "Connect a wallet to use autopilot."
    : !config?.autopilot.available
      ? "Autopilot isn't enabled on this server."
      : !vault
        ? "Create an agent vault (right) to use autopilot."
        : !vault.agentActive
          ? "The agent is revoked on your vault. Re-enable it to use autopilot."
          : vault.paused
            ? "Your vault is paused. Unpause it to use autopilot."
            : null;
  const premiumBlock = !premium?.available
    ? "The premium model isn't enabled on this server."
    : !owner
      ? "Connect a wallet to use the premium model."
      : !vault
        ? `Premium is paid from your agent vault (${premium.feePerMessage} tUSD per message). Create one first.`
        : null;

  const pickProvider = (p: Provider) => {
    if (p === provider) return;
    setProvider(p);
    if (lines.length) setLines((l) => [...l, { role: "note", text: `Switched to ${p === "claude" ? "Claude (premium)" : "Gemini"}. It starts with a fresh context.` }]);
  };

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    setInput("");
    setLines((l) => [...l, { role: "user", text: message }]);
    setBusy(true);
    try {
      let s = session.session;
      if ((mode === "autopilot" || provider === "claude") && !s) {
        setLines((l) => [...l, { role: "note", text: "Sign the agent session in your wallet (free, no transaction)." }]);
        s = await session.sign();
        if (!s) {
          setLines((l) => [...l, { role: "note", text: "Not sent: the session wasn't signed." }]);
          return;
        }
      }
      const body: ChatRequest = { provider, mode, account: owner, session: s ?? undefined, history: history[provider], message };
      const res = await fetch("/api/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json()) as ChatResponse & { error?: string; actions?: AgentAction[] };
      if (!res.ok) {
        setLines((l) => [...l, { role: "note", text: data.error ?? `Request failed (${res.status}).`, actions: data.actions, fee: data.fee }]);
        return;
      }
      setHistory((h) => ({ ...h, [provider]: data.history }));
      setLines((l) => [...l, { role: "agent", text: data.reply, actions: data.actions, fee: data.fee, model: data.model }]);
      if (data.actions.some((a) => a.status === "done") || data.fee) await queryClient.invalidateQueries();
    } catch {
      setLines((l) => [...l, { role: "note", text: "Couldn't reach the agent. Check your connection and try again." }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card index="A" ticks title="Ask Rift" subtitle={config ? `${provider === "claude" ? config.providers.claude.model : config.providers.gemini.model} · ${mode}` : "…"}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Choice
          label="Model"
          value={provider}
          onChange={pickProvider}
          options={[
            { value: "gemini", title: "Gemini", sub: "default · free", disabled: config && !config.providers.gemini.available ? "Not configured on this server." : null },
            { value: "claude", title: "Claude", sub: premium ? `premium · ${premium.feePerMessage} tUSD/msg` : "premium", disabled: premiumBlock },
          ]}
        />
        <Choice
          label="Mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: "copilot", title: "Co-pilot", sub: "you sign each action", disabled: null },
            { value: "autopilot", title: "Autopilot", sub: "acts from your vault", disabled: autopilotBlock },
          ]}
        />
      </div>
      {mode === "autopilot" && vault && (
        <p className="mt-3 text-xs text-muted">
          Autopilot can spend {fmtToken(vault.spendLeft, 0)} more tUSD today, up to {fmtToken(vault.limits.maxNotional, 0)} per action at {vault.limits.maxLeverage}× max. The vault
          contract rejects anything over that.
        </p>
      )}

      <div className="mt-5 max-h-[60vh] min-h-[16rem] space-y-4 overflow-y-auto border p-4" style={{ borderColor: "var(--line)", background: "var(--ink-3)" }} aria-live="polite">
        {lines.length === 0 && (
          <div>
            <p className="text-sm text-muted">Try one of these, or ask anything about Rift.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="btn-ghost btn-sm !normal-case !tracking-normal" onClick={() => void send(s)} disabled={busy}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {lines.map((l, i) => (
          <Message key={i} line={l} owner={owner} />
        ))}
        {busy && (
          <p className="mono text-xs text-muted" role="status">
            {provider === "claude" ? "Claude" : "Gemini"} is reading the chain…
          </p>
        )}
        <div ref={end} />
      </div>

      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <label className="sr-only" htmlFor="agent-input">
          Message
        </label>
        <input
          id="agent-input"
          className="app-input min-w-0 flex-1"
          placeholder={mode === "autopilot" ? "Tell the agent what to do…" : "Ask or request an action…"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={4000}
          disabled={busy}
        />
        <button type="submit" className="btn-brutal btn-sm" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
      {session.error && <p className="mt-2 text-xs" style={{ color: "var(--warn)" }}>{session.error}</p>}
    </Card>
  );
}

function Choice<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; title: string; sub: string; disabled: string | null }[];
}) {
  return (
    <div>
      <div className="kicker mb-1.5 !text-[0.6rem]">{label}</div>
      <div className="grid grid-cols-2 gap-px border" role="radiogroup" aria-label={label} style={{ borderColor: "var(--line-strong)", background: "var(--line-strong)" }}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={!!o.disabled}
              title={o.disabled ?? undefined}
              onClick={() => onChange(o.value)}
              className="px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40"
              style={on ? { background: "var(--bone)", color: "var(--ink)" } : { background: "var(--ink-2)" }}
            >
              <div className="text-sm font-medium">{o.title}</div>
              <div className="mono text-[0.62rem] opacity-70">{o.sub}</div>
            </button>
          );
        })}
      </div>
      {options.find((o) => o.disabled && o.value !== value)?.disabled && (
        <p className="mt-1 text-[0.7rem] text-muted">{options.find((o) => o.disabled && o.value !== value)!.disabled}</p>
      )}
    </div>
  );
}

function Message({ line, owner }: { line: Line; owner?: Address }) {
  if (line.role === "note") {
    return (
      <div>
        <p className="mono text-xs" style={{ color: "var(--warn)" }}>
          {line.text}
        </p>
        {line.actions?.map((a) => <ActionCard key={a.id} action={a} owner={owner} />)}
      </div>
    );
  }
  const mine = line.role === "user";
  return (
    <div className={mine ? "flex justify-end" : ""}>
      <div className={`max-w-[92%] ${mine ? "px-3 py-2" : ""}`} style={mine ? { background: "var(--ink-2)", border: "1px solid var(--line-strong)" } : undefined}>
        {!mine && (
          <div className="kicker mb-1 !text-[0.58rem]" style={{ color: "var(--rift)" }}>
            Rift agent{line.model ? ` · ${line.model}` : ""}
          </div>
        )}
        <div className="text-sm leading-relaxed [overflow-wrap:anywhere]">{mine ? line.text : <Markdown text={line.text} />}</div>
        {line.fee && (
          <p className="mono mt-1 text-[0.65rem] text-muted">
            premium fee {line.fee.amount} tUSD from your vault ·{" "}
            <a className="underline" href={`${explorers.unichain}/tx/${line.fee.tx}`} target="_blank" rel="noreferrer">
              tx ↗
            </a>
          </p>
        )}
        {line.actions?.map((a) => <ActionCard key={a.id} action={a} owner={owner} />)}
      </div>
    </div>
  );
}

/** Just enough markdown for model replies: paragraphs, bullet and numbered lists, **bold**, `code`. */
function Markdown({ text }: { text: string }) {
  const inline = (s: string): ReactNode[] =>
    s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
      part.startsWith("**") && part.endsWith("**") ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : part.startsWith("`") && part.endsWith("`") ? (
        <code key={i} className="mono text-[0.85em]">
          {part.slice(1, -1)}
        </code>
      ) : (
        <Fragment key={i}>{part}</Fragment>
      ),
    );
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <div className="space-y-2">
      {blocks.map((b, i) => {
        const rows = b.split("\n");
        if (rows.every((r) => /^\s*([-*•]|\d+[.)])\s+/.test(r))) {
          const ordered = /^\s*\d/.test(rows[0]);
          const items = rows.map((r) => r.replace(/^\s*([-*•]|\d+[.)])\s+/, ""));
          return ordered ? (
            <ol key={i} className="list-decimal space-y-1 pl-5">
              {items.map((it, j) => <li key={j}>{inline(it)}</li>)}
            </ol>
          ) : (
            <ul key={i} className="list-disc space-y-1 pl-5">
              {items.map((it, j) => <li key={j}>{inline(it)}</li>)}
            </ul>
          );
        }
        return (
          <p key={i} className="whitespace-pre-wrap">
            {inline(b.replace(/^#+\s*/gm, ""))}
          </p>
        );
      })}
    </div>
  );
}

function ActionCard({ action, owner }: { action: AgentAction; owner?: Address }) {
  const flow = useTxFlow();
  const [open, setOpen] = useState(false);
  const tone = action.status === "done" ? "var(--ok)" : action.status === "rejected" ? "var(--rift)" : "var(--cold)";
  const status = action.status === "done" ? "Done · from your vault" : action.status === "rejected" ? "Rejected" : "Proposed · needs your signature";
  return (
    <div className="mt-3 border p-3" style={{ borderColor: tone }} data-action-status={action.status}>
      <div className="mono text-[0.62rem] uppercase tracking-[0.14em]" style={{ color: tone }}>
        {status}
      </div>
      <div className="mt-1 text-sm">{action.summary}</div>
      {action.reason && <p className="mt-1 text-xs" style={{ color: "var(--warn)" }}>{action.reason}</p>}
      {action.tx && (
        <a className="mono mt-1 inline-block text-xs underline underline-offset-4" href={`${explorers.unichain}/tx/${action.tx}`} target="_blank" rel="noreferrer">
          {shortHex(action.tx, 6)} ↗
        </a>
      )}
      {action.status === "proposed" && (
        <div className="mt-3">
          {!owner ? (
            <ConnectCta>Connect to sign</ConnectCta>
          ) : !open ? (
            <button
              type="button"
              className="btn-brutal btn-sm"
              onClick={() => {
                setOpen(true);
                void flow.start(stepsFor(action, owner));
              }}
            >
              Review &amp; sign
            </button>
          ) : (
            <TxFlowView steps={flow.steps} states={flow.states} onRetry={flow.retry} running={flow.running} />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- vault panel

const wad = (s: string) => {
  try {
    const v = parseUnits(s.trim() || "0", 18);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
};

function VaultPanel({
  config,
  owner,
  vault,
  loading,
  session,
}: {
  config?: AgentConfig;
  owner?: Address;
  vault?: VaultState | null;
  loading: boolean;
  session: ReturnType<typeof useAgentSession>;
}) {
  if (!owner) {
    return (
      <Card index="B" title="Agent vault" subtitle="Where autopilot trades from">
        <p className="mb-4 text-sm text-muted">Connect a wallet on Unichain Sepolia to create or manage your agent vault.</p>
        <ConnectCta />
      </Card>
    );
  }
  if (loading || vault === undefined) return <Skeleton className="h-80 w-full" />;
  return vault ? <VaultManage vault={vault} owner={owner} config={config} session={session} /> : <VaultCreate />;
}

function LimitsForm({ initial, submitLabel, onSubmit, busy }: { initial: VaultState["limits"]; submitLabel: string; onSubmit: (l: VaultState["limits"]) => void; busy: boolean }) {
  const [spend, setSpend] = useState(formatUnits(initial.maxSpendPerDay, 18));
  const [notional, setNotional] = useState(formatUnits(initial.maxNotional, 18));
  const [fee, setFee] = useState(formatUnits(initial.maxFeePerDay, 18));
  const [lev, setLev] = useState(String(initial.maxLeverage));
  const [allowed, setAllowed] = useState(initial.allowed);
  const levN = Number(lev);
  const valid = wad(spend) !== null && wad(notional) !== null && (fee.trim() === "0" || wad(fee) !== null) && Number.isInteger(levN) && levN >= 1 && levN <= 10;
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSubmit({ maxSpendPerDay: wad(spend)!, maxNotional: wad(notional)!, maxFeePerDay: wad(fee) ?? 0n, maxLeverage: levN, allowed });
      }}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Spend / day (tUSD)">
          <input className="app-input mono" inputMode="decimal" value={spend} onChange={(e) => setSpend(e.target.value)} />
        </Field>
        <Field label="Max size (tUSD)">
          <input className="app-input mono" inputMode="decimal" value={notional} onChange={(e) => setNotional(e.target.value)} />
        </Field>
        <Field label="Max leverage">
          <input className="app-input mono" inputMode="numeric" value={lev} onChange={(e) => setLev(e.target.value)} />
        </Field>
        <Field label="Agent fees / day">
          <input className="app-input mono" inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} />
        </Field>
      </div>
      <fieldset>
        <legend className="kicker mb-1.5 !text-[0.6rem]">Agent may</legend>
        <div className="flex flex-wrap gap-3 text-sm">
          {(Object.entries(ALLOW) as [keyof typeof ALLOW, number][]).map(([k, bit]) => (
            <label key={k} className="flex items-center gap-1.5">
              <input type="checkbox" checked={(allowed & bit) !== 0} onChange={(e) => setAllowed(e.target.checked ? allowed | bit : allowed & ~bit)} />
              {k}
            </label>
          ))}
        </div>
      </fieldset>
      <button type="submit" className="btn-brutal btn-sm" disabled={!valid || busy}>
        {submitLabel}
      </button>
    </form>
  );
}

const DEFAULT_LIMITS: VaultState["limits"] = {
  maxSpendPerDay: 1_000n * 10n ** 18n,
  maxNotional: 5_000n * 10n ** 18n,
  maxFeePerDay: 10n * 10n ** 18n,
  maxLeverage: 5,
  allowed: 7,
};

function VaultCreate() {
  const tx = useTx();
  return (
    <Card index="B" ticks title="Create your agent vault" subtitle="One-time, on Unichain Sepolia">
      <p className="mb-4 text-sm text-muted">
        The agent can only trade from this vault, only through RiftMarket, and only inside these limits. Funds leave it only to the market, back to you, or as agent fees
        under your fee cap. You can pause, revoke or withdraw at any time.
      </p>
      <LimitsForm
        initial={DEFAULT_LIMITS}
        submitLabel="Create vault"
        busy={tx.busy}
        onSubmit={(l) =>
          void tx.run("Create vault", {
            ...factory,
            functionName: "createVault",
            args: [{ maxSpendPerDay: l.maxSpendPerDay, maxNotional: l.maxNotional, maxFeePerDay: l.maxFeePerDay, maxLeverage: l.maxLeverage, allowed: l.allowed }],
          })
        }
      />
      <div className="mt-3">
        <TxStatus state={tx.state} />
      </div>
    </Card>
  );
}

function VaultManage({ vault, owner, config, session }: { vault: VaultState; owner: Address; config?: AgentConfig; session: ReturnType<typeof useAgentSession> }) {
  const tx = useTx();
  const acct = useAccountState(owner);
  const [amount, setAmount] = useState("1000");
  const [editing, setEditing] = useState(false);
  const v = { address: vault.address, abi: riftAgentVaultAbi } as const;
  const amt = wad(amount);
  const allowed = (Object.entries(ALLOW) as [string, number][]).filter(([, b]) => vault.limits.allowed & b).map(([k]) => k);

  return (
    <Card
      index="B"
      ticks
      title="Agent vault"
      subtitle={`Contract ${shortHex(vault.address, 4)}`}
      right={
        <span className="mono text-[0.62rem] uppercase tracking-[0.14em]" style={{ color: vault.paused || !vault.agentActive ? "var(--warn)" : "var(--ok)" }}>
          {vault.paused ? "paused" : vault.agentActive ? "agent on" : "revoked"}
        </span>
      }
    >
      <div className="display text-[clamp(1.8rem,3vw,2.4rem)]" style={{ textTransform: "none" }}>
        {fmtToken(vault.balance)} <span className="text-base opacity-60">tUSD</span>
      </div>
      <p className="mt-1 text-xs text-muted">
        Agent can spend {fmtToken(vault.spendLeft, 0)} more today · fees left {fmtToken(vault.feesLeft)} ·{" "}
        <a className="underline underline-offset-4" href={`${explorers.unichain}/address/${vault.address}`} target="_blank" rel="noreferrer">
          contract ↗
        </a>
      </p>

      <div className="mt-4 flex gap-2">
        <input className="app-input mono min-w-0 flex-1" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount in tUSD" />
        <button
          type="button"
          className="btn-ghost btn-sm"
          disabled={!amt || tx.busy || (acct.data ? acct.data.usd < amt : false)}
          title={acct.data && amt && acct.data.usd < amt ? "Not enough tUSD in your wallet" : undefined}
          onClick={() => amt && void tx.run("Fund vault", { address: addresses.unichain.collateral, abi: mockTokenAbi, functionName: "transfer", args: [vault.address, amt] })}
        >
          Fund
        </button>
        <button
          type="button"
          className="btn-ghost btn-sm"
          disabled={!amt || tx.busy || amt > vault.balance}
          onClick={() => amt && void tx.run("Withdraw to wallet", { ...v, functionName: "withdraw", args: [amt] })}
        >
          Withdraw
        </button>
      </div>

      <div className="mt-4">
        {editing ? (
          <LimitsForm
            initial={vault.limits}
            submitLabel="Save limits"
            busy={tx.busy}
            onSubmit={(l) => void tx.run("Save limits", { ...v, functionName: "setLimits", args: [l] }).then((ok) => ok && setEditing(false))}
          />
        ) : (
          <Rows
            rows={[
              ["Spend / day", `${fmtToken(vault.limits.maxSpendPerDay, 0)} tUSD`],
              ["Max size per action", `${fmtToken(vault.limits.maxNotional, 0)} tUSD`],
              ["Max leverage", `${vault.limits.maxLeverage}×`],
              ["Agent fees / day", `${fmtToken(vault.limits.maxFeePerDay)} tUSD`],
              ["Agent may", allowed.length ? allowed.join(", ") : "nothing (close only)"],
              ["Position", vault.position ? `${vault.position.isLong ? "long" : "short"} ${fmtToken(vault.position.size, 0)} · PnL ${fmtToken(vault.position.pnl)}` : "none"],
              ["Pool shares", fmtToken(vault.shares)],
            ]}
          />
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className="btn-ghost btn-sm" disabled={tx.busy} onClick={() => setEditing((e) => !e)}>
          {editing ? "Cancel" : "Edit limits"}
        </button>
        <button type="button" className="btn-ghost btn-sm" disabled={tx.busy} onClick={() => void tx.run(vault.paused ? "Unpause" : "Pause", { ...v, functionName: "setPaused", args: [!vault.paused] })}>
          {vault.paused ? "Unpause" : "Pause agent"}
        </button>
        {vault.agentActive ? (
          <button type="button" className="btn-ghost btn-sm" disabled={tx.busy} onClick={() => void tx.run("Revoke agent", { ...v, functionName: "revokeAgent" })}>
            Revoke
          </button>
        ) : (
          config?.autopilot.agent && (
            <button type="button" className="btn-ghost btn-sm" disabled={tx.busy} onClick={() => void tx.run("Re-enable agent", { ...v, functionName: "setAgent", args: [config.autopilot.agent as Address] })}>
              Re-enable agent
            </button>
          )
        )}
        {vault.position && (
          <button type="button" className="btn-ghost btn-sm" disabled={tx.busy} onClick={() => void tx.run("Close vault position", { ...v, functionName: "closePosition" })}>
            Close position
          </button>
        )}
      </div>
      <div className="mt-3">
        <TxStatus state={tx.state} />
      </div>

      <div className="mt-4 border-t pt-3 text-xs text-muted" style={{ borderColor: "var(--line)" }}>
        {session.session ? (
          <>Agent session signed until {new Date(session.session.expires * 1000).toLocaleString()}.</>
        ) : (
          <span className="flex flex-wrap items-center gap-2">
            Autopilot and premium need a signed session (free).
            <button type="button" className="underline underline-offset-4" disabled={session.signing} onClick={() => void session.sign()}>
              {session.signing ? "Check your wallet…" : "Sign now"}
            </button>
          </span>
        )}
      </div>
    </Card>
  );
}

function HowItWorks() {
  return (
    <Card index="C" title="How the limits work">
      <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted">
        <li>RiftAgentVault checks every agent call on-chain: daily spend, size per action, leverage, and which actions are allowed.</li>
        <li>Money only moves into RiftMarket, back to you, or to the agent as fees under your daily fee cap.</li>
        <li>Positions, cover and pool shares belong to the vault, so payouts and closes land there.</li>
        <li>Pause stops the agent instantly; revoke removes its key. You can always act and withdraw yourself.</li>
        <li>In the background, the autopilot runs your rules (Autopilot rules card): liquidation guard, take-profit, stop-loss, auto-claim, auto-hedge, and an optional goal the model re-checks on a schedule.</li>
        <li>Gemini is free. Claude is premium: each message is paid from the vault, within your fee cap.</li>
      </ul>
    </Card>
  );
}

