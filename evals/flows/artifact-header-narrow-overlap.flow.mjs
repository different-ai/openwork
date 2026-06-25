/**
 * Artifact header at narrow width: a long artifact filename truncates with an
 * ellipsis and never overlaps the header action buttons (Edit/Download/Open/
 * Close). Regression for the cramped/overlapping header reported when the
 * artifact panel is below a certain width.
 */
const MEASURE_HEADER = `(() => {
  const h3 = document.querySelector("h3");
  if (!h3 || h3.textContent.indexOf("very-long") === -1) return null;
  const closeBtn = Array.from(document.querySelectorAll("button"))
    .find((b) => b.getAttribute("aria-label") === "Close artifact");
  if (!closeBtn) return null;
  let group = closeBtn.parentElement;
  while (group && String(group.className || "").indexOf("shrink-0") === -1) group = group.parentElement;
  let row = h3.parentElement;
  while (row && String(row.className || "").indexOf("h-10") === -1) row = row.parentElement;
  if (!group || !row) return null;
  const h3Rect = h3.getBoundingClientRect();
  const groupRect = group.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const cs = getComputedStyle(h3);
  return {
    name: h3.textContent.trim(),
    rowWidth: Math.round(rowRect.width),
    h3Right: Math.round(h3Rect.right),
    h3ClientWidth: h3.clientWidth,
    h3ScrollWidth: h3.scrollWidth,
    truncated: h3.scrollWidth > h3.clientWidth + 1,
    whiteSpace: cs.whiteSpace,
    textOverflow: cs.textOverflow,
    groupLeft: Math.round(groupRect.left),
    groupRight: Math.round(groupRect.right),
    overlap: h3Rect.right > groupRect.left + 1,
    buttonsWithinRow: groupRect.right <= rowRect.right + 1,
    h3Visible: h3.clientWidth > 0,
  };
})()`;

