import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/task-suggestion-card-alignment.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("task-suggestion-card-alignment");

const HERO_HEADING = "What do you need done?";
const WINDOW_HEIGHT = 705;

async function closeStaleDialogs(ctx) {
  await ctx.eval(`(() => {
    for (let index = 0; index < 3; index += 1) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }
    const active = document.activeElement;
    if (active && typeof active.blur === "function") active.blur();
    return true;
  })()`);
}

/** Emulate a narrower window; `null` restores the real one. */
async function setWindowWidth(ctx, width) {
  if (width === null) {
    await ctx.client.send("Emulation.clearDeviceMetricsOverride");
  } else {
    await ctx.client.send("Emulation.setDeviceMetricsOverride", {
      width,
      height: WINDOW_HEIGHT,
      deviceScaleFactor: 0,
      mobile: false,
    });
  }
}

async function bootPrecondition(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", {
    timeoutMs: 60_000,
    label: "control API",
  });
  await closeStaleDialogs(ctx);
  // A failed run can leave a width override behind; start from the real window.
  await setWindowWidth(ctx, null);
  const state = await ctx.waitFor(
    `(() => {
      const route = String(window.__openworkControl.snapshot().route || "");
      if (route.startsWith("/welcome") || route.startsWith("/signin")) return "blocked";
      const action = window.__openworkControl.listActions().find((item) => item.id === "route.session");
      return action && !action.disabled ? "ready" : null;
    })()`,
    { timeoutMs: 30_000, label: "route.session enabled (or welcome/signin)" },
  );
  return state === "blocked"
    ? "Profile is not onboarded (welcome/signin); the new task screen needs a workspace."
    : null;
}

/**
 * Geometry of every starter suggestion card on the new task screen. The grid is
 * found from the hero heading so the measurement never depends on the card copy,
 * which organizations can override.
 */
const READ_CARDS = `(() => {
  const heading = Array.from(document.querySelectorAll("h2"))
    .find((node) => (node.textContent || "").includes(${JSON.stringify(HERO_HEADING)}));
  if (!heading) return { ok: false, reason: "hero heading not found" };
  const hero = heading.closest("div")?.parentElement;
  const grid = hero
    ? Array.from(hero.querySelectorAll("div")).find((node) =>
      getComputedStyle(node).display === "grid" && node.querySelectorAll(":scope > button").length >= 2)
    : null;
  if (!grid) return { ok: false, reason: "suggestion grid not found" };
  const cards = Array.from(grid.querySelectorAll(":scope > button"));
  return {
    ok: true,
    columns: getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length,
    cards: cards.map((card) => {
      const title = card.children[0];
      const description = card.children[1];
      if (!title || !description) return { title: "", incomplete: true };
      const cardRect = card.getBoundingClientRect();
      const titleRect = title.getBoundingClientRect();
      const styles = getComputedStyle(card);
      return {
        title: (title.textContent || "").trim(),
        cardTop: Math.round(cardRect.top),
        cardHeight: Math.round(cardRect.height),
        titleTop: Math.round(titleRect.top),
        titleOffset: Math.round(titleRect.top - cardRect.top),
        contentInset: Math.round(parseFloat(styles.paddingTop) + parseFloat(styles.borderTopWidth)),
        descriptionHeight: Math.round(description.getBoundingClientRect().height),
      };
    }),
  };
})()`;

/** Cards that share a top edge are one visual row. */
function groupIntoRows(cards) {
  const rows = new Map();
  for (const card of cards) {
    const row = rows.get(card.cardTop) ?? [];
    row.push(card);
    rows.set(card.cardTop, row);
  }
  return Array.from(rows.values());
}

/**
 * Waits for the grid to settle at `width`, then asserts the whole claim: rows of
 * equal-height cards, descriptions that do not all wrap the same way, and titles
 * pinned to the top padding of every card.
 */
