import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INFERENCE_ACCESS_REASONS, INFERENCE_MODEL_ALIASES, managedModelCatalog } from "@openwork/types/den/inference";
import { freeAllowanceDescription, parseInferenceAccessPayload } from "../app/(den)/_lib/inference-status";

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
    expect(screen).toContain("Use for");
    expect(screen).toContain("Model ID");
  });

  test("describes every shipped model", () => {
    expect(screen).toContain("managedModelCatalog().map");
    expect(screen).not.toContain("MODEL_DETAILS");
    const catalog = managedModelCatalog();
    for (const [id, model] of Object.entries(INFERENCE_MODEL_ALIASES)) {
      if (!model.enabled) continue;
      expect(catalog.find((entry) => entry.modelID === id)?.summary.length).toBeGreaterThan(0);
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

  test("renders the configured free budget without claiming paid enablement", () => {
    const access = parseInferenceAccessPayload({ access: {
      kind: "free", modelID: "openai/gpt-5.6-luna", weeklyLimitUsd: 2,
      usedUsd: 0.2, reservedUsd: 0, remainingUsd: 1.8, resetsAt: "2026-09-14T00:00:00Z", reason: null, canUpgrade: false,
      token: "not-rendered",
    } });
    expect(access).not.toBeNull();
    expect(access?.canUpgrade).toBe(false);
    expect(access && "token" in access).toBe(false);
    expect(freeAllowanceDescription(access)).toContain("Free standard Luna.");
    expect(freeAllowanceDescription(access)).toContain("$1.80 of $2.00");
    expect(freeAllowanceDescription(access)).toContain("Resets");
    if (!access) throw new Error("Expected member access");
    expect(freeAllowanceDescription({ ...access, kind: "paid" })).toBeNull();
    expect(freeAllowanceDescription({ ...access, kind: "unavailable", reason: "free_disabled" })).toBeNull();
    expect(parseInferenceAccessPayload({ access: { ...access, canUpgrade: undefined } })).toBeNull();
    expect(screen).toContain('memberAccess?.canUpgrade !== false');
    expect(screen).toContain('"Ask admin"');
  });

  test("keeps free access while awaiting usage and never subtracts the pending estimate", () => {
    const busy = {
      kind: "free", modelID: "openai/gpt-5.6-luna", weeklyLimitUsd: 1, usedUsd: 0.2,
      reservedUsd: 0.1, remainingUsd: 0.8, resetsAt: "2026-09-14T00:00:00Z", reason: "free_request_in_progress", canUpgrade: false,
    };
    const access = parseInferenceAccessPayload({ access: busy });
    expect(access?.kind).toBe("free");
    expect(access?.reason).toBe("free_request_in_progress");
    expect(access?.remainingUsd).toBe(0.8);
    expect(freeAllowanceDescription(access)).toContain("Free standard Luna.");
    expect(freeAllowanceDescription(access)).toContain("$0.80 of $1.00");
    expect(freeAllowanceDescription(access)).toContain("awaiting final usage");
    expect(freeAllowanceDescription(access)).toContain("Estimated pending cost: $0.10; the final charge may differ.");
    for (const reason of INFERENCE_ACCESS_REASONS) {
      expect(parseInferenceAccessPayload({ access: { ...busy, reason } })).not.toBeNull();
    }
    expect(parseInferenceAccessPayload({ access: { ...busy, reason: "insufficient_request_budget" } })).toBeNull();
  });
});
