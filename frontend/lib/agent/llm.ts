import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { ApiError, GoogleGenAI, type Content, type FunctionDeclaration, type GenerateContentParameters, type GenerateContentResponse } from "@google/genai";

import { TOOLS, runTool, systemPrompt, type ToolContext } from "./tools";
import type { Provider } from "./types";

/**
 * One chat turn: the model reads state and acts through the tools until it answers in text. Each provider
 * keeps its own native history (returned to the browser and sent back next turn unchanged), so Gemini's
 * thought signatures and Claude's thinking blocks survive across turns.
 */

export const MODELS = {
  gemini: process.env.GEMINI_MODEL || "gemini-3.8-flash",
  claude: process.env.CLAUDE_MODEL || "claude-opus-5-5",
} as const;

/**
 * Gemini models to try in order when one is overloaded (503) or rate-limited (429). Within one turn the
 * agent stays on whichever model answered: thought signatures belong to the model that wrote them.
 */
const GEMINI_CHAIN = [MODELS.gemini, ...(process.env.GEMINI_FALLBACK_MODELS ?? "gemini-3.7-flash,gemini-3.5-flash").split(",").map((m) => m.trim()).filter(Boolean)].filter(
  (m, i, all) => all.indexOf(m) === i,
);
/** Models that just reported overload are skipped for a minute, so each message doesn't re-wait on them. */
const coolingUntil = new Map<string, number>();
const COOL_MS = 60_000;
const transient = (e: unknown) => e instanceof ApiError && [429, 500, 503, 504].includes(e.status);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One generateContent call with retries (2 per model, short backoff), falling through the chain. */
async function generate(ai: GoogleGenAI, req: Omit<GenerateContentParameters, "model">, pinned: { model: string | null }): Promise<GenerateContentResponse> {
  const now = Date.now();
  const fresh = GEMINI_CHAIN.filter((m) => (coolingUntil.get(m) ?? 0) <= now);
  const chain = pinned.model ? [pinned.model] : fresh.length ? fresh : GEMINI_CHAIN;
  let last: unknown;
  for (const model of chain) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await ai.models.generateContent({ ...req, model });
        pinned.model = model;
        return res;
      } catch (e) {
        last = e;
        if (!transient(e)) throw e;
        await sleep(800 * (attempt + 1));
      }
    }
    coolingUntil.set(model, Date.now() + COOL_MS);
    if (model !== chain[chain.length - 1]) console.warn(`gemini: ${model} unavailable, trying the next model`);
  }
  throw last;
}

/** Tool rounds per user message: enough for read → quote → act → confirm, small enough to bound cost. */
const MAX_ROUNDS = 8;

export type TurnResult = { reply: string; history: unknown[]; model: string };

/** Test-only scripted model (AGENT_MOCK=1, set by e2e/run.sh): drives the real tools without an API key. */
const MOCK = process.env.AGENT_MOCK === "1";

export const providerAvailable = (p: Provider) => MOCK || (p === "gemini" ? !!process.env.GEMINI_API_KEY : !!process.env.ANTHROPIC_API_KEY);

export async function runTurn(provider: Provider, history: unknown[], message: string, ctx: ToolContext): Promise<TurnResult> {
  if (MOCK) return runMock(history, message, ctx);
  return provider === "gemini" ? runGemini(history as Content[], message, ctx) : runClaude(history as Anthropic.Beta.BetaMessageParam[], message, ctx);
}

// ---------------------------------------------------------------- scripted model (tests only)

