import type { Seed } from "@openwork/env";
import { denForAppWeb } from "./signed-in-app-web.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";
import { modelRemovalHttpFixture } from "./model-removal-cdp.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Real membership, provider setup and auth. Auth faults delay delivery, never fabricate identity. */
export async function organizationContinuity(seed: Seed) {
  await using setup = new AsyncDisposableStack();
  const { den, webPort } = await denForAppWeb(seed, { web: false, org: { name: "Planning organization" } });
  const organizationId = await seededOrganizationId(seed, den.admin);
  const created = await seed.api(den.admin, "/v1/org", { method: "POST", body: JSON.stringify({ name: "Other organization" }) });
  const other = isRecord(created.body) && isRecord(created.body.organization) ? created.body.organization : null;
  if (!created.response.ok || !other || typeof other.id !== "string") throw new Error("Could not arrange the second membership");
  const selected = await seed.api(den.admin, "/v1/me/active-organization", { method: "POST", body: JSON.stringify({ organizationId }) });
  if (!selected.response.ok) throw new Error("Could not select the initial organization");
  const provider = await seed.api(den.admin, "/v1/llm-providers", { method: "POST", body: JSON.stringify({
    name: "Planning models", source: "custom", allMembers: true, memberIds: [], teamIds: [], apiKey: "synthetic-onboarding-provider-key",
    customConfig: { id: "planning-models", name: "Planning models", npm: "@ai-sdk/openai-compatible", env: ["PLANNING_MODELS_KEY"],
      options: { baseURL: "http://127.0.0.1:9/v1" }, models: [{ id: "planning-model", name: "Planning model" }] },
  }) });
  if (!provider.response.ok) throw new Error(`Could not arrange the organization provider: ${provider.response.status}`);
  const app = await seed.appWeb({ den: den.ref, webPort, name: "organization-continuity", engine: "v2", headless: true,
    workspacePath: seed.tmpPath("organization-continuity"), env: { VITE_DEN_REQUIRE_SIGNIN: "1",
      ...(process.env.OPENWORK_OPENCODE2_BIN ? { OPENWORK_OPENCODE2_BIN: process.env.OPENWORK_OPENCODE2_BIN } : {}),
    } });
  await seed.signIn(app, den.admin, "admin");
  // The appWeb runtime already owns a bootstrap workspace. Reuse it instead
  // of asking the workspace-creation helper to recreate the same folder.
  const session = await seed.session(app, { title: "Saved planning conversation" });
  const navigation = await app.client.send("Page.getNavigationHistory");
  if (!isRecord(navigation) || !Array.isArray(navigation.entries) || typeof navigation.currentIndex !== "number") throw new Error("Missing browser destination");
  const entry = navigation.entries[navigation.currentIndex];
  if (!isRecord(entry) || typeof entry.url !== "string" || !entry.url.includes(session.sessionId)) throw new Error("The seeded conversation did not open its real destination");
  const conversationUrl = entry.url;
  let release: (() => void) | undefined;
  let hold: Promise<void> | undefined;
  let pausedReads = 0;
  const fixture = setup.use(await modelRemovalHttpFixture(app, ["*/v1/me", "*/api/den/v1/me"], async url => {
    if (url.pathname.endsWith("/v1/me") && hold) { pausedReads += 1; await hold; }
    return undefined; // Continue to real authorization after the delay.
  }));
  const resources = setup.move();
  return { app, den, organizationId, otherOrganizationId: other.id,
    onboardingUrl: `${app.webUrl}/onboarding`, accountUrl: `${app.webUrl}/settings/cloud-account`,
    conversationUrl,
    sessionId: session.sessionId,
    holdSignInChecks() { fixture.check(); hold = new Promise<void>(resolve => { release = resolve; }); },
    releaseSignInChecks() { release?.(); hold = undefined; },
    pausedReads() { fixture.check(); return pausedReads; },
    async [Symbol.asyncDispose]() { release?.(); await resources.disposeAsync(); },
  };
}
