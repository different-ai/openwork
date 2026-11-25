import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { configPrivateItemsWorld } from "../worlds/config-private-items.ts";

const test = spec.world(configPrivateItemsWorld, {
  timeout: 300_000,
  resources: { surfaces: ["web"], services: ["den"] },
});

test("an administrator downloads private work with Whole organization and reviews it in a second Den", async ({ world, user, step }) => {
  const source = user.on(world.sourceWeb);
  const target = user.on(world.targetWeb);
  await step("the notice reflects whether private export is enabled", async () => {
    await source.see({ role: "tab", label: "Export" }, { timeoutMs: 90_000 });
    await source.click({ role: "tab", label: "Export" });
    await source.see({ text: /Private skills and plugins are not included/ });
    await source.screenshot();
    await world.enable();
    await source.reload();
    await source.click({ role: "tab", label: "Export" });
    await source.see({ text: /This export can include private server-stored skills and plugins/ });
    await source.screenshot();
  });
  await step("the downloaded Config file enters review without a skill mapping decision", async () => {
    await using download = await world.allowDownload();
    await source.click({ testId: "config-export-download" });
    await expect.poll(world.download, { timeout: 30_000 }).not.toBeNull();
    const path = await world.download();
    if (!path) throw new Error("The browser did not finish the Config download.");
    await target.click({ role: "tab", label: "Import" });
    await target.see({ testId: "config-import-drop" });
    await target.attachFiles("[data-testid=config-import-input]", [path]);
    await target.type({ testId: "config-import-title" }, "Move field notes");
    await target.click({ role: "button", label: "Upload for review" });
    await target.see({ text: world.name }, { timeoutMs: 60_000 });
    await target.notSee({ text: /items? needs? a decision/ });
    await target.screenshot();
  });
  await step("the recipient joins after apply and edits the imported skill", async () => {
    await target.click({ role: "button", label: /^Approve$/ });
    await target.click({ role: "button", label: "Apply now" });
    await target.see({ text: "Applied" }, { timeoutMs: 60_000 });
    const creator = user.on(await world.joinCreator());
    await creator.see({ testId: "library-screen" }, { timeoutMs: 60_000 });
    await creator.click({ text: world.name });
    await creator.click({ text: "Field notes migration" });
    await creator.see({ text: "Read the synthetic field notes." });
    await creator.click({ role: "link", label: "Edit skill" });
    await creator.type({ role: "textbox", label: /Skill body/ }, "Read the revised destination notes.", { replace: true });
    await creator.click({ role: "button", label: "Save changes" });
    await creator.click({ text: "Field notes migration" });
    await creator.see({ text: "Read the revised destination notes." });
    await creator.screenshot();
  });
});
