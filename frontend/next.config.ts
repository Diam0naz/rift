import type { NextConfig } from "next";

// @coinbase/cdp-sdk (pulled in by the wallet connectors) lazily imports its optional x402 payment
// packages. They're declared optional and Rift never uses x402, but the bundler still has to resolve
// the imports, so they point at an empty module.
const optionalStub = "./lib/stubs/x402.ts";
// Every @x402/* path the SDK imports (generated alongside the stub).
const x402: string[] = require("./lib/stubs/x402-modules.json");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {
    resolveAlias: Object.fromEntries(x402.map((m) => [m, optionalStub])),
  },
};

export default nextConfig;
