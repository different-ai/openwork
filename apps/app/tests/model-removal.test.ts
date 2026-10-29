import { describe, expect, test } from "bun:test";
import type { ModelOption } from "../src/app/types";
import { confirmedOrganizationRemoval, closestAvailableModel } from "../src/react-app/domains/session/surface/model-removal";
import { computeModelAvailability, createUnavailableConfirmationGate } from "../src/react-app/domains/session/surface/model-availability";
import { useModelRecoveryStore } from "../src/react-app/domains/session/surface/model-recovery-store";

const old = { providerID: "ipr_gateway", modelID: "gwm_opus", title: "Claude Opus 4.5" };
const empty = { models: [], lockedModels: [] };
const present = { models: [old], lockedModels: [] };
const locked = { models: [], lockedModels: [old] };
const option = (providerID: string, modelID: string, title: string): ModelOption => ({
  providerID, modelID, title, description: "Provider", behaviorTitle: "Reasoning", behaviorLabel: "Default",
  behaviorDescription: "", behaviorValue: null, isFree: false,
});
const sonnet = option("ipr_gateway", "gwm_sonnet", "Claude Sonnet 4.5");
const haiku = option("ipr_gateway", "gwm_haiku", "Claude Haiku 4.5");
const luna = option("openwork", "openai/gpt-6-luna", "GPT-6 Luna");

test("live sync uses its subscribed engine catalog rather than a deliberately absent legacy snapshot", () => {
  const context = {
    workspaceReady: true, loading: false, signedIn: true, cloudProviderSyncReady: true,
    openWorkModelsSyncing: false, restrictToCloud: false, checkRestriction: () => false,
    cloudProviderList: null, providerList: { all: [], connected: [], default: {} },
  };
  expect(computeModelAvailability(old, { ...context, liveProviderSync: true })).toEqual({ status: "unavailable", reason: "model_missing" });
  expect(computeModelAvailability(old, { ...context, liveProviderSync: false })).toEqual({ status: "pending" });
});

test("a mature catalog gap neither spins a timer nor hides another model's deadline", () => {
  let now = 0;
  const gate = createUnavailableConfirmationGate({ now: () => now, confirmMs: 1200 });
  gate.confirm(old, { status: "unavailable", reason: "model_missing" });
  now = 1300;
  expect(gate.nextRecheckDelay()).toBeNull();
  gate.confirm(sonnet, { status: "unavailable", reason: "model_missing" });
  expect(gate.nextRecheckDelay()).toBe(1200);
});

describe("authoritative organization model removal", () => {
  test("an engine gap cannot remove a model still assigned by Den", () => {
    expect(confirmedOrganizationRemoval({ model: old, before: present, after: present, engineSettled: true, engineMissing: true })).toBe(false);
  });
  test("both independent inventories must confirm absence after the engine settles", () => {
    expect(confirmedOrganizationRemoval({ model: old, before: empty, after: empty, engineSettled: true, engineMissing: true })).toBe(true);
    for (const [before, after] of [[null, empty], [empty, null], [present, empty], [empty, present], [locked, empty], [empty, locked]]) {
      expect(confirmedOrganizationRemoval({ model: old, before, after, engineSettled: true, engineMissing: true })).toBe(false);
    }
    expect(confirmedOrganizationRemoval({ model: old, before: empty, after: empty, engineSettled: false, engineMissing: true })).toBe(false);
    expect(confirmedOrganizationRemoval({ model: old, before: empty, after: empty, engineSettled: true, engineMissing: false })).toBe(false);
  });
});

describe("closest usable model", () => {
  test("Opus chooses Sonnet before Haiku, a pinned Luna, or picker order", () => {
    expect(closestAvailableModel([luna, haiku, sonnet], [luna], [haiku], old, () => true)).toEqual(sonnet);
  });
  test("maker matching crosses opaque gateway providers", () => {
    const other = { ...sonnet, providerID: "ipr_other" };
    expect(closestAvailableModel([luna, other], [luna], [], old, () => true)).toEqual(other);
  });
  test("opaque provider IDs alone do not imply the same maker", () => {
    const unknown = { providerID: old.providerID, modelID: old.modelID };
    expect(closestAvailableModel([sonnet, luna], [luna], [], unknown, () => true)).toEqual(luna);
  });
  test("without a matching family, user pins then recent then picker order win", () => {
    const gemini = option("google", "gemini-pro", "Gemini Pro");
    expect(closestAvailableModel([luna, gemini], [gemini], [luna], old, () => true)).toEqual(gemini);
    expect(closestAvailableModel([luna, gemini], [], [gemini], old, () => true)).toEqual(gemini);
    expect(closestAvailableModel([luna, gemini], [], [], old, () => true)).toEqual(luna);
  });
  test("never picks an unavailable, disabled, same, or sign-in-required model", () => {
    expect(closestAvailableModel([{ ...sonnet, disabled: true }, { ...haiku, gatewayAuthorization: { cloudProviderId: "ipr_gateway", credentialSetId: "gcs_auth" } }, luna], [], [], old, () => false)).toBeNull();
  });
});

test("recovery dismissal is per chat and a returning model offers recovery again", () => {
  const store = useModelRecoveryStore.getState();
  store.record("chat-a", { previous: old, replacement: sonnet });
  store.record("chat-b", { previous: old, replacement: sonnet });
  store.dismiss("chat-a");
  expect(useModelRecoveryStore.getState().byChat["chat-a"].dismissed).toBe(true);
  expect(useModelRecoveryStore.getState().byChat["chat-b"].dismissed).toBe(false);
  store.markReturned("chat-a", true);
  expect(useModelRecoveryStore.getState().byChat["chat-a"]).toMatchObject({ returned: true, dismissed: false });
  store.clear("chat-a");
  expect(useModelRecoveryStore.getState().byChat["chat-a"]).toBeUndefined();
});
