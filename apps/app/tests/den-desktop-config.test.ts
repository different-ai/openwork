import { afterEach, describe, expect, test } from "bun:test";

import {
  normalizeDesktopPolicyDocumentWrite,
  resolveDesktopPolicyDocumentWrite,
  selectEffectiveOnboardingPromptConfig,
  selectEffectiveOnboardingPrompts,
} from "@openwork/types/den/desktop-policies";
import { createDenClient, normalizeDenDesktopConfig } from "../src/app/lib/den";

const originalFetch = globalThis.fetch;

describe("Den desktop config client", () => {
  afterEach(() => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
  });

  test("pins desktop config requests to the active organization", async () => {
    const headers: Headers[] = [];
    const fetchMock: typeof fetch = async (_input, init) => {
      headers.push(new Headers(init?.headers));
      return new Response(JSON.stringify({ connectEnabled: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: fetchMock,
    });

    await createDenClient({ baseUrl: "https://den.test", token: "tok_test" }).getDesktopConfig("org_test");

    expect(headers[0]?.get("x-openwork-legacy-org-id")).toBe("org_test");
  });

  test("falls back to latestAppVersion for older Den version metadata", async () => {
    const fetchMock: typeof fetch = async () => new Response(JSON.stringify({
      minAppVersion: "0.11.207",
      latestAppVersion: "0.17.24",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: fetchMock,
    });

    await expect(
      createDenClient({ baseUrl: "https://den.test" }).getAppVersionMetadata(),
    ).resolves.toEqual({
      minAppVersion: "0.11.207",
      latestAppVersion: "0.17.24",
      publishedDesktopVersions: ["0.17.24"],
    });
  });

  test("normalizes organization onboarding prompts from desktop config", () => {
    expect(normalizeDenDesktopConfig({
      onboardingPrompts: [" First task ", "Second task", "Third task"],
      onboardingPromptDescriptions: [" First card ", "Second card", ""],
    }).onboardingPrompts).toEqual(["First task", "Second task", "Third task"]);
    expect(normalizeDenDesktopConfig({
      onboardingPrompts: [" First task ", "Second task", "Third task"],
      onboardingPromptDescriptions: [" First card ", "Second card", ""],
    }).onboardingPromptDescriptions).toEqual(["First card", "Second card", ""]);

    expect(normalizeDenDesktopConfig({
      onboardingPrompts: ["First task", "   "],
    }).onboardingPrompts).toBeUndefined();
    expect(normalizeDenDesktopConfig({
      onboardingPrompts: ["First task", "Second task", "Third task"],
      onboardingPromptDescriptions: ["Mismatched", "Descriptions"],
    }).onboardingPromptDescriptions).toBeUndefined();
  });

  test("selects targeted onboarding prompts by priority before default fallback", () => {
    const defaultPrompts = ["Default task one", "Default task two"];

    expect(selectEffectiveOnboardingPrompts({
      defaultPolicy: { onboardingPrompts: defaultPrompts },
      assignedPolicies: [{
        id: "policy_without_prompts",
        priority: 100,
        createdAt: "2026-01-01T00:00:00.000Z",
        policy: { allowZenModel: true },
      }],
    })).toEqual(defaultPrompts);

    expect(selectEffectiveOnboardingPrompts({
      defaultPolicy: { onboardingPrompts: defaultPrompts },
      assignedPolicies: [
        {
          id: "policy_later",
          priority: 10,
          createdAt: "2026-01-03T00:00:00.000Z",
          policy: { onboardingPrompts: ["Later high priority", "Later follow-up"] },
        },
        {
          id: "policy_earlier",
          priority: 10,
          createdAt: "2026-01-02T00:00:00.000Z",
          policy: { onboardingPrompts: ["Earlier high priority", "Earlier follow-up"] },
        },
        {
          id: "policy_earlier",
          priority: 10,
          createdAt: "2026-01-02T00:00:00.000Z",
          policy: { onboardingPrompts: ["Duplicate should not matter", "Duplicate follow-up"] },
        },
        {
          id: "policy_low",
          priority: 1,
          createdAt: "2026-01-01T00:00:00.000Z",
          policy: { onboardingPrompts: ["Low priority", "Low follow-up"] },
        },
      ],
    })).toEqual(["Earlier high priority", "Earlier follow-up"]);

    expect(selectEffectiveOnboardingPrompts({
      assignedPolicies: [
        {
          id: "policy_b",
          priority: 5,
          createdAt: "2026-01-02T00:00:00.000Z",
          policy: { onboardingPrompts: ["Policy B", "Policy B follow-up"] },
        },
        {
          id: "policy_a",
          priority: 5,
          createdAt: "2026-01-02T00:00:00.000Z",
          policy: { onboardingPrompts: ["Policy A", "Policy A follow-up"] },
        },
      ],
    })).toEqual(["Policy A", "Policy A follow-up"]);

    expect(selectEffectiveOnboardingPromptConfig({
      defaultPolicy: {
        onboardingPrompts: defaultPrompts,
        onboardingPromptDescriptions: ["Default card", "Default follow-up card"],
      },
      assignedPolicies: [{
        id: "policy_with_descriptions",
        priority: 20,
        createdAt: "2026-01-04T00:00:00.000Z",
        policy: {
          onboardingPrompts: ["Targeted task", "Targeted follow-up"],
          onboardingPromptDescriptions: ["Targeted card", "Targeted follow-up card"],
        },
      }],
    })).toEqual({
      onboardingPrompts: ["Targeted task", "Targeted follow-up"],
      onboardingPromptDescriptions: ["Targeted card", "Targeted follow-up card"],
    });
  });

  test("applies desktop policy prompt write semantics", () => {
    const existingPolicy = {
      allowZenModel: true,
      onboardingPrompts: ["Existing prompt", "Existing follow-up"],
      onboardingPromptDescriptions: ["Existing card", "Existing follow-up card"],
    };

    expect(resolveDesktopPolicyDocumentWrite({
      value: { allowZenModel: false },
      existingPolicy,
      preserveExistingOnboardingPrompts: true,
    })).toEqual({
      allowZenModel: false,
      onboardingPrompts: ["Existing prompt", "Existing follow-up"],
      onboardingPromptDescriptions: ["Existing card", "Existing follow-up card"],
    });

    expect(resolveDesktopPolicyDocumentWrite({
      value: { allowZenModel: false, onboardingPrompts: null },
      existingPolicy,
      preserveExistingOnboardingPrompts: true,
    })).toEqual({ allowZenModel: false });

    expect(resolveDesktopPolicyDocumentWrite({
      value: { onboardingPrompts: [" Replacement ", "Replacement follow-up"] },
      existingPolicy,
      preserveExistingOnboardingPrompts: true,
    })).toEqual({ onboardingPrompts: ["Replacement", "Replacement follow-up"] });

    expect(resolveDesktopPolicyDocumentWrite({
      value: {
        onboardingPrompts: [" Replacement ", "Replacement follow-up"],
        onboardingPromptDescriptions: [" Replacement card ", ""],
      },
      existingPolicy,
      preserveExistingOnboardingPrompts: true,
    })).toEqual({
      onboardingPrompts: ["Replacement", "Replacement follow-up"],
      onboardingPromptDescriptions: ["Replacement card", ""],
    });

    expect(resolveDesktopPolicyDocumentWrite({
      value: { onboardingPrompts: null },
    })).toEqual({});

    expect(normalizeDesktopPolicyDocumentWrite({ onboardingPrompts: null })).toEqual({
      onboardingPrompts: null,
      onboardingPromptDescriptions: null,
    });
  });
});
