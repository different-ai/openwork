import { spec } from "@openwork/testkit";
import { paletteSessionActions } from "../worlds/chat.ts";

const test = spec.world(paletteSessionActions);
const shortcut = process.platform === "darwin" ? "Meta+K" : "Control+K";
const paletteInput = { placeholder: "Search actions, settings, and sessions…" };
const paletteFooter = { text: "Arrow keys to navigate" };

test("the command palette pins and renames the open session", async ({ world, user, probe, step }) => {
  await step("the palette offers Pin session for the open session", async () => {
    await user.notSee({ text: "Pinned" });
    await user.press(shortcut);
    await user.see(paletteInput);
    await user.type(paletteInput, "pin", { replace: true });
    await user.see({ role: "option", label: /^Pin session/ });
    await user.notSee({ role: "option", label: /^Unpin session/ });
    await user.screenshot();
  });

  await step("choosing it pins the session", async () => {
    await user.press("Enter");
    await probe.eventually(() => probe.has("Arrow keys to navigate"), {
      within: 15_000,
      label: "command palette footer disappears after pinning",
      until: (open) => !open,
    });
    await user.see({ text: "Pinned" });
    await user.see({ text: world.session.title });
    await user.press(shortcut);
    await user.see(paletteInput);
    await user.type(paletteInput, "pin", { replace: true });
    await user.see({ role: "option", label: /^Unpin session/ });
    await user.notSee({ role: "option", label: /^Pin session/ });
    await user.screenshot();
    await user.press("Escape");
    await probe.eventually(() => probe.has("Arrow keys to navigate"), {
      within: 15_000,
      label: "command palette footer disappears after Escape",
      until: (open) => !open,
    });
    await user.notSee(paletteFooter);
  });

  await step("Rename session… opens the rename dialog", async () => {
    await user.press(shortcut);
    await user.see(paletteInput);
    await user.type(paletteInput, "rename", { replace: true });
    await user.see({ role: "option", label: /^Rename session/ });
    await user.press("Enter");
    await user.see({ text: "Rename session" });
    await user.see({ label: "Session name" });
    await user.screenshot();
  });

  await step("saving a new name updates the sidebar", async () => {
    await user.type({ label: "Session name" }, "Renamed from the palette", { replace: true });
    await user.click({ role: "button", label: "Save" });
    await probe.eventually(() => probe.has("Renamed from the palette"), {
      within: 15_000,
      label: "renamed session appears in the sidebar",
    });
    await user.see({ text: "Renamed from the palette" });
    await probe.eventually(() => probe.has(world.session.title), {
      within: 15_000,
      label: "previous session title disappears",
      until: (has) => !has,
    });
    await user.notSee({ text: world.session.title });
    await user.screenshot();
  });
});
