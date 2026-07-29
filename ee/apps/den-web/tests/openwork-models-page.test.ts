import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INFERENCE_MODEL_ALIASES } from "@openwork/types/den/inference";

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

  test("cross-links to bring your own keys", () => {
    expect(screen).toContain("getCustomLlmProvidersRoute");
    expect(screen).toContain("Set up Bring your Own Keys.");
  });
});
