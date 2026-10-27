import { describe, expect, test } from "bun:test";

import type { ModelOption } from "../src/app/types";
import { nextAvailableModel } from "../src/react-app/domains/models/model-catalog";

function option(providerID: string, modelID: string, extra: Partial<ModelOption> = {}): ModelOption {
  return {
    providerID, modelID, title: modelID, description: providerID,
    behaviorTitle: "Effort", behaviorLabel: "Default", behaviorDescription: "", behaviorValue: null, isFree: false,
    ...extra,
  };
}

const gone = { providerID: "acme", modelID: "retired" };
const options = [
  option("acme", "retired"),
  option("acme", "alpha"),
  option("beta", "bravo"),
  option("beta", "charlie"),
];

describe("nextAvailableModel", () => {
  test("follows the picker order: a pinned model before the rest", () => {
    const next = nextAvailableModel(options, [{ providerID: "beta", modelID: "charlie" }], [], gone);
    expect(next?.modelID).toBe("charlie");
  });

  test("then a recently used model", () => {
    const next = nextAvailableModel(options, [], [{ providerID: "beta", modelID: "bravo" }], gone);
    expect(next?.modelID).toBe("bravo");
  });

  test("never returns the model that stopped working, nor one that cannot run", () => {
    const next = nextAvailableModel(options, [gone], [], gone, (candidate) => candidate.modelID !== "alpha");
    expect(next?.modelID).toBe("bravo");
  });

  test("skips disabled rows and returns null when nothing else can run", () => {
    const only = [option("acme", "retired"), option("acme", "alpha", { disabled: true })];
    expect(nextAvailableModel(only, [], [], gone)).toBeNull();
  });
});
