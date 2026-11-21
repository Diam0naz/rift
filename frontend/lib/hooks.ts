"use client";

import { useQuery } from "@tanstack/react-query";

import { POLL_MS } from "./config";
import { readMarket, readMarkHistory, readOrigin, readReactive } from "./reads";

export const useMarket = () => useQuery({ queryKey: ["market"], queryFn: readMarket, refetchInterval: POLL_MS });

export const useReactive = () =>
  useQuery({ queryKey: ["reactive"], queryFn: readReactive, refetchInterval: POLL_MS });

export const useOrigin = () => useQuery({ queryKey: ["origin"], queryFn: readOrigin, refetchInterval: POLL_MS });

/** Mark history changes slowly (heartbeat ~10-17 min, plus swaps), so it polls less often. */
export const useMarkHistory = () =>
  useQuery({ queryKey: ["markHistory"], queryFn: readMarkHistory, refetchInterval: 30_000 });
