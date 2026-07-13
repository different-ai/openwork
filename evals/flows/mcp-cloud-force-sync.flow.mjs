/**
 * The Extensions page Refresh button force-syncs the OpenWork Cloud Control
 * connection: re-mints the member's token and rewrites the MCP config NOW,
 * bypassing the freshness marker — one click instead of sign-out/sign-in or
 * waiting for the marker to expire.
 *
 * Proof: the `openwork.den.mcp.sync` marker (written only when a sync
 * actually re-minted + reconnected) changes after clicking Refresh even
 * though it was still fresh — previously Refresh never touched it.
 *
 * Prerequisites: a desktop app (this worktree) signed in to OpenWork Cloud
 * with an active org and a workspace open — the state mcp-connections-
 * desktop-e2e.flow.mjs ends in. Fails fast with a clear message otherwise.
 */

const revealHidden = async (ctx) => {
  const showing = await ctx.eval("document.body.innerText.includes('Showing hidden')");
  if (!showing) await ctx.clickText("Show hidden", { timeoutMs: 30_000 });
};

export default {
  id: "mcp-cloud-force-sync",
  title: "Refresh force-syncs the cloud MCP (marker bypassed, token re-minted)",
  spec: "evals/cloud-mcp-agent-flows.md",
  steps: [
    {
      name: "App booted and signed in with a fresh sync marker",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000 });
        const signedIn = await ctx.eval("Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())");
        ctx.assert(signedIn, "Desktop app must be signed in to OpenWork Cloud (run mcp-connections-desktop-e2e first).");
        const marker = await ctx.eval("localStorage.getItem('openwork.den.mcp.sync')");
        ctx.assert(Boolean(marker), "No sync marker present — cloud MCP was never configured.");
        ctx.log(`marker before: ${marker}`);
      },
    },
    {
      name: "Clicking Refresh force-runs the cloud sync despite the fresh marker",
      run: async (ctx) => {
        const workspaceId = await ctx.eval("(window.location.hash.match(/\\/workspace\\/([^/]+)/) ?? [])[1] ?? null");
        const settingsPath = workspaceId ? `/workspace/${workspaceId}/settings/extensions/mcp` : "/settings/extensions/mcp";
        await ctx.navigateHash(settingsPath);
        await ctx.waitForText("Add Custom App", { timeoutMs: 30_000 });
        await revealHidden(ctx);
        // Let the on-mount auto-sync fully settle first (it may legitimately
        // re-sync if the marker aged past the refresh margin). THEN take the
        // baseline: at this point the marker is maximally fresh, so without
        // `force` nothing would rewrite it — any change after the click is
        // attributable to the Refresh button alone.
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        const before = await ctx.eval("localStorage.getItem('openwork.den.mcp.sync')");
        ctx.assert(Boolean(before), "No marker after mount settle.");

        await ctx.prove("Refresh re-mints and rewrites the cloud MCP config immediately", {
          action: async () => {
            await ctx.clickText("Refresh", { timeoutMs: 15_000 });
          },
          assert: async () => {
            await ctx.waitFor(
              `localStorage.getItem('openwork.den.mcp.sync') !== ${JSON.stringify(before)}`,
              { timeoutMs: 30_000, label: "sync marker rewritten by Refresh" },
            );
            ctx.log(`marker after: ${await ctx.eval("localStorage.getItem('openwork.den.mcp.sync')")}`);
            await ctx.expectText("OpenWork Cloud Control");
            await ctx.expectNoText("Something went wrong");
          },
          screenshot: {
            name: "force-sync-refreshed",
            claim: "After one Refresh click, the cloud MCP sync marker was rewritten — token re-minted and config re-synced on demand.",
            requireText: ["OpenWork Cloud Control"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
  ],
};
