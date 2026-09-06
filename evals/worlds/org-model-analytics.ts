import type { Seed } from "@openwork/env";

export async function orgModelAnalyticsWorld(seed: Seed) {
  const den = await seed.den({ web: true, org: { name: "Analytics team" }, env: { DEN_ORG_MODE: "multi_org", DEN_PLAN_GATING_ENABLED: "false" } });
  const placement = den.placement?.kind === "daytona" ? { sandboxId: den.placement.sandboxId } : {};
  const apiLink = await seed.denLink({ ...den, ref: { ...den.ref, webUrl: den.ref.apiUrl } }, { ...placement, port: 3987, adminPort: 3988 });
  // DenLink owns one process per sandbox. Use the separate web fault proxy
  // for runtime configuration so it cannot replace the API observer.
  const webLink = await seed.faultProxy(den);
  const runtimeConfig: unknown = await fetch(`${den.ref.webUrl}/api/runtime-config`, { signal: AbortSignal.timeout(5_000) }).then((response) => response.json());
  if (!runtimeConfig || typeof runtimeConfig !== "object") throw new Error("Missing runtime configuration");
  await webLink.faults.status("/api/runtime-config", 200, { times: 10_000,
    body: { ...runtimeConfig, denApiUrl: apiLink.ref.webUrl } });
  const web = await seed.web({ den: { ...den, ref: { webUrl: webLink.ref.webUrl, apiUrl: apiLink.ref.webUrl } }, signedInAs: den.admin,
    startPath: "/dashboard/analytics", headless: true, viewport: { width: 1440, height: 1100 } });
  return { den, web, apiLink };
}
