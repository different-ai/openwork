import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotCommandPalette } from "../worlds/workbot-command-palette.ts";

const test = spec.world(workbotCommandPalette, { timeout: 120_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });

const palette = "[data-workbot-palette]";
const input = "[data-workbot-palette-input]";
const composer = 'textarea[aria-label="Message Workbot"]';
// Reads the palette without scrolling it: a locator's scroll-into-view would move the list before the screenshot.
const present = (layout: { elements: unknown[] }) => layout.elements.length > 0;

test("a member opens the command palette with Cmd+K and runs a command without leaving the keyboard", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  // Cmd+K where the browser runs on macOS, Ctrl+K elsewhere: the first chord that opens the palette is this system's.
  let chord = "Meta+k";
  let altEnter = "Meta+Enter";
  const focused = () => probe.eventually(() => probe.dom(input), { within: 3000, label: "the palette's search box has focus", until: layout => layout.elements[0]?.focused === true });
  const open = async () => {
    await user.press(chord);
    await focused();
  };
  const openFirstTime = async () => {
    await user.press("Meta+k");
    const opened = await probe.eventually(() => probe.dom(input), { within: 1000, label: "Cmd+K opens the palette on macOS", until: layout => layout.elements.length > 0 }).then(() => true, () => false);
    if (!opened) {
      chord = "Control+k";
      altEnter = "Control+Enter";
      await user.press(chord);
    }
    await focused();
  };

  world.holdChats();
  await user.navigate(world.url);

  await step("the header offers search and actions by default, without a rollout field", async () => {
    await user.see({ role: "button", label: "Search and actions" });
    await user.see({ text: "On it. The venue research is still running." });
    await user.screenshot();
  });

  await step("Cmd+K from inside the message box opens the palette, with chats still loading", async () => {
    await user.click({ role: "textbox", label: "Message Workbot" });
    await openFirstTime();
    await user.see({ role: "combobox", label: /Search Workbot, chats and actions/ });
    await probe.eventually(() => probe.dom('[data-workbot-palette] [role="listbox"] [data-workbot-palette-item="task:task_research"]'), { within: 3000, label: "the running task is listed", until: present });
    expect((await probe.dom("[data-workbot-palette-loading]")).elements).toHaveLength(1);
    await user.screenshot();
    world.releaseChats();
    await probe.eventually(() => probe.dom('[data-workbot-palette-item="chat:sidechatbudget00001"]'), { within: 5000, label: "chats replace the skeleton", until: present });
    const rows = (await probe.dom("[data-workbot-palette-item]")).elements.map(element => element.text);
    const expected = ["Message Workbot", "New side chat", "Switch chat", "Show background tasks", "Budget review", "Research venue options", "Home", "Calendar", "Your dashboard", "Your connections"];
    const listedAll = expected.every(title => rows.some(text => text.startsWith(title)));
    evidence.recordAssertionEvidence("The palette opens over the composer with real actions, chats, a running task, pages and settings", rows.join(" | "), listedAll);
    expect(listedAll).toBe(true);
    const unavailable = ["Documents", "Computer", "Show files", "Stop the reply"];
    const preservesAvailability = unavailable.every(title => !rows.some(text => text.startsWith(title)));
    evidence.recordAssertionEvidence("Default search preserves existing page and action availability", `Unavailable in this workspace: ${unavailable.join(", ")}`, preservesAvailability);
    expect(preservesAvailability).toBe(true);
    await user.screenshot();
  });

  await step("Esc closes it and the caret is back in the message box", async () => {
    await user.press("Escape");
    await probe.eventually(() => probe.dom(palette), { within: 3000, label: "the palette closes", until: layout => layout.elements.length === 0 });
    const focused = (await probe.dom(composer)).elements.some(element => element.focused);
    evidence.recordAssertionEvidence("Focus returns to where it was", "The message box has focus after Esc", focused);
    expect(focused).toBe(true);
  });

  await step("typing filters instantly, ranks the best match first and marks the matched letters", async () => {
    await open();
    await user.type({ role: "combobox" }, "bud");
    await user.see({ text: "Budget review" });
    const first = (await probe.dom('[data-workbot-palette] [data-highlighted]')).elements[0]?.text ?? "";
    const marks = (await probe.dom('[data-workbot-palette-item="chat:sidechatbudget00001"] mark')).elements.map(element => element.text).join("");
    evidence.recordAssertionEvidence("The best match is highlighted and its matching letters are bold", `highlighted "${first}"; marked "${marks}"`, first.startsWith("Budget review") && marks === "Bud");
    expect(first.startsWith("Budget review")).toBe(true);
    expect(marks).toBe("Bud");
    await user.screenshot();
  });

  await step("Tab opens the nested Chats list and Backspace returns", async () => {
    await user.type({ role: "combobox" }, "switch", { replace: true });
    await user.press("Tab");
    await user.see({ role: "combobox", label: "Search chats" });
    await user.see({ text: "Travel notes" });
    await user.press("ArrowDown");
    await user.screenshot();
    await user.press("Backspace");
    await user.see({ role: "combobox", label: /Search Workbot, chats and actions/ });
  });

  await step("a search with no match says so and how to recover", async () => {
    await user.type({ role: "combobox" }, "xyzzy", { replace: true });
    await user.see({ text: "Nothing matches “xyzzy”" });
    await user.see({ text: "Try fewer or different words." });
    await user.screenshot();
  });

  await step("Cmd+Enter runs a row's second action: stopping a running background task", async () => {
    await user.type({ role: "combobox" }, "venue", { replace: true });
    await user.see({ text: "Research venue options" });
    await user.press(altEnter);
    await probe.eventually(() => world.stopped(), { within: 5000, label: "the task's stop request reached Workbot", until: ids => ids.length === 1 });
    evidence.recordAssertionEvidence("Cmd/Ctrl+Enter stops the highlighted task", JSON.stringify(world.stopped()), world.stopped().join() === "task_research");
    expect(world.stopped()).toEqual(["task_research"]);
  });

  await step("Enter runs a command: Calendar opens and the palette closes", async () => {
    await open();
    await user.type({ role: "combobox" }, "calen");
    await user.press("Enter");
    await probe.eventually(() => probe.url(), { within: 5000, label: "Calendar opened", until: href => href.includes("/calendar") });
    expect((await probe.dom(palette)).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("A command runs from the keyboard", await probe.url(), (await probe.url()).includes("/calendar"));
    await user.screenshot();
  });

  await step("recently used commands come first the next time", async () => {
    await open();
    const firstGroup = (await probe.dom("[data-workbot-palette-group]")).elements[0]?.text ?? "";
    evidence.recordAssertionEvidence("Recent comes first", firstGroup, firstGroup.startsWith("Recent"));
    expect(firstGroup.startsWith("Recent")).toBe(true);
    await user.press(chord);
    await probe.eventually(() => probe.dom(palette), { within: 3000, label: "Cmd+K again closes the palette", until: layout => layout.elements.length === 0 });
  });

  await step("on a phone the search button is in the header and the palette fits the screen", async () => {
    await user.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await user.navigate(world.url);
    await user.see({ role: "button", label: "Search and actions" });
    await user.screenshot();
    await user.click({ role: "button", label: "Search and actions" });
    await probe.eventually(() => probe.dom('[data-workbot-palette] [role="listbox"]'), { within: 3000, label: "the palette opens", until: present });
    const layout = await probe.dom(palette);
    const fits = (layout.elements[0]?.rect.right ?? Infinity) <= layout.viewportWidth && layout.documentWidth <= layout.viewportWidth;
    evidence.recordAssertionEvidence("The palette fits a 390px screen", `right ${layout.elements[0]?.rect.right} of ${layout.viewportWidth}`, fits);
    expect(fits).toBe(true);
    await user.screenshot();
  });
});
