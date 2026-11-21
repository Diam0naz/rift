import type { Metadata } from "next";

import { Dashboard } from "@/components/Dashboard";

export const metadata: Metadata = {
  title: "Rift · App",
  description: "Live Rift dashboard and trading on Unichain Sepolia.",
};

export default function AppPage() {
  return <Dashboard />;
}
