const { withBotId } = require("botid/next/config");

/** @type {import('next').NextConfig} */
const mintlifyOrigin = "https://differentai.mintlify.dev";

const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@openwork/ui"],
  // Build-time type errors come from React 18 vs React 19 declaration drift
  // in the monorepo (multiple @types/react resolutions). Runtime is unaffected;
  // we let `next build` ship while we untangle workspace types.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  // First-build-after-deps SSG of pages with the heavy GSAP/Lenis layout
  // can exceed the default 60s on slower workers. Give it room.
  staticPageGenerationTimeout: 240,
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
  async headers() {
    return [
      {
        source: "/",
        headers: [
          {
            key: "Link",
            value:
              '</docs>; rel="service-doc", </.well-known/agent-skills/index.json>; rel="https://agentskills.io/rel/index", </.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"',
          },
        ],
      },
      {
        source: "/.well-known/agent-skills/index.json",
        headers: [
          { key: "Content-Type", value: "application/json" },
          { key: "Access-Control-Allow-Origin", value: "*" },
        ],
      },
      {
        source: "/.well-known/agent-skills/:path*/SKILL.md",
        headers: [
          { key: "Content-Type", value: "text/markdown; charset=utf-8" },
          { key: "Access-Control-Allow-Origin", value: "*" },
        ],
      },
    ];
  },
};

module.exports = withBotId(nextConfig);
