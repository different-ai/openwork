const path = require("path");
const { denApiRedirects } = require("./next-config-den-api-redirects.cjs");
const { legacyConnectorRedirects } = require("./next-config-legacy-connector-redirects.cjs");
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

// Keep the existing public key name. The other spellings are fallback-only for
// rollout compatibility; an explicitly blank KEY disables tracking.
const posthogKey = (
  process.env.NEXT_PUBLIC_POSTHOG_KEY
  ?? process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN
  ?? process.env.DEN_WEB_POSTHOG_KEY
  ?? ""
).trim();

const posthogEnabled = process.env.NODE_ENV === "production"
  && process.env.VERCEL_ENV === "production"
  && (!process.env.OPENWORK_DEV_MODE || process.env.OPENWORK_DEV_MODE === "0")
  && /^phc_[A-Za-z0-9_-]{1,200}$/.test(posthogKey);

// HOST selects the Cloud upstream, never a browser-side bypass of /ow.
// Accept the legacy US UI hostname and the existing proxy path as well.
const configuredPosthogHost = (process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim() || "https://us.i.posthog.com").replace(/\/+$/, "");
const configuredPosthogRegion = ["/ow", "https://us.i.posthog.com", "https://us.posthog.com", "https://app.posthog.com"].includes(configuredPosthogHost)
  ? "us"
  : ["https://eu.i.posthog.com", "https://eu.posthog.com"].includes(configuredPosthogHost) ? "eu" : null;
if (posthogEnabled && !configuredPosthogRegion) {
  throw new Error("NEXT_PUBLIC_POSTHOG_HOST must be a US/EU PostHog Cloud HTTPS origin or /ow.");
}
// An unused analytics setting must not break preview/dev startup. Never forward
// to an unsupported host; retain the previous US proxy default while disabled.
const posthogRegion = configuredPosthogRegion ?? "us";
const posthogApiHost = `https://${posthogRegion}.i.posthog.com`;
const posthogAssetsHost = `https://${posthogRegion}-assets.i.posthog.com`;

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_POSTHOG_KEY: posthogEnabled ? posthogKey : "",
    NEXT_PUBLIC_POSTHOG_HOST: posthogApiHost,
  },
  reactStrictMode: true,
  skipTrailingSlashRedirect: true,
  poweredByHeader: false,
  transpilePackages: ["@openwork/ui", "@openwork-ee/utils", "@openwork-ee/telemetry-contracts"],
  outputFileTracingRoot: path.join(__dirname, "../../.."),
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
  async redirects() {
    return [...legacyConnectorRedirects(), ...denApiRedirects(process.env)];
  },
  async rewrites() {
    return [
      {
        source: "/ow/static/:path*",
        destination: `${posthogAssetsHost}/static/:path*`,
      },
      {
        source: "/ow/array/:path*",
        destination: `${posthogAssetsHost}/array/:path*`,
      },
      {
        source: "/ow/:path*",
        destination: `${posthogApiHost}/:path*`,
      },
    ];
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

// Next sizes its build workers from the host CPU count, which inside a cgroup
// limited sandbox (Daytona: 4 CPUs, 8 GB) spawns ~95 workers and gets OOM
// killed while collecting page data. Sandboxes opt in to a fixed cap.
const buildCpus = Number.parseInt(process.env.DEN_WEB_BUILD_CPUS ?? "", 10);
if (Number.isInteger(buildCpus) && buildCpus > 0) {
  nextConfig.experimental = { ...nextConfig.experimental, cpus: buildCpus };
}

module.exports = withObservabilityNextConfig(nextConfig);
