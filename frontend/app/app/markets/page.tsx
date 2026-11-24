import { Suspense } from "react";

import { MarketsScreen } from "@/components/app/screens/Markets";

export default function MarketsPage() {
  return (
    <Suspense>
      <MarketsScreen />
    </Suspense>
  );
}
