import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INFERENCE_MODEL_ALIASES } from "@openwork/types/den/inference";
import { getInferenceRoute } from "../app/(den)/_lib/den-org";
import InferencePage from "../app/(den)/dashboard/(admin)/inference/page";
import { getURLFromRedirectError } from "next/dist/client/components/redirect";

const screen = readFileSync(
  join(import.meta.dir, "..", "app", "(den)", "dashboard", "_components", "inference-screen.tsx"),
  "utf8",
);

describe("OpenWork Models page", () => {
  test("leads with the flat page header instead of the gradient hero", () => {
    expect(screen).toContain("DenPageHeader");
    expect(screen).toContain("Reliable, hand-picked models for knowledge work.");
    expect(screen).not.toContain("DashboardPageTemplate");
  });

  test("passes embedded layout through the guarded, organization-keyed content", () => {
    expect(screen).toContain('<InferenceContent key={dashboard.orgId} embedded={embedded} />');
    expect(screen).toContain('embedded ? "grid gap-6"');
    expect(screen).toContain('embedded ? <DenSectionHeader title="OpenWork Models"');
    expect(screen).toContain('description={<>{description}<span className="block">{caption}</span></>}');
    expect(screen).toContain('$10 / user / month');
    expect(screen).toContain('One subscription activates models for everyone in your workspace.');
  });

  test("renders the lineup through the shared table primitive", () => {
    for (const primitive of ["DenTable", "DenCard", "DenSectionHeader", "DenNotice", "DenButton"]) {
      expect(screen).toContain(primitive);
    }
    expect(screen).toContain('headerTone="plain"');
    expect(screen).toContain("Best for");
    expect(screen).toContain("Model ID");
  });

  test("describes every shipped model", () => {
    for (const [id, model] of Object.entries(INFERENCE_MODEL_ALIASES)) {
      if (!model.enabled) continue;
      expect(screen).toContain(`"${id}": { bestFor:`);
    }
  });

  test("keeps the billing subscribe and enable flows", () => {
    expect(screen).toContain(': "Subscribe";');
    expect(screen).not.toContain("Subscribe with Stripe");
    expect(screen).toContain("Manage subscription");
    expect(screen).toContain("/v1/billing/stripe/checkout");
    expect(screen).toContain('method: "PATCH"');
  });

  test("restores shared usage meters above the lineup without removing them from Analytics", () => {
    const analytics = readFileSync(
      join(import.meta.dir, "..", "app", "(den)", "dashboard", "_features", "analytics", "models-analytics-screen.tsx"),
      "utf8",
    );
    expect(screen).toContain('import { UsageLimitsCard } from "../_features/analytics/usage-limits-card";');
    expect(screen).toContain("{enabled && status ? <UsageLimitsCard buckets={status.buckets} /> : null}");
    expect(screen.indexOf("<UsageLimitsCard")).toBeLessThan(screen.indexOf("<ModelsLineup"));
    expect(analytics).toContain("<UsageLimitsCard buckets={status.data.buckets} />");
  });

  test.each(["workspace", null, undefined])("canonical Models destination for %s includes exactly one tab query", (orgSlug) => {
    expect(getInferenceRoute(orgSlug)).toBe("/dashboard/ai-gateway?tab=openwork-models");
  });

  test.each([
    {},
    { return: "models", session_id: "session?value&more=1" },
    { tag: ["first", "second"], empty: "", missing: undefined },
    { tab: "limits", tag: ["first", "second"] },
    { tab: ["limits", "ai-providers"], ref: "desktop" },
  ])("legacy server redirect preserves repeated query values and cannot override the Models tab: %j", async (searchParams) => {
    let destination: string | null = null;
    try {
      await InferencePage({ searchParams: Promise.resolve(searchParams) });
    } catch (error) {
      destination = getURLFromRedirectError(error);
    }
    expect(destination).not.toBeNull();
    const url = new URL(destination ?? "", "https://app.example.test");
    expect(url.pathname).toBe("/dashboard/ai-gateway");
    expect(url.searchParams.getAll("tab")).toEqual(["openwork-models"]);
    for (const [key, value] of Object.entries(searchParams)) {
      if (key === "tab") continue;
      expect(url.searchParams.getAll(key)).toEqual(value === undefined ? [] : Array.isArray(value) ? value : [value]);
    }
  });

  test("billing, post-auth, onboarding and analytics use the canonical Models helper", () => {
    for (const path of [
      ["dashboard", "(admin)", "billing", "stripe", "checking", "page.tsx"],
      ["dashboard", "_components", "billing-dashboard-screen.tsx"],
      ["dashboard", "_components", "onboarding-tools-screen.tsx"],
      ["dashboard", "_components", "marketplace-onboarding-screen.tsx"],
      ["dashboard", "_features", "analytics", "models-analytics-screen.tsx"],
      ["_providers", "den-flow-provider.tsx"],
    ]) {
      const source = readFileSync(join(import.meta.dir, "..", "app", "(den)", ...path), "utf8");
      expect(source).toContain("getInferenceRoute(");
      expect(source).not.toContain("/dashboard/inference");
      expect(source).not.toMatch(/getInferenceRoute\([^)]*\)\}\?/);
    }
  });

  test("cross-links to bring your own keys", () => {
    expect(screen).toContain("getCustomLlmProvidersRoute");
    expect(screen).toContain("Set up Bring your Own Keys.");
  });
});
