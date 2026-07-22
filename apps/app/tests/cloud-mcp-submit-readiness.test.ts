import { describe, expect, test } from "bun:test";

import type {
  OpenworkCloudMcpFailure,
  OpenworkCloudMcpHealth,
} from "../src/app/lib/openwork-server";
import {
  createCloudMcpSubmissionCoordinator,
  decideCloudMcpSubmissionGate,
  ensureCloudMcpSubmissionReadiness,
  resolveCloudMcpSubmissionAuth,
  type CloudMcpSubmissionGateDecision,
  type CloudMcpSubmissionPreparationResult,
} from "../src/react-app/domains/connections/cloud-mcp-submit-readiness";

const PROVIDER_MODEL = { provider: "openwork", model: "gpt-5" };

function failure(input?: Partial<OpenworkCloudMcpFailure>): OpenworkCloudMcpFailure {
  return {
    code: input?.code ?? "cloud_registration_failed",
    stage: input?.stage ?? "engine_delivery",
    retryable: input?.retryable ?? true,
    recommendedAction: input?.recommendedAction ?? "Retry",
    message: input?.message ?? "Cloud tools are not ready.",
  };
}

function health(input?: {
  usable?: boolean;
  firstFailure?: OpenworkCloudMcpFailure | null;
  projectionSource?: "experimental_tool" | "provider_capability";
}): OpenworkCloudMcpHealth {
  const usable = input?.usable ?? true;
  const projectionSource = input?.projectionSource ?? "experimental_tool";
  const projected = usable
    ? ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"]
    : [];
  const direct = usable ? ["search_capabilities", "execute_capability"] : [];
  return {
    schemaVersion: 1,
    phase: usable ? "ready" : "registration_failed",
    usable,
    usableByCurrentModel: usable,
    connectCatalogEnabled: true,
    workspace: { id: "workspace_1", type: "local", directory: "/workspace", path: "/workspace" },
    desired: {
      present: true,
      name: "openwork-cloud",
      revision: "rev_1",
      config: { type: "remote", enabled: true },
      token: { present: true, metadata: {} },
    },
    delivery: {
      state: usable ? "ready" : "failed",
      desiredRevision: "rev_1",
      appliedRevision: usable ? "rev_1" : null,
      updatedAt: 1,
      appliedAt: usable ? 1 : null,
      lastAttemptAt: 1,
    },
    engine: { status: usable ? "connected" : "missing" },
    tools: {
      expected: ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"],
      present: projected,
      missing: usable ? [] : ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"],
      direct: {
        checked: true,
        source: "mcp_tools_list",
        expected: ["search_capabilities", "execute_capability"],
        present: direct,
        missing: usable ? [] : ["search_capabilities", "execute_capability"],
      },
      providerProjection: {
        checked: true,
        provider: PROVIDER_MODEL.provider,
        model: PROVIDER_MODEL.model,
        source: projectionSource,
        ...(projectionSource === "provider_capability"
          ? {
              limitation: "Only generic model tool-call capability is available.",
              modelExists: true,
              toolCalling: true,
            }
          : {}),
        present: projected,
        missing: usable ? [] : ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"],
      },
    },
    pluginCanaries: { expected: ["openwork_docs_search"], present: usable ? ["openwork_docs_search"] : [], missing: usable ? [] : ["openwork_docs_search"] },
    compatibility: {
      openwork: { serverVersion: "test", app: null },
      opencode: { expectedVersion: "test", actualVersion: "test", probe: "ok" },
      pluginFileHashes: [],
      supportedFeatures: { dynamicMcp: true, directoryScoping: true, toolIds: true, providerToolProjection: projectionSource === "experimental_tool", pluginCanaries: true },
      experimentalToolIds: {
        checked: true,
        expected: ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"],
        present: projected,
        missing: usable ? [] : ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"],
        includesMcpTools: usable,
      },
      experimentalProviderTools: {
        checked: true,
        provider: PROVIDER_MODEL.provider,
        model: PROVIDER_MODEL.model,
        expected: ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"],
        present: projected,
        missing: usable ? [] : ["openwork-cloud_search_capabilities", "openwork-cloud_execute_capability"],
        includesMcpTools: projectionSource === "experimental_tool" && usable,
      },
    },
    toolDenies: [],
    firstFailure: usable ? input?.firstFailure ?? null : input?.firstFailure ?? failure(),
    checkedAt: "2026-07-15T00:00:00.000Z",
  };
}

function requiredDecision(input?: {
  authStatus?: "checking" | "signed_in" | "unavailable" | "signed_out";
  hasSessionToken?: boolean;
  userState?: "disabled" | "removed" | null;
  workspaceId?: string;
  model?: string;
}) {
  return decideCloudMcpSubmissionGate({
    cloudAuthStatus: input?.authStatus ?? "signed_in",
    cloudHasSessionToken: input?.hasSessionToken ?? true,
    denBaseUrl: "https://app.openwork.test",
    serverBaseUrl: "https://worker.openwork.test",
    orgId: "org_1",
    workspaceId: input?.workspaceId ?? "workspace_1",
    providerModel: { ...PROVIDER_MODEL, model: input?.model ?? PROVIDER_MODEL.model },
    userState: input?.userState ?? null,
  });
}

