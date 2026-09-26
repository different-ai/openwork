const { withBotId } = require("botid/next/config");

/** @type {import('next').NextConfig} */
const mintlifyOrigin = "https://differentai.mintlify.dev";

const ALIAS_HOSTS = [
  "openwork.software",
  "www.openwork.software",
  "openworkapp.com",
  "www.openworkapp.com",
  "openwork.studio",
  "www.openwork.studio",
  "openworkco.com",
  "www.openworkco.com",
  "www.openworklabs.com",
];

const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@openwork/ui"],
  // Lets evals build/serve a production instance beside next dev without clobbering .next.
  distDir: process.env.LANDING_DIST_DIR || ".next",
  // Bake VERCEL_ENV at build time so the PostHog gate in app/layout.tsx
  // behaves per-deployment: on Vercel the build env matches the runtime env,
  // and local `next start` mirrors what was built.
  env: {
    VERCEL_ENV: process.env.VERCEL_ENV || "",
  },
  // Alias domains serve the same build; send them to the canonical host so
  // search and answer engines don't split citations across duplicate URLs.
  async redirects() {
    return ALIAS_HOSTS.map((host) => ({
      source: "/:path*",
      has: [{ type: "host", value: host }],
      destination: "https://openworklabs.com/:path*",
      permanent: true,
    }));
  },
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
              '</docs>; rel="service-doc", </llms.txt>; rel="llms-txt", </.well-known/agent-skills/index.json>; rel="https://agentskills.io/rel/index", </.well-known/agent-skills/index.json>; rel="agent-skills", </.well-known/mcp/server-card.json>; rel="mcp-server-card", </.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"',
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
        source: "/.well-known/mcp.json",
        headers: [
          { key: "Content-Type", value: "application/json" },
          { key: "Access-Control-Allow-Origin", value: "*" },
        ],
      },
      {
        source: "/.well-known/mcp/server-card.json",
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
