const path = require("path");
const { denApiRedirects } = require("./next-config-den-api-redirects.cjs");
const { withObservabilityNextConfig } = require("./observability/next-config-observability.cjs");

// Baseline OWASP security headers (OWASP WSTG-CLNT-09 clickjacking, secure headers).
// Den Web is never embedded in a frame, so framing is denied outright.
//
// Deliberately NOT set here (read before adding):
// - A full Content-Security-Policy (script-src, style-src, connect-src, ...).
//   The CSP below is frame-ancestors only. A real script CSP needs per-request
//   nonces generated in proxy.ts and threaded through the root layout, plus an
//   audit of every inline script (PostHog via /ow, Sentry, next/script). Do not
//   add 'unsafe-inline' as a shortcut; it defeats the purpose.
// - Cross-Origin-Opener-Policy: same-origin. It severs window.opener, which
//   app/(den)/reauth/complete/page.tsx and
//   app/(den)/dashboard/_components/mcp-authorization-url.ts rely on to
//   postMessage back to the opener after an OAuth popup round-trips through an
//   external IdP. Use same-origin-allow-popups at most, and test both flows.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  skipTrailingSlashRedirect: true,
  poweredByHeader: false,
  transpilePackages: ["@openwork/ui", "@openwork-ee/utils", "@openwork-ee/telemetry-contracts"],
  outputFileTracingRoot: path.join(__dirname, "../../.."),
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
  async redirects() {
    return denApiRedirects(process.env);
  },
};

const defaultAllowedDevOrigins = ["127.0.0.1", "localhost"];

const allowedDevOrigins = (process.env.DEN_WEB_ALLOWED_DEV_ORIGINS || defaultAllowedDevOrigins.join(","))
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (allowedDevOrigins.length > 0) {
  nextConfig.allowedDevOrigins = allowedDevOrigins;
}

module.exports = withObservabilityNextConfig(nextConfig);
