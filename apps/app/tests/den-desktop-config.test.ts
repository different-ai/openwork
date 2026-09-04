import { afterEach, describe, expect, test } from "bun:test";

import {
  calculateEffectiveAllowedBrowserHosts,
  desktopPolicyDocumentWriteSchema,
  normalizeAllowedBrowserHost,
  normalizeDesktopPolicyDocumentWrite,
  resolveDesktopPolicyDocumentWrite,
  selectEffectiveOnboardingPromptConfig,
  selectEffectiveOnboardingPrompts,
} from "@openwork/types/den/desktop-policies";
import { createDenClient, normalizeDenDesktopConfig } from "../src/app/lib/den";
import { resolveConnectStateToPush } from "../src/react-app/domains/cloud/desktop-config-provider";

const originalFetch = globalThis.fetch;

describe("Den desktop config client", () => {
  test("only reconciles an explicit Connect policy", () => {
    expect(resolveConnectStateToPush({})).toBeNull();
    expect(resolveConnectStateToPush({ connectEnabled: false })).toBe(false);
    expect(resolveConnectStateToPush({ connectEnabled: true })).toBe(true);
  });

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
      webUrl: null,
    });
  });

  test("reads the deployment web app base URL advertised by Den version metadata", async () => {
    const fetchMock: typeof fetch = async () => new Response(JSON.stringify({
      minAppVersion: "0.11.207",
      latestAppVersion: "0.17.24",
      publishedDesktopVersions: ["0.17.24"],
      webUrl: "https://app.den.test/",
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
      webUrl: "https://app.den.test",
    });
  });

  test("ignores a non-http web app base URL from Den version metadata", async () => {
    const fetchMock: typeof fetch = async () => new Response(JSON.stringify({
      minAppVersion: "0.11.207",
      latestAppVersion: "0.17.24",
      publishedDesktopVersions: ["0.17.24"],
      webUrl: "javascript:alert(1)",
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
    ).resolves.toMatchObject({ webUrl: null });
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

  test("normalizes the alpha update desktop policy", () => {
    expect(normalizeDenDesktopConfig({
      allowAlphaUpdates: false,
    }).allowAlphaUpdates).toBe(false);
    expect(normalizeDenDesktopConfig({
      allowAlphaUpdates: "false",
    }).allowAlphaUpdates).toBeUndefined();
  });

  test("normalizes only explicit Automation deployment availability", () => {
    expect(normalizeDenDesktopConfig({ automationsEnabled: false }).automationsEnabled).toBe(false);
    expect(normalizeDenDesktopConfig({ automationsEnabled: true }).automationsEnabled).toBe(true);
    expect(normalizeDenDesktopConfig({ automationsEnabled: "false" }).automationsEnabled).toBeUndefined();
    expect(normalizeDenDesktopConfig({}).automationsEnabled).toBeUndefined();
    expect(normalizeDenDesktopConfig({ dashboardEnabled: false }).dashboardEnabled).toBe(false);
    expect(normalizeDenDesktopConfig({ dashboardEnabled: true }).dashboardEnabled).toBe(true);
    expect(normalizeDenDesktopConfig({ dashboardEnabled: "true" }).dashboardEnabled).toBeUndefined();
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

  test("normalizes browser allowlist hosts to canonical host patterns", () => {
    expect(normalizeAllowedBrowserHost(" Example.COM. ")).toBe("example.com");
    expect(normalizeAllowedBrowserHost("*.example.com")).toBe("example.com");
    expect(normalizeAllowedBrowserHost("https://docs.example.com:8443/guide?x=1")).toBe("docs.example.com");
    expect(normalizeAllowedBrowserHost("user:secret@evil.example")).toBe("evil.example");
    expect(normalizeAllowedBrowserHost("bücher.example")).toBe("xn--bcher-kva.example");
    expect(normalizeAllowedBrowserHost("127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeAllowedBrowserHost("[::1]")).toBe("[::1]");
    expect(normalizeAllowedBrowserHost("intranet")).toBe("intranet");
    expect(normalizeAllowedBrowserHost("*")).toBe("*");
    expect(normalizeAllowedBrowserHost("")).toBeNull();
    expect(normalizeAllowedBrowserHost("exa mple.com")).toBeNull();
    expect(normalizeAllowedBrowserHost("*.")).toBeNull();
    expect(normalizeAllowedBrowserHost("docs.*.example.com")).toBeNull();
    expect(normalizeAllowedBrowserHost(42)).toBeNull();

    expect(normalizeDenDesktopConfig({
      allowedBrowserHosts: ["Example.com", "*.example.com", "https://docs.example.com/x", "", "not a host"],
    })).toEqual({ allowedBrowserHosts: ["example.com", "docs.example.com"] });
    expect(normalizeDenDesktopConfig({ allowedBrowserHosts: [] })).toEqual({});
    expect(normalizeDenDesktopConfig({ allowedBrowserHosts: "example.com" })).toEqual({});

    const rejected = desktopPolicyDocumentWriteSchema.safeParse({ allowedBrowserHosts: ["example.com", "not a host"] });
    expect(rejected.success).toBe(false);
    expect(desktopPolicyDocumentWriteSchema.safeParse({ allowedBrowserHosts: null }).success).toBe(true);
  });

  test("applies browser allowlist write semantics", () => {
    const existingPolicy = { allowZenModel: true, allowedBrowserHosts: ["example.com"] };

    expect(resolveDesktopPolicyDocumentWrite({
      value: { allowZenModel: false },
      existingPolicy,
      preserveExistingOnboardingPrompts: true,
    })).toEqual({ allowZenModel: false, allowedBrowserHosts: ["example.com"] });

    expect(resolveDesktopPolicyDocumentWrite({
      value: { allowedBrowserHosts: null },
      existingPolicy,
      preserveExistingOnboardingPrompts: true,
    })).toEqual({});

    expect(resolveDesktopPolicyDocumentWrite({
      value: { allowedBrowserHosts: [] },
      existingPolicy,
      preserveExistingOnboardingPrompts: true,
    })).toEqual({});

    expect(resolveDesktopPolicyDocumentWrite({
      value: { allowedBrowserHosts: ["*.Docs.example.com", "docs.example.com"] },
      existingPolicy,
      preserveExistingOnboardingPrompts: true,
    })).toEqual({ allowedBrowserHosts: ["docs.example.com"] });

    expect(resolveDesktopPolicyDocumentWrite({ value: { allowZenModel: false }, existingPolicy })).toEqual({
      allowZenModel: false,
    });
  });

  test("unions browser allowlists as grants anchored on the default policy", () => {
    expect(calculateEffectiveAllowedBrowserHosts({ orgPolicyCount: 0, assignedPolicies: [] })).toBeUndefined();

    // No allowlist on the default policy leaves the browser unrestricted, even
    // when a targeted policy carries one: targeted policies only add grants.
    expect(calculateEffectiveAllowedBrowserHosts({
      orgPolicyCount: 2,
      defaultPolicy: { allowZenModel: true },
      assignedPolicies: [{ allowedBrowserHosts: ["example.com"] }],
    })).toBeUndefined();

    expect(calculateEffectiveAllowedBrowserHosts({
      orgPolicyCount: 3,
      defaultPolicy: JSON.stringify({ allowedBrowserHosts: ["example.com"] }),
      assignedPolicies: [
        { allowedBrowserHosts: ["docs.partner.example", "example.com"] },
        { allowZenModel: false },
      ],
    })).toEqual(["example.com", "docs.partner.example"]);

    expect(calculateEffectiveAllowedBrowserHosts({
      orgPolicyCount: 2,
      defaultPolicy: { allowedBrowserHosts: ["example.com"] },
      assignedPolicies: [{ allowedBrowserHosts: ["*"] }],
    })).toBeUndefined();
  });
});
