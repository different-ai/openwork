const path = require("path");
const { withObservabilityNextConfig } = require("./observability/next-config-observability.cjs");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  skipTrailingSlashRedirect: true,
  transpilePackages: ["@openwork/ui", "@openwork-ee/utils"],
  outputFileTracingRoot: path.join(__dirname, "../../.."),
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
