import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "mcp-diagnostics-proof-app";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
const PROOF_URL = process.env.MCP_DIAGNOSTICS_PROOF_URL?.trim() || "http://127.0.0.1:3334";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function record(ctx, assertion, actual) {
  ctx.assert(Boolean(actual), assertion);
  ctx.recordEvidence({ type: "assertion", status: "passed", assertion, actual });
}

async function setViewport(ctx, width, height = 900) {
  await ctx.client?.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function navigate(ctx, chapter) {
  await ctx.eval(`(() => { window.location.href = ${JSON.stringify(`${PROOF_URL}#${chapter}`)}; return true; })()`);
  await ctx.waitFor(
    `document.querySelector('[data-testid="current-proof-chapter"]')?.dataset.chapterId === ${JSON.stringify(chapter)}`,
    { timeoutMs: 20_000, label: `${chapter} proof chapter` },
  );
}

export default {
  id: FLOW_ID,
  title: "Review the MCP diagnostics rehearsal through its manager proof viewer",
  kind: "user-facing",
  spec: "evals/voiceovers/mcp-diagnostics-proof-app.md",
  preserveTheme: true,
  steps: [
    {
      name: "The viewer leads with evidence and release boundaries",
      run: async (ctx) => {
        await ctx.prove("The proof opens with an explicit pass, approval, and integration boundary", {
          voiceover: vo[0],
          action: async () => {
            await setViewport(ctx, 1440);
            await navigate(ctx, "setup");
            await ctx.eval("window.scrollTo({ top: 0, behavior: 'instant' }); true");
          },
          assert: async () => {
            await ctx.expectText("Agent verified");
            await ctx.expectText("Passed");
            await ctx.expectText("Jalil verification");
            await ctx.expectText("Not started");
            await ctx.expectText("Controlled parent");
            await ctx.expectText("None integrated");
            await ctx.expectText("8 operational chapters · 9 evidence frames");
          },
          screenshot: {
            name: "proof-viewer-release-boundary",
            claim: "The viewer distinguishes agent evidence from Jalil approval and parent integration before the tour begins.",
            requireText: ["Agent verified", "Jalil verification", "None integrated", "Evidence, not approval"],
          },
        });
      },
    },
    {
      name: "All chapters and evidence frames are reachable",
      run: async (ctx) => {
        await ctx.prove("The OAuth chapter explains callback and Connected as separate evidence frames", {
          voiceover: vo[1],
          action: async () => {
            const chapterIds = [
              "setup",
              "network-failure",
              "enterprise-oauth",
              "catalog-test",
              "version-fault",
              "catalog-repaired",
              "provider-denial",
              "cleanup",
            ];
            let imageCount = 0;
            for (const id of chapterIds) {
              await navigate(ctx, id);
              await ctx.waitFor(
                "[...document.querySelectorAll('[data-evidence-asset]')].every((image) => image.complete && image.naturalWidth > 0)",
                { timeoutMs: 10_000, label: `${id} evidence images` },
              );
              imageCount += await ctx.eval("document.querySelectorAll('[data-evidence-asset]').length");
            }
            record(ctx, "All eight hash-addressable chapters render nine loaded evidence images.", imageCount === 9 ? imageCount : null);
            await navigate(ctx, "enterprise-oauth");
            await ctx.eval("document.querySelector('#proof-chapter')?.scrollIntoView({ block: 'start', behavior: 'instant' }); true");
          },
          assert: async () => {
            await ctx.expectText("Complete realistic pre-registered confidential OAuth");
            const frameCount = await ctx.eval("document.querySelectorAll('[data-testid=\"evidence-frame\"]').length");
            record(ctx, "The OAuth chapter contains separate callback and Connected frames.", frameCount === 2 ? frameCount : null);
          },
          screenshot: {
            name: "proof-viewer-oauth-two-frame-story",
            claim: "The manager can review the exact callback and durable Connected outcome as distinct checkpoints.",
            requireText: ["exact callback", "validated connection becomes durable"],
          },
        });
      },
    },
    {
      name: "Step 6 keeps screenshot and API evidence honest",
      run: async (ctx) => {
        await ctx.prove("The provider denial chapter says exactly which evidence proves each outcome", {
          voiceover: vo[2],
          action: async () => {
            await navigate(ctx, "provider-denial");
            await ctx.trustedClick('[data-testid="skip-to-proof-chapter"]');
            record(
              ctx,
              "The skip control focuses the current chapter without changing its hash or resetting the story.",
              await ctx.eval("window.location.hash === '#provider-denial' && document.activeElement === document.querySelector('#proof-chapter h2')"),
            );
            await ctx.eval("window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }); true");
            await sleep(150);
            await ctx.eval("document.querySelector('[data-testid=\"provider-denial-api-evidence\"]')?.scrollIntoView({ block: 'center', behavior: 'instant' }); true");
            await sleep(500);
          },
          assert: async () => {
            await ctx.expectText("AUTHORITATIVE API EVIDENCE");
            await ctx.expectText("The screenshot shows that connection and catalog health stayed healthy");
            await ctx.expectText("category: provider_policy_denied");
            await ctx.expectText("phase: PROVIDER_AUTHORIZATION");
            await ctx.expectText("action owner: provider_admin");
          },
          screenshot: {
            name: "proof-viewer-provider-denial-boundary",
            claim: "The screenshot witnesses retained health while adjacent API assertions witness the operation denial.",
            requireText: ["AUTHORITATIVE API EVIDENCE", "provider_policy_denied", "PROVIDER_AUTHORIZATION", "provider_admin"],
          },
        });
      },
    },
    {
      name: "Keyboard navigation reaches cleanup on a narrow screen",
      run: async (ctx) => {
        await ctx.prove("The tour remains usable at a narrow review width and finishes on cleanup", {
          voiceover: vo[3],
          action: async () => {
            await setViewport(ctx, 390, 844);
            await navigate(ctx, "provider-denial");
            await ctx.eval("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })); true");
            await ctx.waitFor("window.location.hash === '#cleanup'", { timeoutMs: 5_000, label: "ArrowRight cleanup navigation" });
            const viewportState = await ctx.eval("({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth })");
            record(
              ctx,
              "The 390px review layout has no horizontal document overflow.",
              viewportState.clientWidth === 390 && viewportState.scrollWidth <= viewportState.clientWidth ? viewportState : null,
            );
            await ctx.eval("document.querySelector('[data-testid=\"evidence-frame\"]')?.scrollIntoView({ block: 'center', behavior: 'instant' }); true");
          },
          assert: async () => {
            await ctx.expectText("Leave no connection, credential, runner, or diagnostic orphan");
            await ctx.expectText("Both synthetic connection deletes succeed and their names are absent after refresh.");
            const current = await ctx.eval("document.querySelector('[data-testid=\"current-proof-chapter\"]')?.dataset.chapterId");
            record(ctx, "ArrowRight updates the hash-addressable chapter to cleanup.", current === "cleanup" ? current : null);
          },
          screenshot: {
            name: "proof-viewer-narrow-cleanup",
            claim: "The responsive tour reaches a clean final state through keyboard navigation.",
            requireText: ["The post-cleanup administration surface", "Connections administration", "Post-cleanup landing view"],
            hashIncludes: "#cleanup",
          },
        });
      },
    },
  ],
};
