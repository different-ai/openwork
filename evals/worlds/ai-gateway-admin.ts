import { allocateFreePort } from "@openwork/cdp";
import type { Place, Seed } from "@openwork/env";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a Den response object");
  return Object.fromEntries(Object.entries(value));
}

/**
 * An owner and a teammate in one org on a Den with the AI Gateway deployed.
 * The journey is the Den admin form, so no request ever reaches the gateway:
 * locally the proxy URLs only satisfy den-api's GATEWAY_ENABLED boot check and
 * point at a closed port; on Daytona the provisioner starts the real gateway
 * next to Den and derives its URLs itself.
 */
export async function aiGatewayAdmin(seed: Seed, { place }: { place: Place }) {
  const local = place.kind === "local";
  const gatewayUrl = `http://127.0.0.1:${await allocateFreePort()}`;
  const den = await seed.den({
    web: true,
    env: {
      DEN_ORG_MODE: "multi_org", GATEWAY_ENABLED: "true",
      ...(local ? { NODE_ENV: "test", OPENWORK_DEV_MODE: "1", DB_MODE: "mysql", GATEWAY_PROXY_BASE_URL: gatewayUrl, GATEWAY_PUBLIC_BASE_URL: gatewayUrl } : {}),
      PROVISIONER_MODE: "stub", RESEND_API_KEY: "", STRIPE_SECRET_KEY: "", SENTRY_DSN: "",
    },
    org: {
      name: "Acme Studio",
      admin: { name: "Gateway Owner", email: "gateway-owner@example.test" },
      members: { teammate: { name: "Gateway Teammate", email: "gateway-teammate@example.test" } },
    },
  });
  const teammate = den.members.teammate;
  if (!teammate) throw new Error("Expected a teammate session");
  const org = record((await seed.api(den.admin, "/v1/org")).body);
  const orgId = String(record(org.organization).id);
  const viewport = { width: 1440, height: 1100 };
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/ai-gateway?tab=ai-providers", headless: true, viewport });
  const memberWeb = await seed.web({ den, signedInAs: teammate, startPath: "/dashboard", headless: true, viewport });
  return { den, web, memberWeb, teammate, orgId };
}
