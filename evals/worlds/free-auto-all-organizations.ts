import type { Seed } from "@openwork/env";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a Den response object");
  return Object.fromEntries(Object.entries(value));
}

export async function freeAutoAllOrganizations(seed: Seed) {
  const den = await seed.den({ web: true, env: {
    DEN_ORG_MODE: "multi_org", INFERENCE_FREE_ENABLED: "true",
    ANONYMOUS_INFERENCE_ENABLED: "false", PROVISIONER_MODE: "stub", RESEND_API_KEY: "", STRIPE_SECRET_KEY: "", SENTRY_DSN: "",
  }, org: { name: "Auto Studio", admin: { name: "Studio Admin" }, members: { teammate: { name: "Studio Member" } } } });
  const teammate = den.members.teammate;
  if (!teammate) throw new Error("Expected a studio member");
  const created = await seed.api(den.admin, "/v1/org", { method: "POST", body: JSON.stringify({ name: "Second Studio" }) });
  if (created.response.status !== 201) throw new Error("Could not seed the second organization");
  // The admin's active organization is now the one just created; the access probe below reads it.
  const second = record(record((await seed.api(den.admin, "/v1/org")).body).organization);
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/admin", headless: true, viewport: { width: 1440, height: 1100 } });
  const memberWeb = await seed.web({ den, signedInAs: teammate, startPath: "/admin", headless: true, viewport: { width: 1440, height: 1100 } });
  return { den, teammate, web, memberWeb, secondName: String(second.name) };
}
