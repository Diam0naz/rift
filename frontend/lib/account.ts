"use client";

import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";

import { readAccount } from "./account-read";
import { POLL_MS } from "./config";

export { readAccount, type AccountState } from "./account-read";
export const useAccountState = (user: Address | undefined) =>
  useQuery({
    queryKey: ["account", user],
    queryFn: () => readAccount(user!),
    enabled: !!user,
    refetchInterval: POLL_MS,
  });
