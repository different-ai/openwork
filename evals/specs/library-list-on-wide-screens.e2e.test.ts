import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { libraryListWide, integratedLibraryListWide } from "../worlds/library-list-wide.ts";

const test = spec.world(libraryListWide, {
  timeout: 300_000,
  resources: { surfaces: ["appWeb"], services: [] },
});

const integratedTest = spec.world(integratedLibraryListWide, {
  timeout: 600_000,
  resources: { surfaces: ["appWeb"], services: ["den"] },
});

type Rect = { left: number; right: number; width: number };

/** Distinct left edges, rounded: one value means the column is a straight lane. */
function lanes(rects: Rect[]) {
  return [...new Set(rects.map((rect) => Math.round(rect.left)))];
}

test("a member on a big screen reads the Library as one aligned list, and there is no card view to switch to", async ({ world, user, agent, probe, step, evidence }) => {
  const rows = async (count: number) => probe.eventually(async () => (await probe.dom("button[data-library-row]")).elements, {
    within: 60_000, label: "the Library lists every skill and server", until: (elements) => elements.length >= count,
  });
  const expected = world.skills.length + world.servers.length;

  await step("the Library opens as a list, with no Card view or List view switch", async () => {
    await user.resizeViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    await agent.run("route.extensions.skills");
    await user.see({ text: "Library" });
    await user.click({ role: "button", label: "All" });
    for (const name of [...world.skills, ...world.servers]) await user.see({ text: name }, { timeoutMs: 60_000 });
    await user.notSee({ role: "button", label: "Card view" });
    await user.notSee({ role: "button", label: "List view" });
    const listed = await rows(expected);
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "Only the list exists",
      `${listed.length} rows; Card view switch: none; List view switch: none`,
      listed.length >= expected,
    );
  });

  await step("after: at 1920 wide Name, Kind, From and What it does sit side by side in straight lanes under their labels", async () => {
    const header = await probe.eventually(async () => (await probe.dom("[data-library-columns]")).elements, {
      within: 10_000, label: "the column header shows", until: (elements) => elements.length === 1 && (elements[0]?.rect.width ?? 0) > 0,
    });
    const listed = await rows(expected);
    const kinds = (await probe.dom("button[data-library-row] [data-library-kind]")).elements;
    const descriptions = (await probe.dom("button[data-library-row] [data-library-description]")).elements.filter((element) => element.rect.width > 0);
    const labels = (await probe.dom("[data-library-columns] span")).elements.filter((element) => element.text);
    const kindLabel = labels.find((element) => element.text === "Kind");
    const descriptionLabel = labels.find((element) => element.text === "What it does");
    const kindLanes = lanes(kinds.map((element) => element.rect));
    const descriptionLanes = lanes(descriptions.map((element) => element.rect));
    // Kind follows the name lane directly instead of being pushed to the far edge.
    const kindFromRowStart = Math.round((kinds[0]?.rect.left ?? 0) - (listed[0]?.rect.left ?? 0));
    const underLabels = kindLabel !== undefined && descriptionLabel !== undefined
      && kindLanes.length === 1 && kindLanes[0] === Math.round(kindLabel.rect.left)
      && descriptionLanes.length === 1 && descriptionLanes[0] === Math.round(descriptionLabel.rect.left);
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "Columns line up with their labels and stay close to the name",
      `header "${header[0]?.text}"; Kind lane x=${kindLanes.join(", ")} (label x=${Math.round(kindLabel?.rect.left ?? -1)}), ${kindFromRowStart}px from the row start; What it does lane x=${descriptionLanes.join(", ")} (label x=${Math.round(descriptionLabel?.rect.left ?? -1)}); ${descriptions.length}/${listed.length} rows show what they do`,
      underLabels && kindFromRowStart < 320 && descriptions.length === listed.length,
    );
    expect(underLabels).toBe(true);
    expect(kindFromRowStart).toBeLessThan(320);
    expect(descriptions).toHaveLength(listed.length);
  });

  await step("at 2560 wide the lanes stay aligned and nothing scrolls sideways", async () => {
    await user.resizeViewport({ width: 2560, height: 1440, deviceScaleFactor: 1 });
    const page = await probe.eventually(async () => probe.dom("button[data-library-row] [data-library-description]"), {
      within: 10_000, label: "the list reflows to 2560", until: (dom) => dom.viewportWidth >= 2400,
    });
    const descriptionLanes = lanes(page.elements.map((element) => element.rect));
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "Wide window, same lanes",
      `viewport ${page.viewportWidth}px, document ${page.documentWidth}px; description lane starts at x=${descriptionLanes.join(", ")}`,
      page.documentWidth <= page.viewportWidth && descriptionLanes.length === 1,
    );
    expect(page.documentWidth).toBeLessThanOrEqual(page.viewportWidth);
    expect(descriptionLanes).toHaveLength(1);
  });

  await step("at 1280 wide, a common laptop window, the same columns still fit with every description on one line", async () => {
    await user.resizeViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    const descriptions = await probe.eventually(async () => (await probe.dom("button[data-library-row] [data-library-description]")).elements, {
      within: 10_000, label: "descriptions show at 1280", until: (elements) => elements.length > 0 && elements.every((element) => element.rect.width > 0),
    });
    const page = await probe.dom("button[data-library-row]");
    const descriptionLanes = lanes(descriptions.map((element) => element.rect));
    const narrowest = Math.round(Math.min(...descriptions.map((element) => element.rect.width)));
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "Laptop width keeps all four columns",
      `${descriptions.length} descriptions in one lane at x=${descriptionLanes.join(", ")}; description column ${narrowest}px wide; document ${page.documentWidth}px in a ${page.viewportWidth}px window`,
      descriptionLanes.length === 1 && narrowest >= 240 && page.documentWidth <= page.viewportWidth,
    );
    expect(descriptionLanes).toHaveLength(1);
    expect(narrowest).toBeGreaterThanOrEqual(240);
    expect(page.documentWidth).toBeLessThanOrEqual(page.viewportWidth);
  });

  await step("on a narrow window (900 wide) the row folds back to Name, Kind and one caption, without the column header", async () => {
    await user.resizeViewport({ width: 900, height: 800, deviceScaleFactor: 1 });
    const header = await probe.eventually(async () => (await probe.dom("[data-library-columns]")).elements, {
      within: 10_000, label: "the column header hides on a narrower window", until: (elements) => elements.every((element) => element.rect.width === 0),
    });
    const descriptions = (await probe.dom("button[data-library-row] [data-library-description]")).elements;
    const page = await probe.dom("button[data-library-row]");
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "Narrow window keeps one line per row",
      `column header ${header.every((element) => element.rect.width === 0) ? "hidden" : "visible"}; description column visible in ${descriptions.filter((element) => element.rect.width > 0).length} rows; document ${page.documentWidth}px in a ${page.viewportWidth}px window`,
      descriptions.every((element) => element.rect.width === 0) && page.documentWidth <= page.viewportWidth,
    );
    expect(descriptions.every((element) => element.rect.width === 0)).toBe(true);
    expect(page.documentWidth).toBeLessThanOrEqual(page.viewportWidth);
  });

  await step("opening a row still opens its details", async () => {
    await user.resizeViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    const skill = world.skills[0];
    if (!skill) throw new Error("The world has no skills.");
    await user.click({ text: skill });
    const path = await probe.eventually(async () => probe.dom("[data-extension-detail-page]"), {
      within: 10_000, label: "the skill detail opens", until: (dom) => dom.elements.length > 0,
    });
    await user.see({ text: skill });
    await user.screenshot();
    evidence.recordAssertionEvidence("Row opens its details", `detail page for ${skill} shown`, path.elements.length > 0);
  });
});