async function runMock(history: unknown[], message: string, ctx: ToolContext): Promise<TurnResult> {
  const m = message.toLowerCase();
  const n = (re: RegExp) => Number(m.match(re)?.[1]);
  let call: [string, Record<string, unknown>];
  if (/open .*(long|short)/.test(m)) call = ["open_position", { side: m.includes("short") ? "short" : "long", size: n(/(\d[\d.]*)\s*(tusd)?/), leverage: n(/(\d+)\s*x/) || 1 }];
  else if (/close/.test(m)) call = ["close_position", {}];
  else if (/cover/.test(m)) call = [m.includes("quote") ? "quote_cover" : "buy_cover", { notional: n(/(\d[\d.]*)/), days: n(/(\d[\d.]*)\s*day/) || 1 }];
  else if (/deposit/.test(m)) call = ["deposit", { amount: n(/(\d[\d.]*)/) }];
  else if (/portfolio|position|vault/.test(m)) call = ["get_portfolio", {}];
  else call = ["get_market", {}];
  const out = await runTool(call[0], call[1], ctx);
  return { reply: `[mock] ${call[0]} → ${JSON.stringify(out)}`, history: [...history, { message, call }], model: "mock" };
}

// ---------------------------------------------------------------- Gemini (default)

async function runGemini(history: Content[], message: string, ctx: ToolContext): Promise<TurnResult> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const declarations: FunctionDeclaration[] = TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    parametersJsonSchema: t.parameters,
  }));
  const contents: Content[] = [...history, { role: "user", parts: [{ text: message }] }];
  const pinned: { model: string | null } = { model: null };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await generate(
      ai,
      { contents, config: { systemInstruction: systemPrompt(ctx.mode, ctx.verified ?? ctx.account), tools: [{ functionDeclarations: declarations }] } },
      pinned,
    );
    const used = pinned.model ?? MODELS.gemini;
    const content = res.candidates?.[0]?.content;
    if (!content) {
      const why = res.promptFeedback?.blockReason ?? res.candidates?.[0]?.finishReason ?? "no response";
      return { reply: `The model returned no answer (${why}). Try rephrasing.`, history: contents, model: used };
    }
    contents.push(content); // as returned: keeps thought signatures for the next request
    const calls = res.functionCalls ?? [];
    if (!calls.length) return { reply: res.text ?? "", history: contents, model: used };

    const results = await Promise.all(
      calls.map(async (c) => ({
        functionResponse: { id: c.id, name: c.name, response: { output: await runTool(c.name ?? "", (c.args ?? {}) as Record<string, unknown>, ctx) } },
      })),
    );
    contents.push({ role: "user", parts: results });
  }
  return { reply: "I stopped after several steps without finishing. Ask again or narrow the request.", history: contents, model: pinned.model ?? MODELS.gemini };
}

// ---------------------------------------------------------------- Claude (premium)

async function runClaude(history: Anthropic.Beta.BetaMessageParam[], message: string, ctx: ToolContext): Promise<TurnResult> {
  const client = new Anthropic();
  const tools: Anthropic.Beta.BetaTool[] = TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema,
    strict: true,
  }));
  const messages: Anthropic.Beta.BetaMessageParam[] = [...history, { role: "user", content: message }];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await client.beta.messages.create({
      model: MODELS.claude,
      max_tokens: 16000,
      system: systemPrompt(ctx.mode, ctx.verified ?? ctx.account),
      tools,
      messages,
      output_config: { effort: "medium" },
      // On a policy decline, the API re-runs the request on Anthropic's recommended fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    messages.push({ role: "assistant", content: res.content }); // unchanged, thinking blocks included

    if (res.stop_reason === "refusal") {
      return { reply: "The model declined this request. Try rephrasing it.", history: messages, model: res.model };
    }
    if (res.stop_reason === "pause_turn") continue;
    const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (res.stop_reason === "tool_use" && uses.length) {
      const results = await Promise.all(
        uses.map(async (u): Promise<Anthropic.Beta.BetaToolResultBlockParam> => ({
          type: "tool_result",
          tool_use_id: u.id,
          content: JSON.stringify(await runTool(u.name, u.input as Record<string, unknown>, ctx)),
        })),
      );
      messages.push({ role: "user", content: results }); // every result in one message
      continue;
    }
    const text = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    const cut = res.stop_reason === "max_tokens" ? "\n\n(Answer cut off at the length limit.)" : "";
    return { reply: text + cut, history: messages, model: res.model };
  }
  return { reply: "I stopped after several steps without finishing. Ask again or narrow the request.", history: messages, model: MODELS.claude };
}
