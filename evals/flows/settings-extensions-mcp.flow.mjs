/**
 * The MCP settings view renders the custom-app entry point, the My Extensions /
 * Marketplace tabs, and — regression guard
 * for #2008 — the unconfigured quick-connect directory (Notion/Linear) so MCP
 * discovery works without a cloud sign-in. Built-in OpenWork MCPs are hidden by
 * default and revealed via Show hidden.
 */

const revealHidden = async (ctx) => {
  const showing = await ctx.eval("document.body.innerText.includes('Showing hidden')");
  if (!showing) await ctx.clickText("Show hidden", { timeoutMs: 30_000 });
};

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
        await ctx.expectHashIncludes("/settings/extensions/mcp");
      },
    },
    {
      name: "Extensions surface renders tabs and custom app entry",
      run: async (ctx) => {
        await ctx.expectText("My Extensions", { timeoutMs: 30_000 });
        await ctx.expectText("Marketplace");
        await ctx.expectText("Add Custom App");
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
      name: "Default view keeps directory apps discoverable and hides built-in OpenWork MCPs",
      run: async (ctx) => {
        const directoryEntry = await ctx.hasText("Notion") ? "Notion" : "Linear";
        const hasDirectoryEntry = await ctx.hasText(directoryEntry);
        ctx.assert(hasDirectoryEntry, "Expected at least one MCP directory entry (Notion/Linear) in quick connect.");
        await ctx.expectNoText("OpenWork Cloud Control");
        await ctx.expectNoText("OpenWork UI Control");
        await ctx.screenshot("mcp-view-default-hidden", {
          claim: "MCP settings shows public directory apps while built-in OpenWork MCPs are hidden by default.",
          voiceover: "Settings shows the extension directory with the public apps, while OpenWork's internal control entries stay out of the default list.",
          requireText: [directoryEntry],
          rejectText: ["OpenWork Cloud Control", "OpenWork UI Control", "Something went wrong"],
          hashIncludes: "/settings/extensions/mcp",
        });
      },
    },
    {
      name: "Show hidden reveals built-in OpenWork MCPs",
      run: async (ctx) => {
        await revealHidden(ctx);
        await ctx.expectText("OpenWork Cloud Control", { timeoutMs: 15_000 });
        await ctx.expectText("OpenWork UI Control", { timeoutMs: 15_000 });
        await ctx.screenshot("mcp-view-built-ins-revealed", {
          claim: "Show hidden reveals the built-in OpenWork MCP entries.",
          voiceover: "Choosing Show hidden brings back OpenWork Cloud Control and OpenWork UI Control for anyone who wants to manage them.",
          requireText: ["OpenWork Cloud Control", "OpenWork UI Control"],
          rejectText: ["Something went wrong"],
          hashIncludes: "/settings/extensions/mcp",
        });
      },
    },
  ],
};
