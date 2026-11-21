import { Archivo, Inter, JetBrains_Mono } from "next/font/google";

// Shared by the site and the app. Each font is self-hosted by Next at build time. Until it loads (or if it
// never does), text renders in a fallback sized to the web font's metrics (adjustFontFallback), then in the
// stacks listed here, so the layout doesn't jump.

// Display: Archivo at its widest, heaviest setting for the brutalist headlines.
export const display = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--lf-display",
  display: "swap",
  fallback: ["Arial Black", "Helvetica Neue", "Arial", "sans-serif"],
});
// Body: a clean sans that stays legible at small sizes in both themes.
export const body = Inter({
  subsets: ["latin"],
  variable: "--lf-body",
  display: "swap",
  fallback: ["system-ui", "-apple-system", "Segoe UI", "Roboto", "Arial", "sans-serif"],
});
// Figures, hashes and labels.
export const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--lf-mono",
  display: "swap",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "Liberation Mono", "monospace"],
});

export const fontVariables = `${display.variable} ${body.variable} ${mono.variable}`;
