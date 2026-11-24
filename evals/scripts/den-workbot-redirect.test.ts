import assert from "node:assert/strict";
import { afterEach, vi } from "vitest";
import { test } from "@openwork/testkit";

import WorkbotPage from "../../ee/apps/den-web/app/(den)/workbot/page";

afterEach(() => vi.unstubAllEnvs());

async function expectNavigation(result: Promise<unknown>, digest: string) {
  await assert.rejects(result, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok("digest" in error);
    assert.equal(error.digest, digest);
    return true;
  });
}

test("a self-hosted operator disabling Workbot leaves no redirect to the hosted service", async ({ evidence }) => {
  vi.stubEnv("DEN_DEPLOYMENT", "self_hosted");
  vi.stubEnv("DEN_WORKBOT_URL", "");
  await expectNavigation(WorkbotPage({ searchParams: Promise.resolve({ organizationId: "org_local" }) }), "NEXT_HTTP_ERROR_FALLBACK;404");
  evidence.recordAssertionEvidence("self-hosted entry is unavailable", "The actual page invokes notFound without invoking a hosted redirect", true);
});

for (const deployment of [undefined, "", "unknown"]) {
  test(`the ${deployment ?? "unset"} deployment preserves the legacy hosted redirect and organization query`, async ({ evidence }) => {
    vi.stubEnv("DEN_DEPLOYMENT", deployment);
    vi.stubEnv("DEN_WORKBOT_URL", "");
    await expectNavigation(WorkbotPage({ searchParams: Promise.resolve({ organizationId: "org_legacy" }) }), "NEXT_REDIRECT;replace;https://chat.openworklabs.com/?organization=org_legacy;307;");
    evidence.recordAssertionEvidence("legacy hosted redirect is preserved", "The actual page redirects to hosted Workbot with the organization query without requiring a deployment environment setting", true);
  });
}

test("Cloud retains its hosted Workbot redirect", async ({ evidence }) => {
  vi.stubEnv("DEN_DEPLOYMENT", "cloud");
  vi.stubEnv("DEN_WORKBOT_URL", "");
  await expectNavigation(WorkbotPage({ searchParams: Promise.resolve({ organizationId: "org_cloud" }) }), "NEXT_REDIRECT;replace;https://chat.openworklabs.com/?organization=org_cloud;307;");
  evidence.recordAssertionEvidence("Cloud behavior is preserved", "The actual page redirects to hosted Workbot with the requested organization", true);
});

for (const deployment of [undefined, "unknown", "self_hosted", "cloud"]) {
  test(`the ${deployment ?? "unset"} deployment's explicit Workbot URL wins over fallback policy`, async ({ evidence }) => {
    vi.stubEnv("DEN_DEPLOYMENT", deployment);
    vi.stubEnv("DEN_WORKBOT_URL", "https://manual.example.test/chat?source=den");
    await expectNavigation(WorkbotPage({ searchParams: Promise.resolve({ organizationId: "org_local" }) }), "NEXT_REDIRECT;replace;https://manual.example.test/chat?source=den&organization=org_local;307;");
    evidence.recordAssertionEvidence("manual deployment semantics are preserved", "The actual page uses the configured manual origin/path/query and forwards the organization regardless of deployment classification", true);
  });
}
