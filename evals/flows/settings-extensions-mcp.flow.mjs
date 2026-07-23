/**
 * The unified Extensions settings view renders the custom-app entry point,
 * skill count, and — regression guard for #2008 — the unconfigured
 * quick-connect directory (Notion/Linear) so MCP discovery works without a
 * cloud sign-in. Inactive built-in OpenWork MCPs are hidden by default and
 * revealed via Show hidden.
 */

const revealHidden = async (ctx) => {
  const showing = await ctx.eval("document.body.innerText.includes('Showing hidden')");
  if (!showing) await ctx.clickText("Show hidden", { timeoutMs: 30_000 });
};

const hideHidden = async (ctx) => {
  const showing = await ctx.eval("document.body.innerText.includes('Showing hidden')");
  if (showing) await ctx.clickText("Showing hidden", { timeoutMs: 30_000 });
};

export default {
  id: "settings-extensions-mcp",
  title: "Extensions settings renders the unified skills and MCP inventory",
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
        await hideHidden(ctx);
      },
    },
    {
      name: "Extensions surface renders one inventory and the custom app entry",
      run: async (ctx) => {
        await ctx.expectText("Everything your agent can use", { timeoutMs: 30_000 });
        await ctx.expectText("Add Custom App");
        const legacyTabs = await ctx.eval(`Array.from(document.querySelectorAll("button"))
          .map((button) => button.innerText.trim())
          .filter((label) => label === "My Extensions" || label === "Marketplace")`);
        ctx.assert(
          legacyTabs.length === 0,
          `Legacy extension tabs are still visible: ${legacyTabs.join(", ")}`,
        );
      },
    },
    {
      name: "Available inventory shows the total skill count",
      run: async (ctx) => {
        // CSS text-transform can change innerText casing; compare lowercased.
        await ctx.waitFor(
          "document.body.innerText.toLowerCase().includes('available apps')",
          { timeoutMs: 15_000, label: "available apps section" },
        );
        const inventoryHeading = await ctx.eval(`(() => {
          const heading = Array.from(document.querySelectorAll("h3"))
            .find((node) => node.innerText.toLowerCase().includes("available apps"));
          return heading?.parentElement?.innerText ?? "";
        })()`);
        ctx.assert(
          /\b\d+\s+skills?\b/i.test(inventoryHeading),
          `Expected a numeric skill count beside the inventory heading, got: ${inventoryHeading}`,
        );
      },
    },
    {
      name: "Default view keeps directory apps discoverable and hides inactive built-in OpenWork MCPs",
      run: async (ctx) => {
        const directoryEntry = await ctx.hasText("Notion") ? "Notion" : "Linear";
        const hasDirectoryEntry = await ctx.hasText(directoryEntry);
        ctx.assert(hasDirectoryEntry, "Expected at least one MCP directory entry (Notion/Linear) in quick connect.");
        await ctx.expectNoText("OpenWork UI Control");
        await ctx.screenshot("mcp-view-default-hidden", {
          claim: "Extensions shows public directory apps while inactive built-in OpenWork MCPs are hidden by default.",
          voiceover: "Settings shows the extension directory with public apps while inactive internal control entries stay out of the default list.",
          requireText: [directoryEntry],
          rejectText: ["OpenWork UI Control", "Something went wrong"],
          hashIncludes: "/settings/extensions/mcp",
        });
      },
    },
    {
      name: "Show hidden reveals built-in OpenWork MCPs",
      run: async (ctx) => {
        await revealHidden(ctx);
        await ctx.expectText("OpenWork UI Control", { timeoutMs: 15_000 });
        await ctx.screenshot("mcp-view-built-ins-revealed", {
          claim: "Show hidden reveals inactive built-in OpenWork MCP entries.",
          voiceover: "Choosing Show hidden brings back OpenWork UI Control for anyone who wants to manage it.",
          requireText: ["OpenWork UI Control"],
          rejectText: ["Something went wrong"],
          hashIncludes: "/settings/extensions/mcp",
        });
      },
    },
  ],
};
