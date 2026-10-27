import { describe, expect, test } from "bun:test";

import type { ModelOption } from "../src/app/types";
import { commandPaletteModelOptions, commandPaletteModelTarget } from "../src/react-app/shell/command-palette-models";

function option(modelID: string): ModelOption {
  return { providerID: "acme", modelID, title: modelID, behaviorTitle: "Effort", behaviorLabel: "Default", behaviorDescription: "", behaviorValue: null, isFree: false };
}

describe("command palette models in a side window", () => {
  test("a side window with a chat targets that chat", () => {
    expect(commandPaletteModelTarget({ focusedPane: "secondary", secondary: { sessionId: "ses_side" } }, "ses_main")).toBe("ses_side");
  });

  test("an unsent side chat targets the new-task model, like its composer", () => {
    expect(commandPaletteModelTarget({ focusedPane: "secondary", secondary: { sessionId: "__new-task__[null,\"ses_main\"]", draftDestination: { workspaceId: "ws" } } }, "ses_main")).toBeNull();
  });

  test("the main pane keeps targeting the selected chat", () => {
    expect(commandPaletteModelTarget({ focusedPane: "primary", secondary: { sessionId: "ses_side" } }, "ses_main")).toBe("ses_main");
  });

  test("lists the shared catalog when the focused pane published nothing, instead of nothing", () => {
    const shared = [option("alpha"), option("bravo")];
    expect(commandPaletteModelOptions(undefined, shared).map((entry) => entry.modelID)).toEqual(["alpha", "bravo"]);
    expect(commandPaletteModelOptions([], shared).map((entry) => entry.modelID)).toEqual(["alpha", "bravo"]);
    expect(commandPaletteModelOptions([option("charlie")], shared).map((entry) => entry.modelID)).toEqual(["charlie"]);
  });
});
