import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/command-k-settings.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("command-k-settings");

async function pressCommandK(ctx) {
  const isMac = await ctx.eval("/Mac/i.test(navigator.platform)");
  const modifier = isMac
    ? { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91, modifiers: 4 }
    : { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 2 };
  await ctx.client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: modifier.key,
    code: modifier.code,
    windowsVirtualKeyCode: modifier.windowsVirtualKeyCode,
    modifiers: modifier.modifiers,
  });
  await ctx.client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "k",
    code: "KeyK",
    windowsVirtualKeyCode: 75,
    modifiers: modifier.modifiers,
  });
  await ctx.client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "k",
    code: "KeyK",
    windowsVirtualKeyCode: 75,
    modifiers: modifier.modifiers,
  });
  await ctx.client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: modifier.key,
    code: modifier.code,
    windowsVirtualKeyCode: modifier.windowsVirtualKeyCode,
  });
}

async function pressEscape(ctx) {
  await ctx.client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await ctx.client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
}

export default {
  id: "command-k-settings",
  title: "Command K opens the command palette from Settings",
  kind: "user-facing",
  steps: [
    {
      name: "Open Settings",
      run: async (ctx) => {
        await ctx.prove("Settings is open and ready for keyboard navigation", {
          voiceover: vo[0],
          action: async () => {
            await pressEscape(ctx);
            await ctx.waitFor("Boolean(window.__openworkControl)", {
              timeoutMs: 30_000,
              label: "control API",
            });
            await ctx.control("route.settings.general");
            await ctx.waitFor("location.pathname.endsWith('/settings/general')", {
              timeoutMs: 30_000,
              label: "settings route",
            });
          },
          assert: async () => {
            const pathname = await ctx.eval("location.pathname");
            ctx.assert(pathname.endsWith("/settings/general"), `Expected settings pathname, got ${pathname}`);
            await ctx.expectText("Settings");
          },
          screenshot: {
            name: "settings-open",
            requireText: ["Settings"],
          },
        });
      },
    },
    {
      name: "Open the command palette",
      run: async (ctx) => {
        await ctx.prove("Command K opens the usual command palette over Settings", {
          voiceover: vo[1],
          action: async () => {
            await pressCommandK(ctx);
            await ctx.waitFor("Boolean(document.querySelector('[data-slot=\"autocomplete-input\"]'))", {
              timeoutMs: 15_000,
              label: "command palette input",
            });
            await new Promise((resolve) => setTimeout(resolve, 300));
          },
          assert: async () => {
            const pathname = await ctx.eval("location.pathname");
            ctx.assert(pathname.endsWith("/settings/general"), `Command palette left Settings for ${pathname}`);
            await ctx.expectText("Create new session");
            await ctx.expectText("Search sessions");
          },
          screenshot: {
            name: "command-palette-over-settings",
            requireText: ["Create new session", "Search sessions"],
          },
        });
      },
    },
  ],
};
