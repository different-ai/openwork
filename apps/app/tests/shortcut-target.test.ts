import { expect, test } from "bun:test";
import type { ModelOption } from "../src/app/types.ts";
import { resolveShortcutTarget, type ShortcutTargetInput } from "../src/react-app/domains/shortcuts/shortcut-target.ts";

const listed: ModelOption = {
  providerID: "anthropic",
  modelID: "listed",
  title: "Listed",
  behaviorTitle: "",
  behaviorLabel: "",
  behaviorDescription: "",
  behaviorValue: null,
  isFree: false,
};

function input(overrides: Partial<ShortcutTargetInput>): ShortcutTargetInput {
  return {
    model: { providerID: "anthropic", modelID: "saved" },
    actionOptions: [listed],
    knownOptions: [listed],
    catalogState: "ready",
    signedIn: true,
    restrictToCloud: false,
    checkRestriction: () => false,
    disconnectedProviderIds: new Set(),
    ...overrides,
  };
}

test("a model missing from a settled catalog is unavailable", () => {
  expect(resolveShortcutTarget(input({}))).toEqual({ kind: "retained", reason: "unavailable" });
});

test("a failed provider-list load keeps a missing model pending, not unavailable", () => {
  expect(resolveShortcutTarget(input({ catalogState: "error" }))).toEqual({ kind: "pending" });
  expect(resolveShortcutTarget(input({ catalogState: "error", actionOptions: [], knownOptions: [] }))).toEqual({ kind: "pending" });
});

test("a failed load does not hide a policy block it can still prove", () => {
  expect(resolveShortcutTarget(input({ catalogState: "error", restrictToCloud: true }))).toEqual({ kind: "retained", reason: "policy" });
});
