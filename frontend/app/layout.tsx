import type { Metadata } from "next";
import type { ReactNode } from "react";

import { fontVariables } from "./fonts";
import { Providers } from "./providers";
import "./globals.css";
import "./landing.css";

export const metadata: Metadata = {
  title: "Rift",
  description: "Cross-chain spread perp and drain default swap, settled by Reactive Network.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-scroll-behavior="smooth" className={fontVariables}>
      <body className="min-h-screen antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
