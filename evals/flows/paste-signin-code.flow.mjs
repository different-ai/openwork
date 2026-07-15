import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/paste-signin-code.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("paste-signin-code");

export default {
  id: "paste-signin-code",
  title: "A prepared development build can sign in with a copied one-time code",
  kind: "user-facing",
  requiredEnv: ["OPENWORK_EVAL_HANDOFF_GRANT"],
  steps: [
    {
      name: "Reveal the paste-code path",
      run: async (ctx) => {
        await ctx.prove("The prepared workspace offers an explicit paste-code sign-in path", {
          voiceover: vo[0],
          action: async () => {
            await ctx.clickText("Paste sign-in code");
          },
          assert: async () => {
            await ctx.waitFor(
              "Boolean(document.querySelector('input[aria-label=\"One-time sign-in code\"]'))",
              { label: "one-time sign-in code input" },
            );
            await ctx.expectText("Sign in to this workspace");
          },
          screenshot: {
            name: "paste-code-ready",
            claim: "Demo A shows the one-time sign-in code field.",
            requireText: ["Sign in to this workspace"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Exchange the code and sign in",
      run: async (ctx) => {
        await ctx.prove("The one-time code signs Demo A into the claimed workspace", {
          voiceover: vo[1],
          action: async () => {
            await ctx.fill('input[aria-label="One-time sign-in code"]', ctx.env.OPENWORK_EVAL_HANDOFF_GRANT);
            await ctx.clickText("Sign in to this workspace");
          },
          assert: async () => {
            await ctx.waitFor(
              "Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())",
              { timeoutMs: 90_000, label: "persisted Den authentication token after workspace initialization" },
            );
            await ctx.expectNoText("Paste sign-in code");
          },
          screenshot: {
            name: "signed-in-owner",
            claim: "Demo A has exchanged the one-time code and is signed in.",
            rejectText: ["Paste sign-in code", "Something went wrong"],
          },
        });
      },
    },
  ],
};
