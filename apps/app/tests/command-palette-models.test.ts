import { describe, expect, test } from "bun:test";

import type { ModelOption } from "../src/app/types";
import {
  buildCommandPaletteBehaviorItems,
  buildCommandPaletteModelItems,
  commandPaletteBackMode,
  commandPaletteModelTarget,
  createCommandPaletteModelControls,
} from "../src/react-app/shell/command-palette-models";

const option: ModelOption = {
  providerID: "provider-id",
  modelID: "model-id",
  title: "Model Title",
  description: "Provider Title",
  behaviorTitle: "Reasoning Effort",
  behaviorLabel: "Low",
  behaviorDescription: "Less reasoning",
  behaviorValue: "low",
  behaviorOptions: [
    { value: "low", label: "Low", description: "Less reasoning" },
    { value: "high", label: "High", description: "More reasoning" },
  ],
  isFree: false,
};

describe("command palette models", () => {
  test("builds searchable model rows from title, provider, and model id", () => {
    const [item] = buildCommandPaletteModelItems([option], {
      providerID: option.providerID,
      modelID: option.modelID,
    });

    expect(item?.searchText).toContain("Model Title");
    expect(item?.searchText).toContain("Provider Title");
    expect(item?.searchText).toContain("provider-id");
    expect(item?.searchText).toContain("model-id");
    expect(item?.meta).toBe("Current");
    expect(item?.detail).toBe("Provider Title · model-id");
  });

  test("builds behavior rows and marks the current explicit variant", () => {
    const items = buildCommandPaletteBehaviorItems(
      option,
      { providerID: option.providerID, modelID: option.modelID },
      "high",
    );

    expect(items.map((item) => item.title)).toEqual(["Low", "High"]);
    expect(items[1]?.meta).toBe("Current");
    expect(items[1]?.searchText).toContain("More reasoning");
  });

  test("shared controls preview and apply the same available pin and source without changing another target", () => {
    const auto = { ...option, providerID: "openwork-free", modelID: "openai/gpt-5.6-luna", title: "Luna" };
    const next = { ...option, providerID: "local", modelID: "next", title: "Next model" };
    const choices: unknown[] = [];
    const controls = createCommandPaletteModelControls({ options: [auto, next], current: auto, behavior: "high",
      favorites: [next], onSelect: (model, behavior) => choices.push({ model, behavior }) });
    expect(controls.nextPinnedOption).toEqual(next);
    expect(controls.nextSourceOption).toEqual(next);
    expect(choices).toEqual([]);
    expect(controls.onNextPinnedModel()).toBe("Next model");
    expect(choices).toEqual([{ model: { providerID: "local", modelID: "next" }, behavior: "high" }]);
    expect(commandPaletteModelTarget({ focusedPane: "secondary", secondary: { sessionId: "secondary" } }, "primary")).toBe("secondary");
    expect(commandPaletteModelTarget({ focusedPane: "primary", secondary: { sessionId: "secondary" } }, "primary")).toBe("primary");
    const unavailable = createCommandPaletteModelControls({ options: [auto, { ...next, disabled: true }], current: auto,
      favorites: [next], onSelect: () => { throw new Error("must not select an inaccessible model"); } });
    expect(unavailable.onNextPinnedModel()).toBeNull();
    expect(unavailable.onCycleModelSource()).toBeNull();
    // Cycling onto Auto never carries the previous model's effort, even when Auto's catalog lists the same value.
    const intoAuto: unknown[] = [];
    const reasoning = { ...auto, behaviorOptions: [{ value: "high", label: "High" }] } as typeof auto;
    createCommandPaletteModelControls({ options: [next, reasoning], current: next, behavior: "high",
      favorites: [reasoning], onSelect: (model, behavior) => intoAuto.push({ model, behavior }) }).onNextPinnedModel();
    expect(intoAuto).toEqual([{ model: { providerID: "openwork-free", modelID: "openai/gpt-5.6-luna" }, behavior: null }]);
  });

  test("navigates behavior to models to root", () => {
    expect(commandPaletteBackMode("model-behavior")).toBe("models");
    expect(commandPaletteBackMode("models")).toBe("root");
    expect(commandPaletteBackMode("split-sessions")).toBe("root");
    expect(commandPaletteBackMode("root")).toBeNull();
  });
});
