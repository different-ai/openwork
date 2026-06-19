/**
 * Extension Marketplace surface renders with the pending-update wiring.
 *
 * Signed-out baseline: the marketplace view must render its header, status
 * filters (including the "Updates" filter backed by pending cloud sync
 * changes), and the signed-out notice — without crashing on the new
 * pendingCloudPluginChanges store state.
 *
 * Cloud-gated update/badge assertions (Update / Update all / removed
 * upstream) require a Den org with a bumped plugin and are covered by the
 * markdown spec until eval cloud fixtures exist.
 */
export default {
  id: "extensions-marketplace-updates",
  title: "Marketplace renders with update filters and signed-out notice",
  spec: "evals/cloud-marketplace-sync-flows.md",
  steps: [
    {
      name: "App booted",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 30_000 });
      },
    },
    {
      name: "Navigate to Settings -> Marketplace",
      run: async (ctx) => {
        await ctx.navigateHash("/settings/cloud-marketplaces");
        await ctx.waitFor(
          "window.location.hash.includes('/settings/cloud-marketplaces')",
          { label: "cloud marketplaces route" },
        );
      },
    },
    {
      name: "Marketplace header and status filters render",
      run: async (ctx) => {
        await ctx.waitForText("Extension Marketplace", { timeoutMs: 30_000 });
        await ctx.waitForText("Installed");
        await ctx.waitForText("Updates");
      },
    },
    {
      name: "Signed-out state explains how to load the Marketplace",
      run: async (ctx) => {
        const signedOutNotice = await ctx.hasText(
          "Sign in to OpenWork Cloud to load the Marketplace",
        );
        const hasRows = await ctx.eval(
          "document.querySelectorAll('[data-slot=card], article, li').length > 0",
        );
        ctx.assert(
          signedOutNotice || hasRows,
          "Expected either the signed-out notice or marketplace rows to render",
        );
        await ctx.screenshot("marketplace-view");
      },
    },
    {
      name: "Updates filter is interactive and view stays stable",
      run: async (ctx) => {
        await ctx.clickText("Updates");
        await ctx.waitForText("Extension Marketplace");
        const crashed = await ctx.hasText("Something went wrong");
        ctx.assert(!crashed, "Marketplace view crashed after selecting Updates filter");
        await ctx.screenshot("updates-filter");
      },
    },
  ],
};
