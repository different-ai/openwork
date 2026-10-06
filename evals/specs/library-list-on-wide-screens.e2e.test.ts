import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { libraryListWide } from "../worlds/library-list-wide.ts";

const test = spec.world(libraryListWide, {
  timeout: 300_000,
  resources: { surfaces: ["appWeb"], services: [] },
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

  await step("after: at 1920 wide every row has its own What it does, Kind and From columns, in straight lanes", async () => {
    const header = await probe.eventually(async () => (await probe.dom("[data-library-columns]")).elements, {
      within: 10_000, label: "the column header shows", until: (elements) => elements.length === 1 && (elements[0]?.rect.width ?? 0) > 0,
    });
    const listed = await rows(expected);
    const descriptions = (await probe.dom("button[data-library-row] [data-library-description]")).elements;
    const visible = descriptions.filter((element) => element.rect.width > 0);
    const descriptionLanes = lanes(visible.map((element) => element.rect));
    const widest = Math.max(...visible.map((element) => element.rect.width));
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "Name · What it does · Kind · From, aligned",
      `header "${header[0]?.text}"; ${visible.length}/${listed.length} rows show what they do; description lane starts at x=${descriptionLanes.join(", ")}; widest ${Math.round(widest)}px`,
      header[0]?.text.includes("What it does") === true && visible.length === listed.length && descriptionLanes.length === 1,
    );
    expect(header[0]?.text).toContain("What it does");
    expect(visible).toHaveLength(listed.length);
    expect(descriptionLanes).toHaveLength(1);
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

  await step("on a narrower window (1180 wide) the row folds back to Name, Kind and one caption, without the column header", async () => {
    await user.resizeViewport({ width: 1180, height: 800, deviceScaleFactor: 1 });
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
