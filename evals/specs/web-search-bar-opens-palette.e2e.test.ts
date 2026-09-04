import { spec } from "@openwork/testkit";
import { webSearchBar } from "../worlds/web-shell.ts";

const test = spec.world(webSearchBar, { timeout: 8 * 60_000 });
const searchBar = { testId: "command-palette-search-bar" };
const paletteInput = { placeholder: "Search actions, settings, and sessions…" };

test("the web header search bar opens the command palette from sessions and settings", async ({ world, user, probe, step }) => {
  const webUser = user.on(world.web);
  const webProbe = probe.on(world.web);

  await step("the web header shows a search bar and the palette is closed", async () => {
    await webUser.see(searchBar);
    await webUser.notSee(paletteInput);
    await webUser.see({ text: /Describe your task/ });
    await webUser.screenshot();
  });

  await step("clicking the search bar opens the palette", async () => {
    await webUser.click(searchBar);
    await webUser.see(paletteInput);
    await webUser.see({ text: "Actions" });
    await webUser.screenshot();
  });

  await step("typing folders and Enter lands on Permissions", async () => {
    await webUser.type(paletteInput, "folders", { replace: true });
    await webUser.see({ role: "option", label: /^Permissions/ });
    await webUser.press("Enter");
    await probe.eventually(() => webProbe.has("Arrow keys to navigate"), {
      within: 15_000,
      until: (open) => !open,
    });
    await webUser.see({ text: /Authorized folders/ });
    await webUser.notSee({ text: /Adjust how OpenWork looks/ });
    await webUser.notSee({ text: /Describe your task/ });
  });

  await step("the Settings header keeps the search bar and reopens the palette", async () => {
    await webUser.see({ text: /Authorized folders/ });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await webUser.see(searchBar);
    await webUser.click(searchBar);
    await webUser.see(paletteInput);
    await webUser.screenshot();
    await webUser.press("Escape");
    await probe.eventually(() => webProbe.has("Arrow keys to navigate"), {
      within: 15_000,
      until: (open) => !open,
    });
    await webUser.notSee(paletteInput);
    await webUser.see({ text: /Authorized folders/ });
  });
});
