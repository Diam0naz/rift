"use client";

import { useQuery } from "@tanstack/react-query";

import { POLL_MS } from "./config";
import { markHistory, useMarketLogs } from "./logs";
import { readMarket, readOrigin, readReactive } from "./reads";

export const useMarket = () => useQuery({ queryKey: ["market"], queryFn: readMarket, refetchInterval: POLL_MS });

export const useReactive = () =>
  useQuery({ queryKey: ["reactive"], queryFn: readReactive, refetchInterval: POLL_MS });

export const useOrigin = () => useQuery({ queryKey: ["origin"], queryFn: readOrigin, refetchInterval: POLL_MS });

/** Marks delivered to the market, derived from the shared market-log scan (lib/logs.ts). */
export function useMarkHistory() {
  const logs = useMarketLogs();
  return { ...logs, data: logs.data ? markHistory(logs.data) : undefined };
}
