import { spec } from "@openwork/testkit";
import { INVALID_FIELD, invalidOpencodeConfigWorld } from "../worlds/invalid-opencode-config.ts";

const test = spec.world(invalidOpencodeConfigWorld, {
  resources: { surfaces: ["appWeb"], services: [] }, timeout: 300_000,
});

test("a workspace with an invalid OpenCode config names the file and field instead of showing no chats", async ({ world, user, step }) => {
  await step("before the edit, the workspace opens normally", async () => {
    await user.see("composer", { editable: true });
    await user.screenshot();
  });

  await step("after a hand edit breaks opencode.json, the workspace says which file and field to fix", async () => {
    await world.breakConfig();
    const field = INVALID_FIELD.replaceAll(".", "\\.");
    await user.see({ text: new RegExp(`OpenCode can't use the config file .*opencode\\.json: ${field}`) }, { timeoutMs: 60_000 });
    await user.see("Retry");
    await user.notSee({ text: "OpenCode request failed" });
    await user.screenshot();
  });
});
