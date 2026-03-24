const { withBotId } = require("botid/next/config");

/** @type {import('next').NextConfig} */
const mintlifyOrigin = "https://differentai.mintlify.dev";

const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: "/docs",
        destination: `${mintlifyOrigin}/docs`,
      },
      {
        source: "/docs/:match*",
        destination: `${mintlifyOrigin}/docs/:match*`,
      },
    ];
  },
};

module.exports = withBotId(nextConfig);
