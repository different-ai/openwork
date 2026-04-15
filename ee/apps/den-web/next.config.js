const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  skipTrailingSlashRedirect: true,
  transpilePackages: ["@openwork/ui", "@openwork-ee/utils"],
  outputFileTracingRoot: path.join(__dirname, "../../.."),
};

module.exports = nextConfig;
