import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AppShell } from "@/components/app/AppShell";

export const metadata: Metadata = {
  title: "Rift · App",
  description: "Drain protection, the spread perp and the underwriting pool, settled by Reactive Network.",
};

export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
