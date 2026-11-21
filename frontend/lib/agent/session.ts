"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";

import { describeError } from "../errors";
import { sessionMessage, type Session } from "./types";

const KEY = (a: string) => `rift:agent-session:${a.toLowerCase()}`;
const TTL = 24 * 3600;

function load(address?: string): Session | null {
  if (!address) return null;
  try {
    const s = JSON.parse(window.localStorage.getItem(KEY(address)) ?? "null") as Session | null;
    return s && s.expires > Date.now() / 1000 + 60 ? s : null;
  } catch {
    return null; // storage blocked or corrupt: sign again
  }
}

/**
 * A signed message proving this browser controls the wallet, valid for 24 hours. The server needs it before
 * the agent acts through the user's vault or charges the premium fee. Signing costs nothing (no transaction).
 */
export function useAgentSession() {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [session, setSession] = useState<Session | null>(null);
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setSession(load(address)), [address]);

  const sign = useCallback(async (): Promise<Session | null> => {
    if (!address) return null;
    setSigning(true);
    setError(null);
    try {
      const expires = Math.floor(Date.now() / 1000) + TTL;
      const signature = await signMessageAsync({ message: sessionMessage(address, expires) });
      const s: Session = { address, expires, signature };
      try {
        window.localStorage.setItem(KEY(address), JSON.stringify(s));
      } catch {
        // kept in memory only
      }
      setSession(s);
      return s;
    } catch (e) {
      setError(describeError(e));
      return null;
    } finally {
      setSigning(false);
    }
  }, [address, signMessageAsync]);

  return { session, sign, signing, error };
}
