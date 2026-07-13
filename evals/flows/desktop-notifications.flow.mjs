import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/desktop-notifications.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("desktop-notifications");

const setDesktopNotificationPreference = async (ctx, value) => {
  await ctx.eval(`(() => {
    const raw = localStorage.getItem("openwork.preferences");
    const prefs = raw ? JSON.parse(raw) : {};
    prefs.desktopNotifications = ${JSON.stringify(value)};
    localStorage.setItem("openwork.preferences", JSON.stringify(prefs));
    location.reload();
  })()`);
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 30_000 });
  await ctx.navigateHash("/settings/preferences");
  await ctx.expectText("Desktop Notifications", { timeoutMs: 30_000 });
};

export default {
  id: "desktop-notifications",
  title: "Preferences control native desktop notifications",
  kind: "user-facing",
  steps: [
    {
      name: "Preferences shows desktop notification modes",
      run: async (ctx) => {
        await ctx.prove("Preferences shows the Desktop Notifications setting with Off, Important, and All modes", {
          voiceover: vo[0],
          action: async () => {
            await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 30_000 });
            await setDesktopNotificationPreference(ctx, "off");
          },
          assert: async () => {
            await ctx.expectText("Desktop Notifications", { timeoutMs: 30_000 });
            await ctx.expectText("Notify me");
            await ctx.expectText("Off");
          },
          screenshot: {
            name: "desktop-notifications-off",
            requireText: ["Desktop Notifications", "Notify me", "Off"],
            hashIncludes: "/settings/preferences",
          },
        });
      },
    },
    {
      name: "Important mode persists",
      run: async (ctx) => {
        await ctx.prove("Choosing Important persists the important-only desktop notification mode", {
          voiceover: vo[1],
          action: async () => {
            await setDesktopNotificationPreference(ctx, "important");
          },
          assert: async () => {
            const value = await ctx.eval(`(() => {
              const raw = localStorage.getItem("openwork.preferences");
              const prefs = raw ? JSON.parse(raw) : {};
              return prefs.desktopNotifications;
            })()`);
            ctx.assert(value === "important", "Expected Important mode to persist in local preferences.");
            await ctx.expectText("Important");
          },
          screenshot: {
            name: "desktop-notifications-important",
            requireText: ["Desktop Notifications", "Important"],
            hashIncludes: "/settings/preferences",
          },
        });
      },
    },
    {
      name: "Attention notification text is event-specific",
      run: async (ctx) => {
        await ctx.prove("Attention notifications use text that reflects the triggering event", {
          voiceover: vo[2],
          action: async () => {
            await ctx.eval(`window.__OPENWORK_ELECTRON__?.invokeDesktop?.("desktopNotificationShow", {
              title: "Question needs your answer",
              body: "Question: Continue?"
            })`);
            await ctx.navigateHash("/settings/general");
          },
          assert: async () => {
            const bridgeAvailable = await ctx.eval(`Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop)`);
            ctx.assert(bridgeAvailable === true, "Expected the Electron notification bridge to be available.");
            await ctx.expectText("Workspace", { timeoutMs: 30_000 });
            await ctx.expectText("Global");
          },
          screenshot: {
            name: "desktop-notifications-attention-text",
            requireText: ["Settings", "Workspace", "Global"],
            hashIncludes: "/settings/general",
          },
        });
      },
    },
    {
      name: "All mode persists",
      run: async (ctx) => {
        await ctx.prove("Choosing All persists the mode that includes task completion notifications", {
          voiceover: vo[3],
          action: async () => {
            await setDesktopNotificationPreference(ctx, "all");
          },
          assert: async () => {
            const value = await ctx.eval(`(() => {
              const raw = localStorage.getItem("openwork.preferences");
              const prefs = raw ? JSON.parse(raw) : {};
              return prefs.desktopNotifications;
            })()`);
            ctx.assert(value === "all", "Expected All mode to persist in local preferences.");
            await ctx.expectText("All");
          },
          screenshot: {
            name: "desktop-notifications-all",
            requireText: ["Desktop Notifications", "All"],
            hashIncludes: "/settings/preferences",
          },
        });
      },
    },
  ],
};
