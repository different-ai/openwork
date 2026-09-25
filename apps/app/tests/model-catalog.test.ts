import { describe, expect, test } from "bun:test";
import type { ModelOption } from "../src/app/types";
import { readWorkspaceCloudImports } from "../src/app/cloud/import-state";
import { mergeModelOptions } from "../src/react-app/domains/connections/provider-auth/assigned-model-options";
import { AUTO_MODEL_ID, AUTO_PROVIDER_ID, immutableModelPin, publicModelTitle, isCycleModelSourceShortcut, isPinModelShortcut, modelGroups, modelSource, modelTitle, modelSubtitle, nextModelSource, nextPinnedModel, orderedModelPins, shouldSelectInitialAuto, withImportedModelMetadata } from "../src/react-app/domains/models/model-catalog";
import { autoAccessWallFromError, autoWallCopy, preflightAutoSubmission, unavailableDesktopFreeStatus } from "../src/app/lib/inference-access";
import { mergeReplyMetadata, replyModelFromInfo, replyModelLabel } from "../src/react-app/domains/session/sync/reply-model";

const option = (providerID: string, modelID: string): ModelOption => ({ providerID, modelID, title: modelID, description: providerID, behaviorTitle: "Effort", behaviorLabel: "Default", behaviorDescription: "", behaviorValue: null, isFree: false });
const auto = option(AUTO_PROVIDER_ID, AUTO_MODEL_ID);
const local = option("openai", "local");
const orgA = { ...option("ipr_team", "gwm_a"), organizationPinOrder: 1 };
const orgB = { ...option("ipr_team", "gwm_b"), organizationPinOrder: 0 };
const catalog = [local, orgA, auto, orgB];

describe("model sources and pins", () => {
  test("organization pins precede personal pins, preserve order, and Auto is immutable only when available", () => {
    expect(orderedModelPins(catalog, [local, orgA]).map((model) => model.modelID)).toEqual([AUTO_MODEL_ID, "gwm_b", "gwm_a", "local"]);
    expect(immutableModelPin(orgA)).toBe(true);
    expect(immutableModelPin(auto)).toBe(true);
    expect(immutableModelPin(local)).toBe(false);
    expect(orderedModelPins([local], [auto])).toEqual([]);
  });
  test("all sources remain accessible in the accepted group order, without duplicate rows", () => {
    const hosted = option("openwork", "hosted");
    const other = option("anthropic", "other");
    const groups = modelGroups([...catalog, hosted, other], [], [local]);
    expect(groups.map((group) => group.value)).toEqual(["Pinned", "Recent", "OpenWork Models", "anthropic"]);
    expect(groups.flatMap((group) => group.items)).toHaveLength(6);
    expect(modelGroups(catalog, [], [], "local").flatMap((group) => group.items)).toContainEqual(local);
  });
  test("cycles skip inaccessible and disabled personal pins", () => {
    const stale = option("missing", "stale");
    const disabled = { ...local, disabled: true };
    expect(nextPinnedModel([disabled, auto], [stale, local], stale)).toEqual(auto);
    expect(nextPinnedModel([disabled, auto], [stale, local], auto)).toBeNull();
    expect(nextModelSource(catalog, orderedModelPins(catalog, [local]), auto)).toEqual(local);
  });
  test("maps Gateway, local, and legacy organization sources independently of display names", () => {
    expect(modelSource(orgA)).toBe("gateway");
    expect(modelSource(local)).toBe("local");
    expect(modelSource(option("lpr_team", "same"))).toBe("organization");
    expect(modelTitle(auto)).toBe("Auto");
    expect(modelSubtitle(auto)).toBe("Free · OpenWork picks the model");
  });
  test("preserves ordered authorized alias pins through import parsing and runtime option merging", () => {
    const imports = readWorkspaceCloudImports({ cloudImports: { providers: { team: {
      cloudProviderId: "team", providerId: "ipr_team", sourceProviderId: "openai", name: "Team", source: "openwork_gateway",
      modelIds: ["gwm_a", "gwm_b"], pinnedModelIds: ["gwm_b", "not-granted", "gwm_a", "gwm_b"],
    } } } });
    expect(imports.providers.team.pinnedModelIds).toEqual(["gwm_b", "gwm_a"]);
    const assigned = withImportedModelMetadata([option("ipr_team", "gwm_a"), option("ipr_team", "gwm_b")], imports.providers);
    const merged = mergeModelOptions([option("ipr_team", "gwm_a")], assigned);
    expect(orderedModelPins(merged, []).map((model) => model.modelID)).toEqual(["gwm_b", "gwm_a"]);
    expect(modelSource(merged[0])).toBe("gateway");
  });
  test("initial Auto never overrides an explicit or existing-provider choice", () => {
    expect(shouldSelectInitialAuto({ available: catalog, current: null, empty: true, explicit: false })).toBe(true);
    expect(shouldSelectInitialAuto({ available: [], current: null, empty: true, explicit: false })).toBe(false);
    expect(shouldSelectInitialAuto({ available: catalog, current: local, empty: true, explicit: false })).toBe(false);
    expect(shouldSelectInitialAuto({ available: catalog, current: null, empty: true, explicit: true })).toBe(false);
  });
  test("pin and source shortcuts have exact modifier ownership", () => {
    const base = { key: "P", ctrlKey: false, metaKey: false, shiftKey: true, altKey: false };
    expect(isPinModelShortcut(base)).toBe(true);
    expect(isPinModelShortcut({ ...base, ctrlKey: true })).toBe(false);
    expect(isCycleModelSourceShortcut({ ...base, key: "m", ctrlKey: true, altKey: true, shiftKey: false })).toBe(true);
    expect(isCycleModelSourceShortcut({ ...base, key: "m", ctrlKey: true, altKey: true })).toBe(false);
  });
});

