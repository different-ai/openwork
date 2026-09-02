const path = require("path");
const { denApiRedirects } = require("./next-config-den-api-redirects.cjs");
const { withObservabilityNextConfig } = require("./observability/next-config-observability.cjs");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  skipTrailingSlashRedirect: true,
  transpilePackages: ["@openwork/ui", "@openwork-ee/utils", "@openwork-ee/telemetry-contracts"],
  outputFileTracingRoot: path.join(__dirname, "../../.."),
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
