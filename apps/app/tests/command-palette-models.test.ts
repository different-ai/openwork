import { describe, expect, test } from "bun:test";

import type { ModelOption } from "../src/app/types";
import {
  buildCommandPaletteBehaviorItems,
  buildCommandPaletteModelItems,
  commandPaletteBackMode,
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

  test("navigates behavior to models to root", () => {
    expect(commandPaletteBackMode("model-behavior")).toBe("models");
    expect(commandPaletteBackMode("models")).toBe("root");
    expect(commandPaletteBackMode("split-sessions")).toBe("root");
    expect(commandPaletteBackMode("root")).toBeNull();
  });
});