integratedTest("a flagged member reads the desktop Library as compact rows and can still open a skill and the add picker", async ({ world, user, agent, probe, step, evidence }) => {
  await step("after: descriptions sit under names and Ready is a state word, without non-numeric column headings", async () => {
    await user.resizeViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    await agent.run("route.extensions.skills");
    await user.click({ role: "button", label: "All" });
    for (const name of world.skills) await user.see({ text: name }, { timeoutMs: 60_000 });
    const rows = await probe.eventually(async () => (await probe.dom("[data-library-integrated-row]")).elements, {
      within: 60_000, label: "the organization rollout selects the compact Library", until: (items) => items.length >= world.skills.length + world.servers.length,
    });
    expect((await probe.dom("[data-library-columns]")).elements).toHaveLength(0);
    const description = (await probe.dom('[data-library-row="weekly-update"] [data-library-description]')).elements[0];
    const state = (await probe.dom('[data-library-row="weekly-update"] + [data-library-status]')).elements[0];
    expect(description?.text).toContain("Friday team update");
    expect(state?.text).toBe("Ready");
    expect(rows.every((row) => row.rect.height >= 44 && row.rect.height <= 52)).toBe(true);
    evidence.recordAssertionEvidence("the desktop uses the same row anatomy without Den chrome", `${rows.length} compact rows, each 44–52px; weekly-update shows its description and Ready; no column labels`, true);
    await user.screenshot();
  });

  await step("after: state and action lanes stay straight at wide and laptop sizes without sideways scrolling", async () => {
    for (const width of [2560, 1280, 900]) {
      await user.resizeViewport({ width, height: 900, deviceScaleFactor: 1 });
      const page = await probe.dom("[data-library-integrated-row]");
      const states = (await probe.dom("[data-library-integrated-row] > [data-library-status]")).elements;
      const actions = (await probe.dom("[data-library-action]")).elements;
      expect(page.documentWidth).toBeLessThanOrEqual(page.viewportWidth);
      expect(lanes(states.map((item) => item.rect))).toHaveLength(1);
      expect(lanes(actions.map((item) => item.rect))).toHaveLength(1);
      await user.screenshot();
    }
    evidence.recordAssertionEvidence("the compact lanes remain aligned as the window changes", "2560, 1280 and 900px windows: one state lane, one action lane, no horizontal document overflow", true);
  });

  await step("after: a skill still opens its full description and steps", async () => {
    const skill = world.skills[0];
    if (!skill) throw new Error("No skill was arranged.");
    await user.click({ text: skill });
    await user.see({ text: skill });
    expect((await probe.dom("[data-extension-detail-page]")).elements).toHaveLength(1);
    evidence.recordAssertionEvidence("only the list presentation changed", `${skill} opens the existing detail page`, true);
    await user.screenshot();
  });

  await step("after: Add to library stays in the collection toolbar and opens the existing picker", async () => {
    await user.click({ role: "button", label: "Library" });
    await user.see({ role: "button", label: "Add to library" });
    await user.click({ role: "button", label: "Add to library" });
    await user.see({ role: "radio", label: /^Connector/ });
    await user.see({ role: "button", label: "Continue" });
    evidence.recordAssertionEvidence("the desktop add flow is unchanged", "The toolbar action opens Connector, Skill and Plugin choices with Continue", true);
    await user.screenshot();
  });
});