describe("Auto submission walls", () => {
  test.each(["exhausted", "update_required", "unavailable"] as const)("blocks %s without invoking a send", async (state) => {
    const result = await preflightAutoSubmission({ model: auto, client: { desktopFreePreflight: async () => ({ ...unavailableDesktopFreeStatus(), state }) }, isCurrent: () => true });
    expect(result?.outcome).toBe("blocked");
    expect(result && "wall" in result).toBe(true);
  });
  test("bypasses BYOK and cancels a stale preflight rather than presenting another identity's status", async () => {
    let reads = 0;
    const client = { desktopFreePreflight: async () => { reads++; return unavailableDesktopFreeStatus(); } };
    expect(await preflightAutoSubmission({ model: local, client, isCurrent: () => true })).toBeNull();
    expect(reads).toBe(0);
    let checks = 0;
    expect(await preflightAutoSubmission({ model: auto, client, isCurrent: () => ++checks === 1 })).toEqual({ outcome: "cancelled", reason: "context_changed" });
  });
  test("typed failures supply four states without money, paid offers, or automatic retries", () => {
    const wall = autoAccessWallFromError({ error: { code: "anonymous_limit_exceeded" } }, auto);
    expect(wall).toEqual({ state: "limit" });
    expect(autoAccessWallFromError({ code: "model_sync_pending" }, auto)).toEqual({ state: "sync" });
    expect(autoAccessWallFromError({ code: "anonymous_limit_exceeded" }, local)).toBeNull();
    const copy = autoWallCopy({ state: "limit" }, false);
    expect(copy.title).toBe("This week’s free limit is used up");
    expect(copy.detail).toContain("resets Monday");
    expect(copy.detail).toContain("larger free limit");
    expect(autoWallCopy({ state: "limit" }, true).detail).not.toContain("Sign in");
    expect(JSON.stringify(copy)).not.toMatch(/\$|USD|upgrade|paid|automatically/i);
  });
  test("reply metadata records observed model identity, never the selected Auto alias", () => {
    const reply = replyModelFromInfo({ role: "assistant", providerID: "openwork-free", modelID: AUTO_MODEL_ID, resolvedModelID: "actual-witness" });
    expect(reply?.modelID).toBe("actual-witness");
    expect(replyModelLabel({ id: "reply", role: "assistant", parts: [], metadata: { opencode: { replyModel: reply } } })).toBe("actual-witness");
    expect(replyModelFromInfo({ role: "user", modelID: "selected" })).toBeUndefined();
    expect(replyModelLabel({ id: "reply", role: "assistant", parts: [], metadata: { opencode: { replyModel: { providerID: AUTO_PROVIDER_ID, modelID: AUTO_MODEL_ID } } } })).toBeNull();
    expect(replyModelFromInfo({ role: "assistant" })).toBeUndefined();
    const resolved = replyModelFromInfo({ role: "assistant", providerID: AUTO_PROVIDER_ID, modelID: AUTO_MODEL_ID, resolvedModel: { id: AUTO_MODEL_ID } });
    expect(replyModelLabel({ id: "resolved", role: "assistant", parts: [], metadata: { opencode: { replyModel: resolved } } })).toBe("GPT-5.6 Luna");
    const completed = mergeReplyMetadata({ opencode: { replyModel: resolved } }, { opencode: { replyModel: replyModelFromInfo({ role: "assistant", providerID: AUTO_PROVIDER_ID, modelID: AUTO_MODEL_ID }) } });
    expect(replyModelLabel({ id: "resolved", role: "assistant", parts: [], metadata: completed })).toBe("GPT-5.6 Luna");
    expect(replyModelLabel({ id: "alias", role: "assistant", parts: [], metadata: { opencode: { replyModel: replyModelFromInfo({ role: "assistant", providerID: "ipr_fixture", modelID: "gwm_alias" }) } } })).toBeNull();
    const metadata = mergeReplyMetadata({ opencode: { replyModel: reply, created: 1 } }, { opencode: { completed: 2 } });
    expect(replyModelLabel({ id: "reply", role: "assistant", parts: [], metadata })).toBe("actual-witness");
  });
});

test("public model titles never expose opaque gateway ids", () => {
  expect(publicModelTitle({ providerID: AUTO_PROVIDER_ID, modelID: AUTO_MODEL_ID })).toBe("Auto");
  expect(publicModelTitle({ providerID: "ipr_org", modelID: "gwm_01abc", title: "gwm_01abc" })).toBeUndefined();
  expect(publicModelTitle({ providerID: "ipr_org", modelID: "gwm_01abc" })).toBeUndefined();
  expect(publicModelTitle({ providerID: "anthropic", modelID: "claude-opus-4-6", title: "Claude Opus 4.6" })).toBe("Claude Opus 4.6");
});

test("built-in OpenCode Zen models are only a silent fallback", async () => {
  const { hideBuiltInZenFallback } = await import("../src/react-app/domains/connections/provider-auth/provider-policy");
  const zenFree = { providerID: "opencode", modelID: "big-pickle", isFree: true };
  const zenPaid = { providerID: "opencode", modelID: "premium", isFree: false };
  const auto = { providerID: AUTO_PROVIDER_ID, modelID: AUTO_MODEL_ID, isFree: true };
  const byok = { providerID: "anthropic", modelID: "claude-opus-4-6", isFree: false };
  expect(hideBuiltInZenFallback([zenFree])).toEqual([zenFree]);
  expect(hideBuiltInZenFallback([zenFree, auto])).toEqual([auto]);
  expect(hideBuiltInZenFallback([zenFree, byok])).toEqual([byok]);
  expect(hideBuiltInZenFallback([zenFree, zenPaid, byok])).toEqual([zenPaid, byok]);
});
