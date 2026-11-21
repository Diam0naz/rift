import type { Metadata } from "next";

import { NotFound } from "@/components/NotFound";

export const metadata: Metadata = { title: "Not found · Rift" };

export default function NotFoundPage() {
  return <NotFound />;
}
