import type { Seed } from "@openwork/env";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a Den response object");
  return Object.fromEntries(Object.entries(value));
}

export async function freeAutoRollout(seed: Seed) {
  const den = await seed.den({ web: true, env: {
    DEN_ORG_MODE: "multi_org", INFERENCE_FREE_ENABLED: "true", INFERENCE_FREE_ROLLOUT_ALL_ORGS: "false",
    ANONYMOUS_INFERENCE_ENABLED: "false", PROVISIONER_MODE: "stub", RESEND_API_KEY: "", STRIPE_SECRET_KEY: "", SENTRY_DSN: "",
  }, org: { name: "Auto Pilot Studio", admin: { name: "Pilot Admin" }, members: { teammate: { name: "Pilot Member" } } } });
  const teammate = den.members.teammate;
  if (!teammate) throw new Error("Expected a pilot member");
  const org = record(record((await seed.api(teammate, "/v1/org")).body).organization);
  const other = await seed.api(den.admin, "/v1/org", { method: "POST", body: JSON.stringify({ name: "Unenrolled Studio" }) });
  if (other.response.status !== 201) throw new Error("Could not seed the unenrolled organization");
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/admin", headless: true, viewport: { width: 1440, height: 1100 } });
  const memberWeb = await seed.web({ den, signedInAs: teammate, startPath: "/admin", headless: true, viewport: { width: 1440, height: 1100 } });
  return { den, teammate, web, memberWeb, orgId: String(org.id), slug: String(org.slug) };
}
