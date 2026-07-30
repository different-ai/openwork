import { ensureSessionWorkspace } from "./lib/session-workspace.mjs";

const LONG_TITLE =
  "Review the OpenWork desktop sidebar title reveal across a deliberately overflowing conversation name";

const READ_TITLE = `(() => {
  const title = [...document.querySelectorAll('[data-session-title-overflowing="true"] > [data-session-title-text]')]
    .find((entry) => {
      return (entry.textContent || '').trim() === ${JSON.stringify(LONG_TITLE)};
    });
  if (!(title instanceof HTMLElement)) return null;
  const viewport = title.parentElement;
  if (!(viewport instanceof HTMLElement)) return null;
  const titleStyle = getComputedStyle(title);
  const viewportStyle = getComputedStyle(viewport);
  const titleRect = title.getBoundingClientRect();
  const viewportRect = viewport.getBoundingClientRect();
  return {
    left: titleRect.left,
    top: titleRect.top,
    width: titleRect.width,
    height: titleRect.height,
    clientWidth: viewport.clientWidth,
    scrollWidth: title.scrollWidth,
    transform: titleStyle.transform,
    translate: titleStyle.translate,
    animationName: titleStyle.animationName,
    nativeTitle: title.getAttribute('title'),
    maskImage: viewportStyle.maskImage || viewportStyle.webkitMaskImage,
    overflow: viewportStyle.overflow,
    viewportLeft: viewportRect.left,
    viewportRight: viewportRect.right,
  };
})()`;

export default {
  id: "sidebar-title-hover-marquee",
  title: "Overflowing session titles reveal more text after hover intent without moving row controls",
  kind: "user-facing",
  steps: [
    {
      name: "Overflow-only title reveal preserves the sidebar row",
      run: async (ctx) => {
        await ensureSessionWorkspace(ctx, "sidebar-title-hover-marquee");
        await ctx.control("session.create_task");
        const sessionId = await ctx.waitFor(`(() => {
          const route = window.__openworkControl.snapshot().route || "";
          const match = route.match(/session\\/([^/?#]+)/);
          return match ? decodeURIComponent(match[1]) : null;
        })()`, { timeoutMs: 30_000, label: "created session" });
        await ctx.control("session.rename", { sessionId, title: LONG_TITLE });
        await ctx.waitFor(`${READ_TITLE}?.scrollWidth > ${READ_TITLE}?.clientWidth`, {
          timeoutMs: 30_000,
          label: "overflowing session title",
        });

        const before = await ctx.eval(READ_TITLE);
        ctx.assert(before, "Could not measure the overflowing title.");
        await ctx.client.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: Math.round(before.left + Math.min(before.width / 2, 80)),
          y: Math.round(before.top + before.height / 2),
        });
        await new Promise((resolve) => setTimeout(resolve, 1_100));

        await ctx.prove("A genuinely overflowing title reveals more text only after hover intent without a competing browser tooltip", {
          action: async () => {},
          assert: async () => {
            const after = await ctx.eval(READ_TITLE);
            ctx.assert(after, "Could not measure the title after hover.");
            ctx.assert(
              after.animationName !== "none" ||
                after.transform !== "none" ||
                after.translate !== "none" ||
                after.left < before.left - 1,
              `Expected visible title motion after hover intent: ${JSON.stringify({ before, after })}`,
            );
            ctx.assert(
              before.nativeTitle === null && after.nativeTitle === null,
              `Expected no native browser tooltip while revealing an overflowing title: ${JSON.stringify({
                before: before.nativeTitle,
                after: after.nativeTitle,
              })}`,
            );
            ctx.assert(
              after.maskImage !== "none",
              `Expected a clipped-edge mask while the title is moving, got ${after.maskImage}.`,
            );
            ctx.assert(
              Math.abs(after.viewportLeft - before.viewportLeft) <= 1 &&
                after.viewportRight <= before.viewportRight + 1,
              "The title viewport shifted instead of staying anchored while row actions appeared.",
            );
          },
          screenshot: {
            name: "overflowing-title-mid-animation",
            requireText: ["Review the OpenWork desktop sidebar"],
          },
        });
      },
    },
  ],
};
