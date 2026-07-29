import { defineFlow, type FlowContext } from "../runner/flow.ts";

type NativeStationState = {
  enabled?: boolean;
  registered?: boolean;
  shortcut?: string;
};

function readNativeState(value: unknown): NativeStationState {
  return typeof value === "object" && value !== null ? value as NativeStationState : {};
}

async function nativeState(ctx: FlowContext) {
  return readNativeState(await ctx.eval(
    "window.__OPENWORK_ELECTRON__?.station?.getEnabled?.()",
    { awaitPromise: true },
  ));
}

export default defineFlow({
  id: "openwork-station-preferences",
  title: "Station is an explicit desktop capability with complete enable and disable boundaries",
  kind: "user-facing",
  steps: [
    {
      name: "Station begins fully off",
      run: async (ctx) => {
        await ctx.navigateHash("/settings/preferences");
        await ctx.waitForText("OpenWork Station", { timeoutMs: 30_000 });
        if (await ctx.hasText("Disable")) {
          await ctx.clickText("Disable", { selector: "button" });
          await ctx.waitForText("Enable Station");
        } else if ((await nativeState(ctx)).enabled === true) {
          await ctx.eval(
            "window.__OPENWORK_ELECTRON__?.station?.setEnabled?.(false)",
            { awaitPromise: true },
          );
        }
        const state = await nativeState(ctx);
        ctx.assert(state.enabled === false, "Station is disabled until the user explicitly enables it");
        ctx.assert(state.registered === false, "The Station shortcut is not registered while disabled");
        await ctx.screenshot("station-disabled-preference", {
          pretty: false,
          claim: "Preferences makes Station opt-in and explains the complete off boundary.",
          voiceover: "Station begins off. No native island, global shortcut, microphone capture, or Realtime session exists until the user chooses Enable Station.",
          requireText: [
            "OpenWork Station",
            "Enable Station",
            "Off means off",
            "Physical microphone",
            "OpenAI Realtime",
          ],
          rejectText: ["Open Station", "Disable"],
        });
      },
    },
    {
      name: "Enable provisions the native Station capability",
      run: async (ctx) => {
        await ctx.clickText("Enable Station", { selector: "button" });
        await ctx.waitForText("Station is enabled");
        const state = await nativeState(ctx);
        ctx.assert(state.enabled === true, "The explicit Enable button provisions Station");
        ctx.assert(state.registered === true, "The mode shortcut exists only after Station is enabled");
        ctx.assert(
          state.shortcut === "CommandOrControl+Shift+Space",
          "Preferences provisions the documented Station shortcut",
        );
        await ctx.screenshot("station-enabled-preference", {
          pretty: false,
          claim: "Enabled Station exposes only two clear controls: Open Station and Disable.",
          voiceover: "Once enabled, Preferences stays simple. Open Station brings the discreet island forward; Disable tears the capability back down.",
          requireText: [
            "Station is enabled",
            "Open Station",
            "Disable",
            "Physical microphone",
            "review-only context cards",
          ],
          rejectText: ["Enable Station"],
        });
      },
    },
    {
      name: "Disable tears down the native capability",
      run: async (ctx) => {
        await ctx.clickText("Disable", { selector: "button" });
        await ctx.waitForText("Microphone capture, Realtime inference, the shortcut, and the island are off.");
        const state = await nativeState(ctx);
        ctx.assert(state.enabled === false, "Disable tears Station down");
        ctx.assert(state.registered === false, "Disable unregisters the global shortcut");
      },
    },
  ],
});
