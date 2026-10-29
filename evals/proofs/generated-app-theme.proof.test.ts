import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { generatedAppTheme } from "../worlds/generated-app-theme.ts";

// A protocol host in Chrome; no seeded OpenWork or Den surface is needed.
const test = spec.world(generatedAppTheme, {
  timeout: 120_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] },
});

test("a person can read generated Apps and starters as the host switches light, dark, then light", async ({ world, user, probe, step, evidence }) => {
  for (const [index, theme] of ["light", "dark", "light"].entries()) {
    await step(`${index === 0 ? "before" : "after"}: both open Apps have matching ${theme} text and backgrounds`, async () => {
      await user.click({ role: "button", label: theme === "dark" ? /^Dark$/ : /^Light$/ });
      const color = theme === "dark" ? "rgb(240, 240, 240)" : "rgb(28, 32, 36)";
      const background = theme === "dark" ? "rgb(24, 24, 24)" : "rgb(248, 249, 250)";
      const frames = await probe.eventually(async () => (await world.appearance()).filter(frame => frame?.app !== "fallback"), {
        within: 10_000, label: `both Apps paint ${theme} colors`,
        until: values => values.length === 2 && values.every(value => value?.ready === "true" && value.scheme === theme && value.color === color && value.rootBackground === background),
      });
      expect(frames).toHaveLength(2);
      for (const frame of frames) {
        expect(frame).toMatchObject({ scheme: theme, rootColor: color, rootBackground: background, color, font: "monospace", loads: 1 });
        if (frame?.app === "starter") expect(frame.background).toBe(background);
        if (frame?.app === "runtime") expect(frame.checked).toBe(index > 0);
      }
      evidence.recordAssertionEvidence(`Both Apps paint the ${theme} palette without reopening`, JSON.stringify(frames), frames.every(frame => frame?.color === color && frame.rootBackground === background && frame.loads === 1));
      if (index === 0) {
        await user.click({ role: "button", label: "Mark reviewed", mcpApp: { resourceUri: "ui://proof/runtime" } });
        await probe.eventually(() => world.appearance(), { within: 5_000, label: "review selection is retained", until: values => values.some(value => value?.app === "runtime" && value.checked) });
      }
      await user.screenshot();
    });
  }
  await step("after: an App opened in dark mode without host colors uses readable system colors", async () => {
    const frames = await probe.eventually(async () => (await world.appearance()).filter(frame => frame?.app === "fallback"), {
      within: 10_000, label: "dark system-color fallback", until: values => values.length === 1 && values.every(value => value?.scheme === "dark" && value.textToken === ""),
    });
    for (const frame of frames) {
      expect(frame?.rootColor).not.toBe(frame?.rootBackground);
      expect(frame?.color).toBe(frame?.rootColor);
      expect(frame?.rootBackground).not.toBe("rgb(248, 249, 250)");
      expect(frame?.loads).toBe(1);
      if (frame?.app === "starter") expect(frame.background).toBe(frame.rootBackground);
    }
    evidence.recordAssertionEvidence("The App uses distinct dark system text and surface colors", JSON.stringify(frames), frames.every(frame => frame?.scheme === "dark" && frame.textToken === "" && frame.color !== frame.rootBackground));
    await user.screenshot();
  });
});
