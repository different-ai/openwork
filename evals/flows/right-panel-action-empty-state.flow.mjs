import { ensureSessionWorkspace } from "./lib/session-workspace.mjs";

const READ_CHOOSER = `(() => {
  const panel = [...document.querySelectorAll('aside, [role="complementary"], main + div, [data-side-panel]')]
    .find((entry) => /choose|open in (the )?side panel|side panel/i.test(entry.textContent || ''));
  if (!(panel instanceof HTMLElement)) return null;
  const actions = [...panel.querySelectorAll('button, a')]
    .filter((entry) => !entry.hasAttribute('disabled'))
    .map((entry) => ({
      label: (entry.getAttribute('aria-label') || entry.textContent || '').trim(),
      shortcut: entry.getAttribute('aria-keyshortcuts'),
    }))
    .filter((entry) => entry.label.length > 0);
  return {
    text: (panel.textContent || '').trim(),
    actions,
    width: Math.round(panel.getBoundingClientRect().width),
  };
})()`;

export default {
  id: "right-panel-action-empty-state",
  title: "The empty right panel offers real runtime-supported destinations",
  kind: "user-facing",
  steps: [
    {
      name: "Opening an empty panel presents an actionable chooser",
      run: async (ctx) => {
        await ensureSessionWorkspace(
          ctx,
          "right-panel-action-empty-state",
        );
        if (!String(await ctx.eval("window.__openworkControl.snapshot().route || ''")).includes("/session/")) {
          await ctx.control("session.create_task");
          await ctx.waitFor(
            "window.__openworkControl.snapshot().route.includes('/session/')",
            { timeoutMs: 30_000, label: "session route" },
          );
        }
        const opened = await ctx.eval(`(() => {
          const button = document.querySelector('button[aria-label="Open side panel"]');
          if (!(button instanceof HTMLElement)) return false;
          button.click();
          return true;
        })()`);
        ctx.assert(opened === true, "The general Open side panel control was not actionable.");
        await ctx.waitFor(`Boolean(${READ_CHOOSER})`, {
          timeoutMs: 20_000,
          label: "right-panel action chooser",
        });

        await ctx.prove("The no-content side panel exposes supported destinations as keyboard-accessible actions", {
          action: async () => {},
          assert: async () => {
            const chooser = await ctx.eval(READ_CHOOSER);
            ctx.assert(chooser, "The deliberate right-panel empty state was not found.");
            const labels = chooser.actions.map((entry) => entry.label);
            ctx.assert(labels.length >= 2, `Expected at least two real destinations, got ${JSON.stringify(labels)}.`);
            ctx.assert(
              labels.some((label) => /browser/i.test(label)),
              `Expected a Browser destination in the desktop runtime, got ${JSON.stringify(labels)}.`,
            );
            ctx.assert(
              labels.some((label) => /files|artifacts/i.test(label)),
              `Expected a Files or Artifacts destination, got ${JSON.stringify(labels)}.`,
            );
            ctx.assert(chooser.width >= 300, `Expected a usable panel width, got ${chooser.width}px.`);
          },
          screenshot: {
            name: "right-panel-action-chooser",
            requireText: ["Browser"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
  ],
};
