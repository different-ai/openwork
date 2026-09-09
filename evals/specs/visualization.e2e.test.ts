import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { visualization } from "../worlds/chat.ts";

const test = spec.world(visualization);

test("a user previews and revises a lightweight design in conversation", async ({
  world,
  user,
  probe,
  step,
}) => {
  await user.type("composer", "Sketch a project overview");
  await probe.eventually(() => probe.composer(), {
    within: 30_000,
    label: "visualization request is ready to send",
    until: (composer) => composer.runTaskEnabled,
  });
  await user.click("Run task");
  try {
    await user.see(
      { text: "Your first sketch is ready." },
      { timeoutMs: 90_000 },
    );
  } finally {
    await user.screenshot();
  }
  await step(
    "the real visualization tool produces a safe inline mockup",
    async () => {
      await user.see({ text: "Visualization · v1 · Mockup" });
      await user.see({ text: "Active projects" });
      await user.see({ text: "Website refresh" });
      await user.see({ text: "Create project" });
      await user.see({ text: "Draft reviewed" });
      await user.see({ text: "Cover image" });
      expect(await world.preview()).toMatchObject({
        viewport: "desktop",
        cards: 1,
        scripts: 0,
        executed: false,
      });
      await user.notSee({
        text: "This visualization couldn’t be displayed. Ask for a new version.",
      });
      await user.screenshot();
    },
  );
  await step(
    "preview controls resize the sketch without submitting a message",
    async () => {
      const before = (await probe.composer()).userMessageCount;
      await user.click({ role: "button", label: "Mobile preview" });
      expect(await world.preview()).toMatchObject({
        viewport: "mobile",
        width: expect.any(Number),
      });
      const mobile = await world.preview();
      expect(mobile.width).toBeLessThanOrEqual(360);
      expect((await probe.composer()).userMessageCount).toBe(before);
      await user.screenshot();
      await user.click({ role: "button", label: "Desktop preview" });
      expect(await world.preview()).toMatchObject({ viewport: "desktop" });
    },
  );
  await step(
    "requesting changes drafts a revision and preserves the first sketch",
    async () => {
      const before = (await probe.composer()).userMessageCount;
      await user.click({ role: "button", label: "Request changes" });
      expect((await probe.composer()).draftText).toContain(
        "id: project-overview, version 1",
      );
      expect((await probe.composer()).userMessageCount).toBe(before);
      await user.type("composer", "Make it calmer", { replace: false });
      await user.click("Run task");
      await user.see(
        { text: "Your revised sketch is ready." },
        { timeoutMs: 90_000 },
      );
      await user.see({ text: "Visualization · v2 · Mockup" });
      await user.see({ text: "Visualization · v1 · Mockup" });
      await user.see({ text: "A calmer overview" });
      expect(await world.preview()).toMatchObject({
        cards: 2,
        scripts: 0,
        executed: false,
      });
      await user.screenshot();
    },
  );
});
