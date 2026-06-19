/**
 * The MCP settings view renders: connected built-in apps, the custom-app
 * entry point, the My Extensions / Marketplace tabs, and — regression guard
 * for #2008 — the unconfigured quick-connect directory (Notion, OpenWork
 * Cloud Control, ...) so MCP discovery works without a cloud sign-in.
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
      },
    },
    {
      name: "Unconfigured directory entries are discoverable",
      run: async (ctx) => {
        await ctx.waitForText("OpenWork Cloud Control", { timeoutMs: 15_000 });
        const hasDirectoryEntry = (await ctx.hasText("Notion")) || (await ctx.hasText("Linear"));
        ctx.assert(hasDirectoryEntry, "Expected at least one MCP directory entry (Notion/Linear) in quick connect.");
        await ctx.screenshot("mcp-view");
      },
    },
  ],
};
