import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { compactLibraryWorld } from "../worlds/compact-library.ts";

const test = spec.world(compactLibraryWorld, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den", "mock"] },
});

const rows = '[data-testid="library-screen"] [data-library-item]';

test("an owner scans compact Library rows and opens a centred connector on a wide screen", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);
  const observed = probe.on(world.web);

  await step("after: Library items share one compact row and keep their menus visible", async () => {
    await owner.see({ text: "Daily brief" }, { timeoutMs: 60_000 });
    await owner.notSee({ testId: "item-rows-skeleton" });
    const result = await probe.eventually(() => observed.dom(rows), {
      within: 30_000, label: "all twelve Library items appear", until: value => value.elements.length === 12,
    });
    const descriptions = await observed.dom(`${rows} [data-library-description]`);
    const controls = await observed.dom(`${rows} [data-item-action]`);
    const ok = result.elements.length === 12
      && result.elements.every(row => row.rect.height >= 48 && row.rect.height <= 50)
      && descriptions.elements.every(line => line.rect.width <= 480)
      && controls.elements.length === 12;
    evidence.recordAssertionEvidence("Twelve items use 48px rows plus dividers and bounded descriptions", `rows=${result.elements.length}; heights=${[...new Set(result.elements.map(row => row.rect.height))].join(",")}; description widths=${[...new Set(descriptions.elements.map(line => line.rect.width))].join(",")}; action slots=${controls.elements.length}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("an owner filters the collection without stale rows", async () => {
    await owner.type({ placeholder: "Filter by name" }, "Daily", { replace: true });
    await owner.see({ text: "Daily brief" });
    const result = await probe.eventually(() => observed.dom(rows), {
      within: 10_000, label: "the name filter leaves one item", until: value => value.elements.length === 1,
    });
    const ok = result.elements.length === 1 && result.elements[0].text.includes("Daily brief");
    evidence.recordAssertionEvidence("Filtering leaves only the matching item", `rows=${result.elements.length}; text=${result.elements.map(row => row.text).join(" | ")}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("after: a connector stays 760px wide and centred in a 1920px workspace", async () => {
    await owner.type({ placeholder: "Filter by name" }, "", { replace: true });
    await owner.click({ role: "link", label: /^Team wiki/ });
    await owner.see({ testId: "library-connector" }, { timeoutMs: 30_000 });
    await owner.resizeViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    await owner.see({ text: "Team wiki" });
    const sections = await observed.dom('[data-testid="library-connector"] section');
    // The persistent desktop sidebar takes 260px; centre in the remaining workspace, not the whole monitor.
    const workspaceCentre = (1920 + 260) / 2;
    const ok = sections.elements.length > 0 && sections.elements.every(section =>
      Math.abs(section.rect.width - 760) <= 1
      && Math.abs(section.rect.left + section.rect.width / 2 - workspaceCentre) <= 1);
    evidence.recordAssertionEvidence("Connector content is centred within the area beside the sidebar", `workspace centre=${workspaceCentre}; sections=${sections.elements.map(section => `${section.rect.left}+${section.rect.width}`).join(", ")}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("the same connector fits a phone without sideways scrolling", async () => {
    await owner.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await owner.see({ testId: "library-connector" });
    const result = await observed.dom('[data-testid="library-connector"] section');
    const ok = result.documentWidth <= result.viewportWidth && result.elements.every(section =>
      section.rect.left >= 0 && section.rect.left + section.rect.width <= result.viewportWidth + 1);
    evidence.recordAssertionEvidence("The centred desktop layout stays inside a 390px viewport", `document=${result.documentWidth}; viewport=${result.viewportWidth}; sections=${result.elements.length}`, ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });
});
