import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { slashMenuWeb } from "../worlds/composer-slash-menu.ts";

const test = spec.world(slashMenuWeb, {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: [] },
});

const newSession = { role: "button", label: "New session" } as const;
const greeting = { text: "What do you need done?" } as const;
const list = "[data-composer-suggestions]";
const customizeWorkspace = { role: "option", label: /^\/customize-workspace/ } as const;

type Rect = { left: number; right: number; top: number; bottom: number; width: number; height: number };
const px = (value: number) => Math.round(value);

test("a member types / in a new chat and can read, pick, and dismiss commands", async ({ user, probe, step, evidence }) => {
  // Where the list sits against the composer and the window, read twice in a
  // row unchanged so the numbers describe the settled list, not a frame of it.
  const listGeometry = () => {
    let previous = "";
    return probe.eventually(async () => {
      const [popup, rows, highlighted, dock, page] = await Promise.all([
        probe.dom(list), probe.dom(`${list} [role='option']`), probe.dom(`${list} [role='option'][aria-selected='true']`),
        probe.dom("[data-empty-composer-dock]"), probe.dom("html"),
      ]);
      return {
        list: popup.elements[0]?.rect,
        rows: rows.elements.map((row) => row.rect),
        highlightedTop: highlighted.elements.map((row) => row.rect.top),
        composer: dock.elements[0]?.rect,
        window: { width: popup.viewportWidth, height: page.elements[0]?.rect.height ?? 0 },
        documentWidth: popup.documentWidth,
      };
    }, {
      within: 10_000,
      intervalMs: 50,
      label: "the command list settles above or below the composer",
      until: (geometry) => {
        const key = JSON.stringify([geometry.list, geometry.rows.length]);
        const settled = key === previous;
        previous = key;
        return settled && Boolean(geometry.list && geometry.composer && geometry.rows.length > 0
          && (geometry.list.top >= geometry.composer.bottom || geometry.list.bottom <= geometry.composer.top));
      },
    });
  };
  const listOpen = async () => (await probe.dom(list)).elements.length > 0;

  await step("given a new chat, the composer sits under the greeting with little room above it", async () => {
    await user.click(newSession);
    await user.see(greeting);
    await user.see("composer", { editable: true, text: "" });
    const [dock, page] = await Promise.all([probe.dom("[data-empty-composer-dock]"), probe.dom("html")]);
    const composer = dock.elements[0]?.rect;
    const height = page.elements[0]?.rect.height ?? 0;
    evidence.recordAssertionEvidence(
      "The composer of a new chat starts high in the window",
      composer ? `composer top ${px(composer.top)} px of a ${px(height)} px window` : "no composer found",
      composer !== undefined,
    );
    expect(composer).toBeDefined();
    await user.screenshot();
  });

  await step("when the member types /, the whole list is inside the window and long descriptions end in …", async () => {
    await user.type("composer", "/");
    const geometry = await listGeometry();
    const box = geometry.list as Rect;
    const composer = geometry.composer as Rect;
    const inWindow = box.top >= 0 && box.left >= 0 && box.right <= geometry.window.width && box.bottom <= geometry.window.height;
    const widest = Math.max(...geometry.rows.map((row) => row.width));
    const rowsFit = geometry.rows.every((row) => row.left >= box.left && row.right <= box.right);
    const noPageScroll = geometry.documentWidth <= geometry.window.width;
    const firstHighlighted = geometry.highlightedTop.length === 1 && geometry.highlightedTop[0] === geometry.rows[0]?.top;
    evidence.recordAssertionEvidence(
      "Every command row fits inside the list, and the list inside the window",
      `list ${px(box.left)}–${px(box.right)} × ${px(box.top)}–${px(box.bottom)} px in a ${px(geometry.window.width)}×${px(geometry.window.height)} window, `
        + `${box.top >= composer.bottom ? "below" : "above"} the composer (${px(composer.top)}–${px(composer.bottom)}); `
        + `${geometry.rows.length} rows, widest ${px(widest)} of ${px(box.width)} px, first row highlighted: ${firstHighlighted}; page width ${geometry.documentWidth} px`,
      inWindow && rowsFit && noPageScroll && firstHighlighted,
    );
    expect({ inWindow, rowsFit, noPageScroll, firstHighlighted }).toEqual({ inWindow: true, rowsFit: true, noPageScroll: true, firstHighlighted: true });
    await user.screenshot();
  });

  await step("then clicking in the message keeps the list, and clicking outside it closes it", async () => {
    await user.click("composer");
    const keptAfterMessageClick = await listOpen();
    await user.click(greeting);
    await probe.eventually(listOpen, { within: 5_000, intervalMs: 50, label: "the command list closes", until: (open) => !open });
    const draft = (await probe.composer()).draftText;
    evidence.recordAssertionEvidence(
      "An outside click closes the list without touching the draft",
      `open after clicking the message: ${keptAfterMessageClick}; open after clicking the greeting: ${await listOpen()}; draft ${JSON.stringify(draft)}`,
      keptAfterMessageClick && draft.trim() === "/",
    );
    expect({ keptAfterMessageClick, draft: draft.trim() }).toEqual({ keptAfterMessageClick: true, draft: "/" });
    await user.screenshot();
  });

  await step("after: typing reopens the list, and picking Customize workspace puts the skill in the message", async () => {
    await user.type("composer", "customize-w");
    await user.click(customizeWorkspace);
    await probe.eventually(listOpen, { within: 5_000, intervalMs: 50, label: "the command list closes", until: (open) => !open });
    const tokens = await probe.dom('[title="Skill: customize-workspace"]');
    evidence.recordAssertionEvidence(
      "The chosen command lands in the message as one skill",
      `skill tokens: ${JSON.stringify(tokens.elements.map((element) => element.text))}; list open: ${await listOpen()}`,
      tokens.elements.length === 1,
    );
    expect(tokens.elements).toHaveLength(1);
    await user.screenshot();
  });
});
