import { describe, expect, test } from "bun:test";
import { OpenWorkExtensionsPreview } from "./openwork-extensions-preview.js";

describe("OpenWork extensions preview plugin", () => {
  test("adds extension guidance to the system prompt", async () => {
    const plugin = await OpenWorkExtensionsPreview();
    const output = {
      system: ["You are a title generator.", ""],
    };

    await plugin["experimental.chat.system.transform"]({}, output);

    expect(output.system).toHaveLength(4);
    expect(output.system[0]).toBe("You are a title generator.");
    expect(output.system[2]).toContain("check OpenWork extensions");
    expect(output.system[3]).toContain("openwork_ui_execute_action");
  });
});
