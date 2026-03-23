const { withBotId } = require("botid/next/config");

/** @type {import('next').NextConfig} */
const mintlifyOrigin = "https://differentai.mintlify.app";

const nextConfig = {
  reactStrictMode: true,
  async redirects() {
    return [
      {
        source: "/introduction",
        destination: "/docs",
        permanent: false,
      },
      {
        source: "/get-started",
        destination: "/docs/quickstart",
        permanent: false,
      },
      {
        source: "/quickstart",
        destination: "/docs/quickstart",
        permanent: false,
      },
      {
        source: "/technical",
        destination: "/docs/technical",
        permanent: false,
      },
      {
        source: "/non-technical",
        destination: "/docs/non-technical",
        permanent: false,
      },
      {
        source: "/development",
        destination: "/docs/development",
        permanent: false,
      },
      {
        source: "/openwork",
        destination: "/docs/openwork",
        permanent: false,
      },
      {
        source: "/orbita-layout-style",
        destination: "/docs/orbita-layout-style",
        permanent: false,
      },
      {
        source: "/opencode-router",
        destination: "/docs/opencode-router",
        permanent: false,
      },
      {
        source: "/cli",
        destination: "/docs/cli",
        permanent: false,
      },
      {
        source: "/create-openwork-instance",
        destination: "/docs/create-openwork-instance",
        permanent: false,
      },
      {
        source: "/tutorials/:path*",
        destination: "/docs/tutorials/:path*",
        permanent: false,
      },
      {
        source: "/api-reference/:path*",
        destination: "/docs/api-reference/:path*",
        permanent: false,
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: "/_mintlify/:path*",
        destination: `${mintlifyOrigin}/_mintlify/:path*`,
      },
      {
        source: "/api/request",
        destination: `${mintlifyOrigin}/_mintlify/api/request`,
      },
      {
        source: "/docs",
        destination: `${mintlifyOrigin}/introduction`,
      },
      {
        source: "/docs/get-started",
        destination: `${mintlifyOrigin}/quickstart`,
      },
      {
        source: "/docs/:path*",
        destination: `${mintlifyOrigin}/:path*`,
      },
      {
        source: "/mintlify-assets/:path+",
        destination: `${mintlifyOrigin}/mintlify-assets/:path+`,
      },
    ];
  },
};

module.exports = withBotId(nextConfig);
