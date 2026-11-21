"use client";

import { RainbowKitProvider, darkTheme, lightTheme } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";

import { wagmiConfig } from "@/lib/wagmi";

type ThemeVars = ReturnType<typeof darkTheme>;

/** RainbowKit themed to the site: hard edges, the red fault-line accent, ink/bone surfaces. */
function brand(base: ThemeVars, dark: boolean): ThemeVars {
  return {
    ...base,
    colors: {
      ...base.colors,
      accentColor: dark ? "#ff4433" : "#e1311d",
      accentColorForeground: "#09090b",
      modalBackground: dark ? "#111114" : "#f2eee5",
      modalBorder: dark ? "rgba(236,231,220,0.28)" : "rgba(17,17,20,0.28)",
      modalText: dark ? "#ece7dc" : "#111114",
      modalTextSecondary: dark ? "#a8a397" : "#4a4740",
      connectButtonBackground: dark ? "#111114" : "#f2eee5",
      connectButtonText: dark ? "#ece7dc" : "#111114",
      generalBorder: dark ? "rgba(236,231,220,0.12)" : "rgba(17,17,20,0.1)",
    },
    fonts: { body: "var(--lf-body), system-ui, sans-serif" },
    radii: {
      actionButton: "0px",
      connectButton: "0px",
      menuButton: "0px",
      modal: "0px",
      modalMobile: "0px",
    },
  };
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Keep showing the last good data while a poll is in flight or a public RPC hiccups.
            retry: 2,
            refetchOnWindowFocus: false,
            staleTime: 2000,
          },
        },
      }),
  );
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={client}>
        <RainbowKitProvider
          theme={{
            lightMode: brand(lightTheme({ borderRadius: "none", overlayBlur: "small" }), false),
            darkMode: brand(darkTheme({ borderRadius: "none", overlayBlur: "small" }), true),
          }}
          appInfo={{ appName: "Rift", learnMoreUrl: "https://dev.reactive.network" }}
          modalSize="compact"
        >
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
