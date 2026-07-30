import { defineFlow } from "../runner/flow.ts";
import { loadVoiceoverParagraphs } from "../runner/voiceover.ts";

// Narration is loaded from the approved script (evals/voiceovers/cloud-instance.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("cloud-instance");
if (!vo) throw new Error("Missing approved voice-over script for cloud-instance.");

export default defineFlow({
  id: "cloud-instance",
  title: "TODO: one-line claim — user can do X and sees Y",
  kind: "user-facing",
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("TODO: claim for frame 1", {
          voiceover: vo[0],
          // "I'm signed in to OpenWork on the web. There's no Cloud anywhere — not in the"
          action: async () => {
            // TODO: drive the app as the end user (ctx.clickText, ctx.fill, ...)
          },
          assert: async () => {
            // TODO: witness the side effect (ctx.expectText, ctx.eval, ...)
            ctx.assert(false, "frame 1 not implemented yet");
          },
          screenshot: { name: "frame-1", requireText: [] },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("TODO: claim for frame 2", {
          voiceover: vo[1],
          // "A platform admin turns Cloud on for my organization alone. It stays off for "
          action: async () => {
            // TODO: drive the app as the end user (ctx.clickText, ctx.fill, ...)
          },
          assert: async () => {
            // TODO: witness the side effect (ctx.expectText, ctx.eval, ...)
            ctx.assert(false, "frame 2 not implemented yet");
          },
          screenshot: { name: "frame-2", requireText: [] },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("TODO: claim for frame 3", {
          voiceover: vo[2],
          // "I reload, and Cloud is in my sidebar, marked Alpha. Nothing to install, noth"
          action: async () => {
            // TODO: drive the app as the end user (ctx.clickText, ctx.fill, ...)
          },
          assert: async () => {
            // TODO: witness the side effect (ctx.expectText, ctx.eval, ...)
            ctx.assert(false, "frame 3 not implemented yet");
          },
          screenshot: { name: "frame-3", requireText: [] },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("TODO: claim for frame 4", {
          voiceover: vo[3],
          // "I open Cloud. It brings an instance up for me on the spot, and in a few seco"
          action: async () => {
            // TODO: drive the app as the end user (ctx.clickText, ctx.fill, ...)
          },
          assert: async () => {
            // TODO: witness the side effect (ctx.expectText, ctx.eval, ...)
            ctx.assert(false, "frame 4 not implemented yet");
          },
          screenshot: { name: "frame-4", requireText: [] },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("TODO: claim for frame 5", {
          voiceover: vo[4],
          // "My organization's connections are already there. I ask what's on my calendar"
          action: async () => {
            // TODO: drive the app as the end user (ctx.clickText, ctx.fill, ...)
          },
          assert: async () => {
            // TODO: witness the side effect (ctx.expectText, ctx.eval, ...)
            ctx.assert(false, "frame 5 not implemented yet");
          },
          screenshot: { name: "frame-5", requireText: [] },
        });
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        await ctx.prove("TODO: claim for frame 6", {
          voiceover: vo[5],
          // "I ask it to save a summary to a file in my workspace, and the file appears."
          action: async () => {
            // TODO: drive the app as the end user (ctx.clickText, ctx.fill, ...)
          },
          assert: async () => {
            // TODO: witness the side effect (ctx.expectText, ctx.eval, ...)
            ctx.assert(false, "frame 6 not implemented yet");
          },
          screenshot: { name: "frame-6", requireText: [] },
        });
      },
    },
    {
      name: "Frame 7",
      run: async (ctx) => {
        await ctx.prove("TODO: claim for frame 7", {
          voiceover: vo[6],
          // "I close the tab and go do something else. The instance puts itself to sleep,"
          action: async () => {
            // TODO: drive the app as the end user (ctx.clickText, ctx.fill, ...)
          },
          assert: async () => {
            // TODO: witness the side effect (ctx.expectText, ctx.eval, ...)
            ctx.assert(false, "frame 7 not implemented yet");
          },
          screenshot: { name: "frame-7", requireText: [] },
        });
      },
    },
    {
      name: "Frame 8",
      run: async (ctx) => {
        await ctx.prove("TODO: claim for frame 8", {
          voiceover: vo[7],
          // "Later I open Cloud again. It wakes up, my summary file is still sitting in t"
          action: async () => {
            // TODO: drive the app as the end user (ctx.clickText, ctx.fill, ...)
          },
          assert: async () => {
            // TODO: witness the side effect (ctx.expectText, ctx.eval, ...)
            ctx.assert(false, "frame 8 not implemented yet");
          },
          screenshot: { name: "frame-8", requireText: [] },
        });
      },
    },
  ],
});
