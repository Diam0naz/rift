import Anthropic from "@anthropic-ai/sdk";
import { ApiError as GeminiApiError } from "@google/genai";
import { NextResponse } from "next/server";
import { formatUnits, isAddress, parseUnits } from "viem";

import { runnerStatus } from "@/lib/agent/autopilot";
import { clientIp, rateLimit, verifySession } from "@/lib/agent/guard";
import { MODELS, providerAvailable, runTurn } from "@/lib/agent/llm";
import { agentAccount, callVault } from "@/lib/agent/signer";
import type { AgentAction, AgentConfig, ChatRequest, ChatResponse } from "@/lib/agent/types";
import { readVault } from "@/lib/agent/vault";
import { addresses } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** Premium (Claude) costs this much tUSD per message, charged from the user's vault under its fee cap. */
const PREMIUM_FEE = parseUnits(process.env.AGENT_PREMIUM_FEE ?? "1", 18);
const MAX_MESSAGE = 4000;
const MAX_HISTORY_BYTES = 400_000;

const fail = (status: number, error: string, extra?: object) => NextResponse.json({ error, ...extra }, { status });

/** What the chat screen can offer on this server. */
export async function GET() {
  const agent = agentAccount();
  const config: AgentConfig = {
    providers: {
      gemini: { available: providerAvailable("gemini"), model: MODELS.gemini },
      claude: { available: providerAvailable("claude"), model: MODELS.claude, premium: true, feePerMessage: formatUnits(PREMIUM_FEE, 18) },
    },
    autopilot: { available: !!agent, agent: agent?.address ?? null, factory: addresses.agent.factory, background: runnerStatus() },
  };
  return NextResponse.json(config);
}

export async function POST(req: Request) {
  let body: ChatRequest;
  try {
    const raw = await req.text();
    if (raw.length > MAX_HISTORY_BYTES + MAX_MESSAGE + 2000) return fail(413, "Conversation is too long. Start a new chat.");
    body = JSON.parse(raw) as ChatRequest;
  } catch {
    return fail(400, "Invalid JSON.");
  }
  const { provider, mode, message } = body;
  if (provider !== "gemini" && provider !== "claude") return fail(400, "Unknown model.");
  if (mode !== "copilot" && mode !== "autopilot") return fail(400, "Unknown mode.");
  if (typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE) return fail(400, `Message must be 1-${MAX_MESSAGE} characters.`);
  if (body.history !== undefined && !Array.isArray(body.history)) return fail(400, "Bad history.");
  if (body.account !== undefined && !isAddress(body.account)) return fail(400, "Bad account.");
  if (!providerAvailable(provider)) return fail(503, provider === "claude" ? "The premium model isn't enabled on this server." : "The model isn't configured on this server (GEMINI_API_KEY).");

  const premium = provider === "claude";
  const wait = rateLimit(`${provider}:${clientIp(req)}`, premium ? 10 : 30, 600);
  if (wait) return fail(429, `Too many messages. Try again in ${Math.ceil(wait / 60)} min.`);

  const verified = await verifySession(body.session);
  if ((mode === "autopilot" || premium) && !verified) {
    return fail(401, "Sign the agent session in your wallet first.", { needSession: true });
  }

  // Agent payment: a premium message is charged from the user's vault, capped on-chain by its daily fee limit.
  let fee: ChatResponse["fee"];
  if (premium) {
    const vault = await readVault(verified!);
    if (!vault) return fail(402, "The premium model is paid from your agent vault. Create and fund one first.", { needVault: true });
    const r = await callVault(vault.address, { fn: "chargeFee", args: [PREMIUM_FEE, `premium message (${MODELS.claude})`] });
    if (!r.ok) return fail(402, `Couldn't charge the premium fee: ${r.reason}`);
    fee = { amount: formatUnits(PREMIUM_FEE, 18), tx: r.tx };
  }

  const actions: AgentAction[] = [];
  try {
    const turn = await runTurn(provider, body.history ?? [], message, { mode, account: body.account, verified, actions });
    const res: ChatResponse = { provider, model: turn.model, reply: turn.reply, history: turn.history, actions, fee };
    return NextResponse.json(res);
  } catch (e) {
    console.error("agent turn failed", e);
    // Typed errors, most specific first. Actions already taken are still reported.
    let reason = "The model request failed. Try again.";
    if (e instanceof Anthropic.RateLimitError) reason = "The premium model is rate-limited right now. Try again shortly.";
    else if (e instanceof Anthropic.AuthenticationError) reason = "The premium model's API key was rejected.";
    else if (e instanceof Anthropic.APIError) reason = `The premium model returned an error (${e.status ?? "network"}).`;
    else if (e instanceof GeminiApiError)
      reason =
        e.status === 429 || e.status === 503
          ? "Google's Gemini models are overloaded right now (tried the fallbacks too). Try again in a minute."
          : `The model returned an error (${e.status}).`;
    return fail(502, reason, { actions, fee });
  }
}
