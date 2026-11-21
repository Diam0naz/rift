// Stand-in for @coinbase/cdp-sdk's optional x402 payment packages. Wallet connectors pull the SDK in, the
// bundler has to resolve its imports, and Rift never calls x402. Every export throws if it ever is.
// Generated from the SDK's import list; see next.config.ts.
const unavailable = (name: string) =>
  function () {
    throw new Error(`${name} (x402) is not available in Rift`);
  } as unknown as never;

export const AuthCaptureEvmScheme = unavailable("AuthCaptureEvmScheme");
export const BUILDER_CODE = unavailable("BUILDER_CODE");
export const BUILDER_CODE_PATTERN = unavailable("BUILDER_CODE_PATTERN");
export const BUILDER_CODE_SCHEMA = unavailable("BUILDER_CODE_SCHEMA");
export const BatchSettlementEvmScheme = unavailable("BatchSettlementEvmScheme");
export const BuilderCodeClientExtension = unavailable("BuilderCodeClientExtension");
export const ExactEvmScheme = unavailable("ExactEvmScheme");
export const ExactEvmSchemeV1 = unavailable("ExactEvmSchemeV1");
export const ExactSvmScheme = unavailable("ExactSvmScheme");
export const ExactSvmSchemeV1 = unavailable("ExactSvmSchemeV1");
export const HTTPFacilitatorClient = unavailable("HTTPFacilitatorClient");
export const PaymentRequirementsV1Schema = unavailable("PaymentRequirementsV1Schema");
export const PaymentRequirementsV2Schema = unavailable("PaymentRequirementsV2Schema");
export const UptoEvmScheme = unavailable("UptoEvmScheme");
export const UptoSvmScheme = unavailable("UptoSvmScheme");
export const bazaarResourceServerExtension = unavailable("bazaarResourceServerExtension");
export const builderCodeResourceServerExtension = unavailable("builderCodeResourceServerExtension");
export const paymentMiddlewareFromConfig = unavailable("paymentMiddlewareFromConfig");
export const paymentMiddlewareFromHTTPServer = unavailable("paymentMiddlewareFromHTTPServer");
export const registerExactEvmScheme = unavailable("registerExactEvmScheme");
export const toClientEvmSigner = unavailable("toClientEvmSigner");
export const wrapFetchWithPayment = unavailable("wrapFetchWithPayment");
export const x402Client = unavailable("x402Client");
export const x402HTTPResourceServer = unavailable("x402HTTPResourceServer");
export const x402ResourceServer = unavailable("x402ResourceServer");