function preparation(input: {
  check: () => Promise<OpenworkCloudMcpHealth | null>;
  repair: () => Promise<OpenworkCloudMcpHealth | null>;
}): () => Promise<CloudMcpSubmissionPreparationResult> {
  return async () => {
    const result = await ensureCloudMcpSubmissionReadiness({
      providerModel: PROVIDER_MODEL,
      check: input.check,
      repair: input.repair,
      retryDelaysMs: [0],
      attemptTimeoutMs: 0,
    });
    if (result.outcome === "ready") return { outcome: "ready" };
    if (result.outcome === "bypass") return { outcome: "bypass" };
    return { outcome: "failed", issue: result.issue };
  };
}

describe("Cloud MCP pre-send readiness", () => {
  test("ready projected tools send immediately", async () => {
    const coordinator = createCloudMcpSubmissionCoordinator();
    const decision = requiredDecision();
    let checks = 0;
    let repairs = 0;
    let runs = 0;
    const result = await coordinator.submit({
      scopeKey: decision.scopeKey,
      prepare: preparation({
        check: async () => {
          checks += 1;
          return health();
        },
        repair: async () => {
          repairs += 1;
          return health();
        },
      }),
      send: async () => {
        runs += 1;
      },
    });

    expect(result).toEqual({ outcome: "sent", bypassed: false });
    expect({ checks, repairs, runs }).toEqual({ checks: 1, repairs: 0, runs: 1 });
  });

  test("a transient startup failure repairs and sends exactly once", async () => {
    const coordinator = createCloudMcpSubmissionCoordinator();
    const decision = requiredDecision();
    let repairs = 0;
    let runs = 0;
    const result = await coordinator.submit({
      scopeKey: decision.scopeKey,
      prepare: preparation({
        check: async () => health({ usable: false, firstFailure: failure({ retryable: true }) }),
        repair: async () => {
          repairs += 1;
          return health();
        },
      }),
      send: async () => {
        runs += 1;
      },
    });

    expect(result).toEqual({ outcome: "sent", bypassed: false });
    expect(repairs).toBe(1);
    expect(runs).toBe(1);
  });

  test("a cached Cloud session waits for auth restoration and sends exactly once", async () => {
    const coordinator = createCloudMcpSubmissionCoordinator();
    const checking = requiredDecision({ authStatus: "checking", hasSessionToken: true });
    const signedIn = requiredDecision();
    expect(checking.mode).toBe("waiting_for_auth");
    expect(checking.scopeKey).toBe(signedIn.scopeKey);

    let resolveAuth: ((decision: CloudMcpSubmissionGateDecision) => void) | null = null;
    const authResolution = new Promise<CloudMcpSubmissionGateDecision>((resolve) => {
      resolveAuth = resolve;
    });
    let checks = 0;
    let runs = 0;
    const input = {
      scopeKey: checking.scopeKey,
      prepare: async (): Promise<CloudMcpSubmissionPreparationResult> => {
        const resolution = await resolveCloudMcpSubmissionAuth({
          decision: checking,
          waitForResolution: () => authResolution,
          timeoutMs: 0,
        });
        if (resolution.outcome === "failed") {
          return { outcome: "failed", issue: resolution.issue };
        }
        if (resolution.decision.mode === "bypass") return { outcome: "bypass" };
        if (resolution.decision.mode !== "required") {
          return { outcome: "cancelled", reason: "context_changed" };
        }
        return preparation({
          check: async () => {
            checks += 1;
            return health();
          },
          repair: async () => health(),
        })();
      },
      send: async () => {
        runs += 1;
      },
    };

    const first = coordinator.submit(input);
    const second = coordinator.submit(input);
    expect(second).toBe(first);
    expect({ checks, runs }).toEqual({ checks: 0, runs: 0 });
    resolveAuth?.(signedIn);

    await expect(first).resolves.toEqual({ outcome: "sent", bypassed: false });
    await expect(second).resolves.toEqual({ outcome: "sent", bypassed: false });
    expect({ checks, runs }).toEqual({ checks: 1, runs: 1 });
  });

  test("an auth restoration timeout creates no run", async () => {
    const coordinator = createCloudMcpSubmissionCoordinator();
    const checking = requiredDecision({ authStatus: "checking", hasSessionToken: true });
    let runs = 0;
    const result = await coordinator.submit({
      scopeKey: checking.scopeKey,
      prepare: async () => {
        const resolution = await resolveCloudMcpSubmissionAuth({
          decision: checking,
          waitForResolution: () => new Promise<CloudMcpSubmissionGateDecision>(() => undefined),
          timeoutMs: 1,
        });
        if (resolution.outcome === "failed") {
          return { outcome: "failed", issue: resolution.issue };
        }
        return { outcome: "ready" };
      },
      send: async () => {
        runs += 1;
      },
    });

    expect(result).toMatchObject({
      outcome: "blocked",
      issue: { code: "cloud_mcp_auth_resolution_timeout" },
    });
    expect(runs).toBe(0);
  });

  test("a permanent injection failure creates no run and preserves the exact draft", async () => {
    const coordinator = createCloudMcpSubmissionCoordinator();
    const decision = requiredDecision();
    const originalDraft = {
      text: "Search my connected services",
      attachments: [{ id: "attachment_1", name: "brief.pdf" }],
    };
    let storedDraft = originalDraft;
    let runs = 0;
    const result = await coordinator.submit({
      scopeKey: decision.scopeKey,
      prepare: preparation({
        check: async () => health({
          usable: false,
          firstFailure: failure({
            code: "provider_tool_projection_missing",
            stage: "provider_projection",
            retryable: false,
            message: "The selected model is missing an injected Cloud tool.",
          }),
        }),
        repair: async () => health(),
      }),
      send: async () => {
        runs += 1;
        storedDraft = { text: "", attachments: [] };
      },
    });

    expect(result).toMatchObject({ outcome: "blocked", issue: { code: "provider_tool_projection_missing" } });
    expect(runs).toBe(0);
    expect(storedDraft).toEqual(originalDraft);
  });

  test("generic model tool-calling support is never accepted as projection proof", async () => {
    const coordinator = createCloudMcpSubmissionCoordinator();
    const decision = requiredDecision();
    let runs = 0;
    const result = await coordinator.submit({
      scopeKey: decision.scopeKey,
      prepare: preparation({
        check: async () => health({ projectionSource: "provider_capability" }),
        repair: async () => health(),
      }),
      send: async () => {
        runs += 1;
      },
    });

    expect(result).toMatchObject({ outcome: "blocked", issue: { code: "provider_tool_projection_unverified" } });
    expect(runs).toBe(0);
  });

  test("repeated clicks share one queued submission and cannot duplicate the send", async () => {
    const coordinator = createCloudMcpSubmissionCoordinator();
    const decision = requiredDecision();
    let release: ((result: CloudMcpSubmissionPreparationResult) => void) | null = null;
    const pending = new Promise<CloudMcpSubmissionPreparationResult>((resolve) => {
      release = resolve;
    });
    let runs = 0;
    const input = {
      scopeKey: decision.scopeKey,
      prepare: () => pending,
      send: async () => {
        runs += 1;
      },
    };

    const first = coordinator.submit(input);
    const second = coordinator.submit(input);
    expect(second).toBe(first);
    release?.({ outcome: "ready" });
    await Promise.all([first, second]);
    expect(runs).toBe(1);
  });

  test("signed-out, tokenless startup, and explicitly disabled or removed Cloud bypass readiness entirely", async () => {
    const coordinator = createCloudMcpSubmissionCoordinator();
    let preparations = 0;
    let runs = 0;
    for (const decision of [
      requiredDecision({ authStatus: "signed_out", hasSessionToken: false }),
      requiredDecision({ authStatus: "checking", hasSessionToken: false }),
      requiredDecision({ userState: "disabled" }),
      requiredDecision({ userState: "removed" }),
    ]) {
      await coordinator.submit({
        scopeKey: decision.scopeKey,
        ...(decision.mode === "required"
          ? {
              prepare: async () => {
                preparations += 1;
                return { outcome: "ready" };
              },
            }
          : {}),
        send: async () => {
          runs += 1;
        },
      });
    }

    expect(preparations).toBe(0);
    expect(runs).toBe(4);
  });

  test("workspace or model changes cannot release an old queued message", async () => {
    const coordinator = createCloudMcpSubmissionCoordinator();
    const original = requiredDecision({ workspaceId: "workspace_a", model: "gpt-5" });
    const replacement = requiredDecision({ workspaceId: "workspace_b", model: "gpt-5-mini" });
    let releaseOriginal: ((result: CloudMcpSubmissionPreparationResult) => void) | null = null;
    const originalPreparation = new Promise<CloudMcpSubmissionPreparationResult>((resolve) => {
      releaseOriginal = resolve;
    });
    const sentContexts: string[] = [];

    const originalResult = coordinator.submit({
      scopeKey: original.scopeKey,
      prepare: () => originalPreparation,
      send: async () => {
        sentContexts.push("workspace_a/gpt-5");
      },
    });
    const replacementResult = coordinator.submit({
      scopeKey: replacement.scopeKey,
      prepare: async () => ({ outcome: "ready" }),
      send: async () => {
        sentContexts.push("workspace_b/gpt-5-mini");
      },
    });
    releaseOriginal?.({ outcome: "ready" });

    await expect(originalResult).resolves.toEqual({ outcome: "cancelled", reason: "context_changed" });
    await expect(replacementResult).resolves.toEqual({ outcome: "sent", bypassed: false });
    expect(sentContexts).toEqual(["workspace_b/gpt-5-mini"]);
  });
});
