import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { plusMenuWeb } from "../worlds/composer-plus-menu.ts";

const test = spec.world(plusMenuWeb, {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});

const plusButton = { role: "button", label: "Add files, skills, connectors, and more" } as const;
const attachRow = { role: "option", label: /^Attach a file/ } as const;
const menuSearch = { placeholder: "Search files, skills, connectors" } as const;
const attachShortcut = process.platform === "darwin" ? "Meta+u" : "Control+u";

test("a member: I want to add an attachment so the AI can read my file", async ({ world, user, probe, step, evidence }) => {
  const [notes, roster, unpicked] = world.stagedFiles;
  if (!notes || !roster || !unpicked) throw new Error("The world staged too few files.");
  const menuClosed = async () => {
    const startedAt = Date.now();
    await probe.eventually(() => probe.dom("[data-composer-plus-menu]"), {
      within: 5_000, intervalMs: 20, label: "the + menu closes", until: (dom) => dom.elements.length === 0,
    });
    return Date.now() - startedAt;
  };

  await step("1. before: the composer has a single + button and no separate paperclip", async () => {
    await user.see(plusButton);
    await user.notSee({ role: "button", label: "Attach files" });
    await user.screenshot();
  });

  await step("2. opening + offers Attach a file first, with its shortcut", async () => {
    await user.click(plusButton);
    await user.see(menuSearch);
    await user.see(attachRow);
    await user.screenshot();
  });

  await step("3. choosing Attach a file adds quarterly-notes.txt as a chip and closes the menu", async () => {
    await user.click(attachRow);
    const closedAfterMs = await menuClosed();
    await user.see({ text: notes.name });
    await user.notSee(menuSearch);
    evidence.recordAssertionEvidence("The menu closes as soon as a file is chosen", `menu gone ${closedAfterMs} ms after the click`, closedAfterMs <= 300);
    expect(closedAfterMs).toBeLessThanOrEqual(300);
    await user.screenshot();
  });

  await step("4. the attach shortcut adds team-roster.txt without opening the menu", async () => {
    await user.click("composer");
    await user.press(attachShortcut);
    await user.see({ text: roster.name });
    await user.notSee(menuSearch);
    await user.screenshot();
  });

  await step("5. after: the AI receives both attached files and not the one left out", async () => {
    await user.type("composer", world.attachPrompt);
    await user.click("Run task");
    await user.see({ text: world.attachReply }, { timeoutMs: 90_000 });
    const bodies = world.providerBodies().filter((body) => body.includes(world.attachPrompt));
    const sent = bodies.join("\n");
    const received = {
      [notes.name]: sent.includes("NOTES_FILE_5521"),
      [roster.name]: sent.includes("ROSTER_FILE_8830"),
      [unpicked.name]: sent.includes("UNPICKED_FILE_6604"),
    };
    evidence.recordAssertionEvidence(
      "The model request carries the two attached files only",
      `${bodies.length} model request(s) for the prompt; file contents seen: ${JSON.stringify(received)}`,
      received[notes.name] && received[roster.name] && !received[unpicked.name],
    );
    expect(bodies.length).toBeGreaterThan(0);
    expect(received).toEqual({ [notes.name]: true, [roster.name]: true, [unpicked.name]: false });
    await user.screenshot();
  });
});