export default {
  id: "artifact-header-narrow-overlap",
  title: "Artifact header truncates a long filename and does not overlap action buttons at narrow width",
  spec: "evals/react-session-flows.md",
  steps: [
    {
      name: "App is ready and Electron-backed",
      run: async (ctx) => {
        const userAgent = await ctx.eval("navigator.userAgent");
        ctx.assert(userAgent.includes("Electron/"), `Expected Electron userAgent, got ${userAgent}`);
        await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API" });
      },
    },
    {
      name: "Create or select a session and mount the side panel",
      run: async (ctx) => {
        const hasSelectedSession = await ctx.eval(`window.__openworkControl.snapshot().route.includes("/session/")`);
        if (!hasSelectedSession) {
          await ctx.control("session.create_task");
          await ctx.waitFor(`window.__openworkControl.snapshot().route.includes("/session/")`, {
            timeoutMs: 60_000,
            label: "session route after task creation",
          });
        }

        // The "Browser" rail toggles the side panel. The eval seed control
        // action only registers while the panel is mounted. Toggle deliberately
        // (at most twice), checking after each click, to land on "open".
        const seedReady = async () =>
          ctx.eval(`window.__openworkControl.listActions().some((a) => a.id === "eval.artifact_tabs.seed_overflow" && !a.disabled)`);
        const clickBrowserRail = () =>
          ctx.eval(`(() => {
            const button = Array.from(document.querySelectorAll("button"))
              .find((item) => item.getAttribute("aria-label") === "Browser" && !item.disabled);
            button?.click();
            return Boolean(button);
          })()`);

        for (let attempt = 0; attempt < 2 && !(await seedReady()); attempt += 1) {
          await clickBrowserRail();
          try {
            await ctx.waitFor(
              `window.__openworkControl.listActions().some((a) => a.id === "eval.artifact_tabs.seed_overflow" && !a.disabled)`,
              { timeoutMs: 6_000, label: "artifact overflow eval seed action" },
            );
          } catch {
            // panel toggled the wrong way; loop clicks it again
          }
        }
        ctx.assert(await seedReady(), "Side panel did not mount the artifact eval seed action.");
      },
    },
    {
      name: "Seed a long-named artifact and narrow the panel below the overlap threshold",
      run: async (ctx) => {
        await ctx.control("eval.artifact_tabs.seed_overflow", { count: 14, longNameLast: true });

        // Keep the long-named artifact active and constrain the artifact panel
        // column to a realistic narrow width (the live ResizablePanel minSize is
        // 320px), exactly like a user dragging the panel narrow.
        await ctx.waitFor(
          `(() => {
            const longTab = Array.from(document.querySelectorAll('button[aria-label^="Select tab"]'))
              .find((b) => (b.getAttribute("aria-label") || "").indexOf("very-long") !== -1);
            if (longTab) longTab.click();
            const h3 = document.querySelector("h3");
            if (!h3 || h3.textContent.indexOf("very-long") === -1) return false;
            let artifactRoot = h3;
            while (artifactRoot && String(artifactRoot.className || "").indexOf("flex-col") === -1) artifactRoot = artifactRoot.parentElement;
            const column = artifactRoot ? artifactRoot.parentElement : null;
            if (column) {
              column.style.width = "360px";
              column.style.minWidth = "360px";
              column.style.maxWidth = "360px";
              column.style.flex = "0 0 360px";
            }
            // header row must have actually reflowed narrow before we proceed
            let row = h3.parentElement;
            while (row && String(row.className || "").indexOf("h-10") === -1) row = row.parentElement;
            return Boolean(row && row.getBoundingClientRect().width <= 380);
          })()`,
          { timeoutMs: 30_000, label: "artifact panel narrowed and long title active" },
        );

        const metrics = await ctx.eval(MEASURE_HEADER);
        ctx.assert(metrics, "Could not measure the artifact header at narrow width.");
        ctx.assert(metrics.name.includes("very-long"), `Expected long artifact name, got ${metrics.name}`);
        ctx.assert(metrics.rowWidth <= 380, `Expected a narrow header (<=380px), got ${metrics.rowWidth}px`);
        ctx.log(`Header metrics: ${JSON.stringify(metrics)}`);

        await ctx.prove("Long artifact filename is constrained and ellipsis-truncated at narrow width", {
          claim: "At a narrow panel width the long artifact title is clipped to the header (truncate/ellipsis) instead of pushing out past the panel.",
          assert: () => {
            ctx.assert(metrics.whiteSpace === "nowrap", `Expected white-space:nowrap, got ${metrics.whiteSpace}`);
            ctx.assert(metrics.textOverflow === "ellipsis", `Expected text-overflow:ellipsis, got ${metrics.textOverflow}`);
            ctx.assert(metrics.truncated, `Expected the title to be truncated (scrollWidth ${metrics.h3ScrollWidth} > clientWidth ${metrics.h3ClientWidth}).`);
            // The full label is ~506px; the rendered title must be clipped to
            // well within the narrow row rather than spilling its full length.
            ctx.assert(metrics.h3ClientWidth < metrics.rowWidth, `Title clientWidth ${metrics.h3ClientWidth} should be clipped within the narrow row ${metrics.rowWidth}.`);
            ctx.assert(metrics.h3Right <= metrics.groupLeft, `Title right edge ${metrics.h3Right} must not pass the action group left edge ${metrics.groupLeft}.`);
          },
          screenshot: { name: "narrow-header-truncates", requireText: ["very-long"] },
        });

        await ctx.prove("Header action buttons are not overlapped by the title", {
          claim: "The title does not overlap the action button group and all buttons stay within the panel.",
          assert: () => {
            ctx.assert(!metrics.overlap, `Title overlaps action buttons (h3Right ${metrics.h3Right} > groupLeft ${metrics.groupLeft}).`);
            ctx.assert(metrics.buttonsWithinRow, `Action buttons overflow the panel (groupRight ${metrics.groupRight} > rowWidth ${metrics.rowWidth}).`);
          },
          screenshot: { name: "narrow-header-buttons-safe" },
        });
      },
    },
  ],
};
