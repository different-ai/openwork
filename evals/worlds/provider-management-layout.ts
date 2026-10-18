import type { Seed } from "@openwork/env";
import { seededOrganizationId } from "./organization-capabilities.ts";

export async function providerManagementLayout(seed: Seed) {
  const den = await seed.den({
    org: { name: "Provider workspace", admin: { name: "Provider Owner" } },
    env: { GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: "http://127.0.0.1:9", GATEWAY_PUBLIC_BASE_URL: "http://127.0.0.1:9" },
  });
  const orgId = await seededOrganizationId(seed, den.admin);
  if (!orgId) throw new Error("Expected the seeded organization.");
  const gateway = await seed.api(den.admin, "/v1/inference-providers", {
    method: "POST", body: JSON.stringify({
      name: "Shared gateway models", providerId: "openai", modelIds: ["gpt-4o-mini"],
      credential: { kind: "api_key", secret: "synthetic-layout-key" }, allMembers: true,
    }),
  });
  if (!gateway.response.ok) throw new Error(`Create gateway provider: HTTP ${gateway.response.status} ${gateway.text.slice(0, 300)}`);
  const legacy = await seed.api(den.admin, "/v1/llm-providers", {
    method: "POST", body: JSON.stringify({
      name: "Shared desktop credentials with a long provider name", source: "custom", allMembers: true,
      customConfig: { id: "layout-legacy", name: "Desktop provider", npm: "@ai-sdk/openai-compatible", env: ["LAYOUT_API_KEY"], api: "https://example.test/v1", models: [{ id: "layout-model", name: "Layout model", tool_call: true, limit: { context: 32000, output: 1024 } }] },
      apiKey: "synthetic-layout-key",
    }),
  });
  if (!legacy.response.ok) throw new Error(`Create legacy provider: HTTP ${legacy.response.status} ${legacy.text.slice(0, 300)}`);
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/ai-gateway?tab=ai-providers", headless: true, viewport: { width: 1440, height: 1000 } });
  return { den, web, orgId, url: (path: string) => new URL(path, den.ref.webUrl).toString() };
}