async function expectAlignedRows(ctx, width) {
  const layout = await ctx.waitFor(
    `(() => {
      if (Math.abs(window.innerWidth - ${width}) > 1) return null;
      const result = ${READ_CARDS};
      return result.ok && result.cards.length === 4 ? result : null;
    })()`,
    { timeoutMs: 30_000, label: `four suggestion cards laid out at ${width}px` },
  );

  for (const card of layout.cards) {
    ctx.assert(!card.incomplete, `Suggestion card "${card.title}" is missing its title or description.`);
    ctx.assert(
      Math.abs(card.titleOffset - card.contentInset) <= 1,
      `At ${width}px the card "${card.title}" starts its title ${card.titleOffset}px below its top edge but its padding is only ${card.contentInset}px, so the content is vertically centered instead of top-aligned.`,
    );
  }

  ctx.assert(layout.columns === 2, `Expected a two-column suggestion grid at ${width}px, got ${layout.columns}.`);
  const rows = groupIntoRows(layout.cards);
  ctx.assert(rows.length === 2, `Expected 2 suggestion rows at ${width}px, got ${rows.length}.`);

  let rowsWithUnequalText = 0;
  for (const [index, row] of rows.entries()) {
    ctx.assert(row.length === 2, `Row ${index + 1} at ${width}px has ${row.length} cards, expected 2.`);
    const [left, right] = row;
    ctx.assert(
      left.cardHeight === right.cardHeight,
      `Row ${index + 1} at ${width}px has mismatched card heights: ${left.cardHeight} vs ${right.cardHeight}.`,
    );
    ctx.assert(
      left.titleTop === right.titleTop,
      `Row ${index + 1} at ${width}px has titles on different lines: "${left.title}" at y=${left.titleTop} vs "${right.title}" at y=${right.titleTop}.`,
    );
    if (left.descriptionHeight !== right.descriptionHeight) rowsWithUnequalText += 1;
    ctx.log(
      `${width}px row ${index + 1}: cardHeight=${left.cardHeight} descriptions=${left.descriptionHeight}/${right.descriptionHeight} titles aligned at y=${left.titleTop}`,
    );
  }

  ctx.assert(
    rowsWithUnequalText > 0,
    `At ${width}px every row had descriptions of equal height, so this frame cannot witness the misalignment condition.`,
  );
  ctx.output(`geometry-${width}px`, JSON.stringify(layout.cards, null, 2));
  return layout;
}

export default {
  id: "task-suggestion-card-alignment",
  title: "Starter suggestion titles align across each row even when a description wraps",
  kind: "user-facing",
  precondition: bootPrecondition,
  steps: [
    {
      name: "New task screen aligns the suggestion titles",
      run: async (ctx) => {
        await ctx.prove("Both titles in a row share one line while one description wraps to two", {
          voiceover: vo[0],
          action: async () => {
            await closeStaleDialogs(ctx);
            await setWindowWidth(ctx, null);
            await ctx.control("route.session");
            await ctx.waitForText(HERO_HEADING, { timeoutMs: 30_000 });
          },
          assert: async () => {
            const width = await ctx.eval("window.innerWidth");
            await expectAlignedRows(ctx, width);
          },
          screenshot: {
            name: "new-task-suggestions-aligned",
            requireText: [HERO_HEADING],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Titles stay aligned when the window narrows",
      run: async (ctx) => {
        await ctx.prove("Re-wrapping the descriptions at 880px keeps both titles on one line", {
          voiceover: vo[1],
          action: async () => {
            await setWindowWidth(ctx, 880);
            await ctx.waitForText(HERO_HEADING, { timeoutMs: 30_000 });
          },
          assert: async () => {
            await expectAlignedRows(ctx, 880);
          },
          screenshot: {
            name: "narrow-window-suggestions-aligned",
            requireText: [HERO_HEADING],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Titles stay aligned once the sidebar collapses",
      run: async (ctx) => {
        await ctx.prove("Titles remain pinned to the top of each card at 700px", {
          voiceover: vo[2],
          action: async () => {
            await setWindowWidth(ctx, 700);
            await ctx.waitForText(HERO_HEADING, { timeoutMs: 30_000 });
          },
          assert: async () => {
            await expectAlignedRows(ctx, 700);
          },
          screenshot: {
            name: "collapsed-sidebar-suggestions-aligned",
            requireText: [HERO_HEADING],
            rejectText: ["Something went wrong"],
          },
        });
        // Leave the real window behind for the next flow.
        await setWindowWidth(ctx, null);
      },
    },
  ],
};
