import assert from "node:assert/strict";
import { afterEach, vi } from "vitest";
import { test } from "@openwork/testkit";

vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  redirect: (url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); },
}));

import WorkbotPage from "../../ee/apps/den-web/app/(den)/workbot/page";

afterEach(() => vi.unstubAllEnvs());

test("a self-hosted operator disabling Workbot leaves no redirect to the hosted service", async ({ evidence }) => {
  vi.stubEnv("DEN_DEPLOYMENT", "self_hosted");
  vi.stubEnv("DEN_WORKBOT_URL", "");
  await assert.rejects(WorkbotPage({ searchParams: Promise.resolve({ organizationId: "org_local" }) }), /^Error: NEXT_NOT_FOUND$/);
  evidence.recordAssertionEvidence("self-hosted entry is unavailable", "The actual page invokes notFound without invoking a hosted redirect", true);
});

for (const deployment of [undefined, "", "unknown"]) {
  test(`the ${deployment ?? "unset"} deployment preserves the legacy hosted redirect and organization query`, async ({ evidence }) => {
    vi.stubEnv("DEN_DEPLOYMENT", deployment);
    vi.stubEnv("DEN_WORKBOT_URL", "");
    await assert.rejects(WorkbotPage({ searchParams: Promise.resolve({ organizationId: "org_legacy" }) }), /^Error: NEXT_REDIRECT:https:\/\/chat\.openworklabs\.com\/\?organization=org_legacy$/);
    evidence.recordAssertionEvidence("legacy hosted redirect is preserved", "The actual page redirects to hosted Workbot with the organization query without requiring a deployment environment setting", true);
  });
}

test("Cloud retains its hosted Workbot redirect", async ({ evidence }) => {
  vi.stubEnv("DEN_DEPLOYMENT", "cloud");
  vi.stubEnv("DEN_WORKBOT_URL", "");
  await assert.rejects(WorkbotPage({ searchParams: Promise.resolve({ organizationId: "org_cloud" }) }), /^Error: NEXT_REDIRECT:https:\/\/chat\.openworklabs\.com\/\?organization=org_cloud$/);
  evidence.recordAssertionEvidence("Cloud behavior is preserved", "The actual page redirects to hosted Workbot with the requested organization", true);
});

for (const deployment of [undefined, "unknown", "self_hosted", "cloud"]) {
  test(`the ${deployment ?? "unset"} deployment's explicit Workbot URL wins over fallback policy`, async ({ evidence }) => {
    vi.stubEnv("DEN_DEPLOYMENT", deployment);
    vi.stubEnv("DEN_WORKBOT_URL", "https://manual.example.test/chat?source=den");
    await assert.rejects(WorkbotPage({ searchParams: Promise.resolve({ organizationId: "org_local" }) }), /^Error: NEXT_REDIRECT:https:\/\/manual\.example\.test\/chat\?source=den&organization=org_local$/);
    evidence.recordAssertionEvidence("manual deployment semantics are preserved", "The actual page uses the configured manual origin/path/query and forwards the organization regardless of deployment classification", true);
  });
}
