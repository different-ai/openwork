const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  skipTrailingSlashRedirect: true,
  outputFileTracingRoot: path.join(__dirname, "../../.."),
};

module.exports = nextConfig;
