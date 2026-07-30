const READ_SHORTCUT_ROWS = `(() => [...document.querySelectorAll('[aria-keyshortcuts]')]
  .map((entry) => ({
    shortcut: entry.getAttribute('aria-keyshortcuts'),
    label: (entry.getAttribute('aria-label') || entry.textContent || '').trim(),
    visible: Boolean(entry.getClientRects().length),
  }))
  .filter((entry) => entry.visible && /(?:Meta|Control)\\+[1-9]/.test(entry.shortcut || '')))()`;

export default {
  id: "sidebar-session-number-shortcuts",
  title: "Platform-modifier number shortcuts match visible session order",
  kind: "user-facing",
  steps: [
    {
      name: "Holding the platform modifier reveals accurate first-nine session shortcuts",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__openworkControl)", {
          timeoutMs: 60_000,
          label: "control API",
        });
        for (let index = 1; index <= 3; index += 1) {
          await ctx.control("session.create_task");
          const sessionId = await ctx.waitFor(`(() => {
            const route = window.__openworkControl.snapshot().route || "";
            const match = route.match(/session\\/([^/?#]+)/);
            return match ? decodeURIComponent(match[1]) : null;
          })()`, { timeoutMs: 30_000, label: `created session ${index}` });
          await ctx.control("session.rename", {
            sessionId,
            title: `Shortcut proof chat ${index}`,
          });
        }

        const isMac = await ctx.eval("navigator.platform.toLowerCase().includes('mac')");
        await ctx.client.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: isMac ? "Meta" : "Control",
          code: isMac ? "MetaLeft" : "ControlLeft",
          modifiers: isMac ? 4 : 2,
        });
        await ctx.waitFor(`${READ_SHORTCUT_ROWS}.length >= 3`, {
          timeoutMs: 20_000,
          label: "numbered visible session rows",
        });

        await ctx.prove("Modifier badges appear without changing layout and expose accessible shortcuts", {
          action: async () => {},
          assert: async () => {
            const rows = await ctx.eval(READ_SHORTCUT_ROWS);
            ctx.assert(rows.length >= 3, `Expected at least three numbered rows, got ${JSON.stringify(rows)}.`);
            const firstNine = rows.slice(0, 9).map((entry) => entry.shortcut);
            ctx.assert(new Set(firstNine).size === firstNine.length, "Visible session shortcuts must be unique.");
            ctx.assert(
              firstNine.every((shortcut, index) => shortcut.endsWith(`+${index + 1}`)),
              `Shortcut numbering did not match visible order: ${JSON.stringify(firstNine)}.`,
            );
          },
          screenshot: {
            name: "sidebar-session-number-shortcuts-held",
            requireText: ["Shortcut proof chat"],
          },
        });

        await ctx.client.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: isMac ? "Meta" : "Control",
          code: isMac ? "MetaLeft" : "ControlLeft",
        });
      },
    },
  ],
};
