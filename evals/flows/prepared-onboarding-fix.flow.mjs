import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/prepared-onboarding-fix.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("prepared-onboarding-fix");

let initialWorkspaceRequestCount = 0;

export default {
  id: "prepared-onboarding-fix",
  title: "Prepared onboarding has one stable next step",
  kind: "user-facing",
  steps: [
    {
      name: "Prepared workspace is concise",
      run: async (ctx) => {
        await ctx.prove("Setup complete shows the workspace without placeholder skills or suggested tasks", {
          voiceover: vo[0],
          action: async () => {
            await ctx.eval(`(() => {
              window.location.hash = "/session";
              window.location.reload();
              return true;
            })()`);
            await ctx.waitForText("Setup complete", { timeoutMs: 30_000 });
            initialWorkspaceRequestCount = await ctx.eval(`performance.getEntriesByType("resource").filter((entry) =>
              entry.name.includes("/sessions?limit=200") || entry.name.endsWith("/workspaces")
            ).length`);
            await ctx.eval("new Promise((resolve) => window.setTimeout(resolve, 1500))", { awaitPromise: true });
          },
          assert: async () => {
            await ctx.waitForText("Setup complete", { timeoutMs: 30_000 });
            await ctx.expectNoText("First skill ready");
            await ctx.expectNoText("Try asking");
            await ctx.expectNoText("Open your workspace and try a task");
            const route = await ctx.eval("window.__openworkControl.snapshot().route");
            ctx.assert(route === "/onboarding", `Expected /onboarding, got ${route}`);
            const requestCount = await ctx.eval(`performance.getEntriesByType("resource").filter((entry) =>
              entry.name.includes("/sessions?limit=200") || entry.name.endsWith("/workspaces")
            ).length`);
            ctx.assert(
              requestCount === initialWorkspaceRequestCount,
              `Workspace requests grew from ${initialWorkspaceRequestCount} to ${requestCount}`,
            );
          },
          screenshot: {
            name: "prepared-workspace-concise",
            requireText: ["Setup complete", "Claim workspace and continue"],
            rejectText: ["First skill ready", "Try asking", "Open your workspace and try a task"],
          },
        });
      },
    },
  ],
};
