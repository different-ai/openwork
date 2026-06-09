/**
 * The MCP settings view renders: connected built-in apps, the custom-app
 * entry point, and the My Extensions / Marketplace tabs.
 *
 * Note: as of #2008 the quick-connect *directory* (Notion, Linear, OpenWork
 * Cloud Control, ...) only lists configured entries here; discovery moved to
 * the Marketplace tab. Cloud MCP discoverability assertions will be added to
 * this flow when the cloud MCP becomes first-class.
 */
export default {
  id: "settings-extensions-mcp",
  title: "MCP settings view renders apps and entry points",
  spec: "evals/browser-extension-flows.md",
  steps: [
    {
      name: "App booted",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 30_000 });
      },
    },
    {
      name: "Navigate to Settings -> Extensions -> MCP",
      run: async (ctx) => {
        await ctx.navigateHash("/settings/extensions/mcp");
        await ctx.waitFor(
          "window.location.hash.includes('/settings/extensions/mcp')",
          { label: "settings MCP route" },
        );
      },
    },
    {
      name: "Extensions surface renders tabs and custom app entry",
      run: async (ctx) => {
        await ctx.waitForText("My Extensions", { timeoutMs: 30_000 });
        await ctx.waitForText("Marketplace");
        await ctx.waitForText("Add Custom App");
      },
    },
    {
      name: "Available apps section renders",
      run: async (ctx) => {
        // CSS text-transform can change innerText casing; compare lowercased.
        await ctx.waitFor(
          "document.body.innerText.toLowerCase().includes('available apps')",
          { timeoutMs: 15_000, label: "available apps section" },
        );
        await ctx.screenshot("mcp-view");
      },
    },
  ],
};
