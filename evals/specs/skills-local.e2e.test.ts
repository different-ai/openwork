import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { skillsLocalWorld } from "../worlds/first-run.ts";

const test = spec.world(skillsLocalWorld);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("local skills load quickly and stay usable from the composer", async ({ world, user, seed, probe, step }) => {
  await user.click("composer");
  // The real surface remains primary; the expression clicks only the inaccessible plus trigger.
  // TODO(primitive): click the composer capability trigger by its title.
  expect(await seed.evalIn(world.app, `(() => {
    const trigger = document.querySelector('button[title="Agents, commands, skills, plugins, and connections"]');
    if (!(trigger instanceof HTMLElement)) return false;
    trigger.click();
    return true;
  })()`)).toBe(true);

  await step("Composer capability sections are complete", async () => {
    await user.see("Agents");
    await user.see("Commands");
    await user.see("Skills");
    await user.see("Extensions");
    await user.looks([
      "The composer capability menu is open with Skills and Library sections visible",
      "No loading failure or 'Something went wrong' crash message is visible",
    ]);
  });

  await step("Local skills load within three seconds", async () => {
    const startedAt = Date.now();
    await user.click("Skills");
    await user.see({ text: /\/browser-automation/ }, { timeoutMs: 20_000 });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    await user.see({ text: /^\/browser-automation[\s\S]*Local/i });
    await user.notSee({ text: /Loading commands/ });
    // TODO(primitive): count loaded composer skill rows.
    const facts = await probe.eval(`(() => {
      const rows = [...document.querySelectorAll("button")]
        .filter((button) => /^\\/[a-z0-9-]+/i.test((button.textContent ?? "").trim()));
      return { rowCount: rows.length, loading: document.body.innerText.includes("Loading commands") };
    })()`);
    expect(isRecord(facts) ? facts.rowCount : 0).toBeGreaterThanOrEqual(10);
    expect(isRecord(facts) ? facts.loading : true).toBe(false);
    await user.looks([
      "The Skills list visibly includes the local browser-automation skill",
      "No Loading commands state or 'Something went wrong' crash message is visible",
    ]);
  });

  await step("The local browser extension is available", async () => {
    await user.click("Extensions");
    await user.see({ text: /OpenWork Browser/ });
    await user.notSee({ text: /Loading commands/ });
    await user.looks([
      "The Library list visibly includes OpenWork Browser",
      "No Loading commands state or 'Something went wrong' crash message is visible",
    ]);
  });

  await step("A new session retains local skills", async () => {
    await user.click("New session");
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    // TODO(primitive): click the composer capability trigger by its title.
    expect(await seed.evalIn(world.app, `(() => {
      const trigger = document.querySelector('button[title="Agents, commands, skills, plugins, and connections"]');
      if (!(trigger instanceof HTMLElement)) return false;
      trigger.click();
      return true;
    })()`)).toBe(true);
    const startedAt = Date.now();
    await user.click("Skills");
    await user.see({ text: /\/browser-automation/ }, { timeoutMs: 20_000 });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    await user.see({ text: /^\/browser-automation[\s\S]*Local/i });
    expect(await probe.hash()).toContain("/session/");
    await user.looks([
      "A newly created session visibly shows the local browser-automation skill",
      "No Loading commands state or 'Something went wrong' crash message is visible",
    ]);
  });
});
