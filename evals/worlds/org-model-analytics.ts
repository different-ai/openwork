import { allocateFreePort } from "@openwork/cdp";
import type { Place, Seed } from "@openwork/env";

export async function orgModelAnalyticsWorld(seed: Seed, { place }: { place: Place }) {
  // This journey only reads stored Gateway usage, never calls an upstream.
  // Match the Gateway admin world: local URLs satisfy deployment validation;
  // the remote provisioner supplies its own Gateway URLs.
  const gatewayUrl = `http://127.0.0.1:${await allocateFreePort()}`;
  const den = await seed.den({
    web: true,
    schema: "migrate",
    org: { name: "Gateway reporting" },
    env: {
      DEN_ORG_MODE: "multi_org", DEN_PLAN_GATING_ENABLED: "false", GATEWAY_ENABLED: "true",
      ...(place.kind === "local" ? { NODE_ENV: "test", OPENWORK_DEV_MODE: "1", DB_MODE: "mysql", GATEWAY_PROXY_BASE_URL: gatewayUrl, GATEWAY_PUBLIC_BASE_URL: gatewayUrl } : {}),
      PROVISIONER_MODE: "stub", RESEND_API_KEY: "", STRIPE_SECRET_KEY: "", SENTRY_DSN: "",
    },
  });
  const provider = await seed.api(den.admin, "/v1/inference-providers", {
    method: "POST",
    body: JSON.stringify({
      name: "Reporting provider", providerId: "openrouter", modelIds: ["openai/gpt-4o-mini"],
      credential: { kind: "api_key", secret: "reporting-fixture-not-a-real-key" }, allMembers: true,
    }),
  });
  if (provider.response.status !== 201) throw new Error(`Reporting provider setup failed: HTTP ${provider.response.status}`);
  const web = await seed.web({
    den,
    signedInAs: den.admin,
    startPath: "/dashboard/ai-gateway",
    headless: true,
    viewport: { width: 1440, height: 1100 },
  });
  return { den, web };
}
