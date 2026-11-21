import "server-only";

import { isAddress, type Address } from "viem";

import { clients } from "../config";
import { sessionMessage, type Session } from "./types";

/**
 * Who is asking. A connected address alone proves nothing (anyone can type one), so anything that spends,
 * acting through a vault or charging the premium fee, needs a session the wallet signed. Smart-contract
 * wallets work too: viem's verifyMessage falls back to EIP-1271 through the RPC.
 */
const MAX_SESSION = 48 * 3600;

export async function verifySession(s: Session | undefined): Promise<Address | undefined> {
  if (!s || !isAddress(s.address) || typeof s.signature !== "string" || !Number.isInteger(s.expires)) return undefined;
  const now = Math.floor(Date.now() / 1000);
  if (s.expires < now || s.expires > now + MAX_SESSION) return undefined;
  try {
    const ok = await clients.unichain.verifyMessage({ address: s.address, message: sessionMessage(s.address, s.expires), signature: s.signature });
    return ok ? s.address : undefined;
  } catch {
    return undefined;
  }
}

/** Fixed-window limiter per key, in memory: enough for one server process. Returns seconds to wait, or 0. */
const windows = new Map<string, { start: number; count: number }>();
export function rateLimit(key: string, max: number, windowSec: number): number {
  const now = Date.now() / 1000;
  const w = windows.get(key);
  if (!w || now - w.start >= windowSec) {
    windows.set(key, { start: now, count: 1 });
    if (windows.size > 10_000) for (const [k, v] of windows) if (now - v.start >= windowSec) windows.delete(k);
    return 0;
  }
  if (w.count >= max) return Math.ceil(windowSec - (now - w.start));
  w.count++;
  return 0;
}

export const clientIp = (req: Request) => req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
