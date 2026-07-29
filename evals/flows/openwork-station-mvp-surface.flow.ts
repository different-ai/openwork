import { defineFlow } from "../runner/flow.ts";

type StationStatus = {
  interactionMode?: string;
  runtime?: { phase?: string };
  selectedId?: string | null;
  suggestions?: Array<{ id?: string; title?: string }>;
};

function readStatus(value: unknown): StationStatus {
  return typeof value === "object" && value !== null ? value as StationStatus : {};
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default defineFlow({
  id: "openwork-station-mvp-surface",
  title: "Station focus mode reveals ordered cards and Enter continues in OpenWork",
  kind: "internal",
  steps: [
    {
      name: "Keep accumulated context discreet in passive mode",
      run: async (ctx) => {
        if (await ctx.hasText("Back to app")) {
          await ctx.clickText("Back to app");
          await sleep(750);
        }
        await ctx.control("station.seed_demo", { stage: "living" });
        await ctx.control("station.mode.set", { active: false });
        const state = readStatus(await ctx.control("station.status"));
        ctx.assert(state.interactionMode === "passive", "Station begins in passive research mode");
        ctx.assert((state.suggestions?.length ?? 0) >= 3, "Passive mode keeps ordered context ready");
        await ctx.screenshot("passive-status-pill", {
          targetUrlIncludes: "station.html",
          pretty: false,
          claim: "Passive Station shows only a compact listening and research status pill.",
          voiceover: "Station keeps listening and researching quietly. No bubble cluster or context card competes for attention.",
          rejectText: [
            "Maya’s launch concern from last week",
            "Why now",
            "Ambient agent active",
          ],
        });
      },
    },
    {
      name: "Whisper only when Station is processing",
      run: async (ctx) => {
        await ctx.control("station.seed_demo", { stage: "processing" });
        await ctx.control("station.mode.set", { active: false });
        const state = readStatus(await ctx.control("station.status"));
        ctx.assert(state.runtime?.phase === "transcribing", "The compact pill distinguishes active processing");
        await ctx.screenshot("passive-processing-whisper", {
          targetUrlIncludes: "station.html",
          pretty: false,
          claim: "A restrained dotted activity rail replaces extra status copy while Station processes speech.",
          voiceover: "The pill stays quiet. A tiny OpenWork-blue dot field changes rhythm while Station is transcribing, deciding, or researching.",
          rejectText: [
            "Listening",
            "Understanding",
            "Researching context",
            "Why now",
          ],
        });
        await ctx.control("station.seed_demo", { stage: "living" });
      },
    },
    {
      name: "Activate the highest-priority card and move through history",
      run: async (ctx) => {
        await ctx.control("station.mode.set", { active: true });
        let state = readStatus(await ctx.control("station.status"));
        ctx.assert(state.interactionMode === "active", "The global Station shortcut is reflected in Station state");
        ctx.assert(
          state.selectedId === state.suggestions?.[0]?.id,
          "Active mode starts at the highest-priority card",
        );
        await sleep(280);
        await ctx.screenshot("active-priority-card", {
          targetUrlIncludes: "station.html",
          pretty: true,
          claim: "Active mode deals one priority card from behind the always-on-top pill.",
          voiceover: "Command Shift Space makes the current priority visible. The pill stays above the card and the interface explains the arrow and Enter controls without extra chrome.",
          requireText: [
            "Maya’s launch concern from last week",
            "Not now",
            "Start thread",
          ],
          rejectText: [
            "station-bubbles",
            "Why now",
            "Your passive AI right hand",
            "Ambient agent active",
          ],
        });

        const previous = await ctx.control("station.history.navigate", { direction: "older" });
        ctx.output("Older-card navigation", JSON.stringify(previous, null, 2));
        state = readStatus(await ctx.control("station.status"));
        ctx.assert(state.selectedId !== state.suggestions?.[0]?.id, "Left Arrow semantics move into older card history");
        await sleep(260);
        await ctx.screenshot("older-card-history", {
          targetUrlIncludes: "station.html",
          pretty: true,
          claim: "An older card replaces the current card with the same controlled slide motion.",
          voiceover: "Left and right move through the bounded ordered history without wrapping or opening a second surface.",
          requireText: ["Follow up with Maya", "Not now", "Start thread"],
        });
        const beforeDismiss = state.suggestions?.length ?? 0;
        const dismissedId = state.selectedId;
        await ctx.control("station.dismiss");
        state = readStatus(await ctx.control("station.status"));
        ctx.assert(
          state.suggestions?.length === beforeDismiss - 1
            && state.selectedId !== dismissedId,
          "Escape / Not now removes only the current card and deals the next priority",
        );
      },
    },
    {
      name: "Continue the card as a real OpenWork thread",
      run: async (ctx) => {
        const handoff = await ctx.control("station.handoff");
        ctx.output("Station handoff", JSON.stringify(handoff, null, 2));
        ctx.assert(
          typeof handoff === "object"
            && handoff !== null
            && Reflect.get(handoff, "ok") === true
            && typeof Reflect.get(handoff, "threadId") === "string",
          "Enter semantics created a real OpenWork thread",
        );
        await sleep(1_200);
        const state = readStatus(await ctx.control("station.status"));
        ctx.assert(state.interactionMode === "passive", "Handoff releases the modal shortcuts and returns to passive mode");
        await ctx.screenshot("openwork-thread-handoff", {
          pretty: true,
          claim: "The selected Station context starts a steerable OpenWork conversation.",
          voiceover: "Pressing Enter moves the full context, its reason, and connected evidence into a new OpenWork thread, then returns Station to passive mode.",
          requireText: [
            "Continue from this OpenWork Station context",
            "Maya’s launch concern from last week",
          ],
        });
      },
    },
    {
      name: "Dismiss the final card without rebounding the island",
      run: async (ctx) => {
        await ctx.control("station.seed_demo", { stage: "memory" });
        await ctx.control("station.mode.set", { active: true });
        await sleep(280);
        await ctx.control("station.dismiss");
        await sleep(520);
        const state = readStatus(await ctx.control("station.status"));
        ctx.assert((state.suggestions?.length ?? 0) === 0, "Not now removes the final queued card");
        ctx.assert(
          state.interactionMode === "passive",
          "Dismissing the final card atomically returns Station to passive mode",
        );
        await ctx.screenshot("dismissed-final-card", {
          targetUrlIncludes: "station.html",
          pretty: false,
          claim: "After the final dismissal, the pill stays at its stable passive anchor without reopening.",
          voiceover: "Not now clears the final card and returns Station to passive in one state change. New research stays quiet until the user activates Station again.",
          rejectText: [
            "Maya’s launch concern from last week",
            "Not now",
            "Start thread",
          ],
        });
      },
    },
  ],
});
