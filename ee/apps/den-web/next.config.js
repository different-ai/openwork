const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  skipTrailingSlashRedirect: true,
  transpilePackages: ["@openwork/ui", "@openwork-ee/utils"],
  outputFileTracingRoot: path.join(__dirname, "../../.."),
};

const allowedDevOrigins = (process.env.DEN_WEB_ALLOWED_DEV_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

if (allowedDevOrigins.length > 0) {
  nextConfig.allowedDevOrigins = allowedDevOrigins;
}

module.exports = nextConfig;
