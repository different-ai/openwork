/**
 * Built-in Micx MCPs stay out of the default Extensions list but remain
 * available behind Show hidden for inspection, disable, or removal.
 */

const revealHidden = async (ctx) => {
  const showing = await ctx.eval("document.body.innerText.includes('Showing hidden')");
  if (!showing) await ctx.clickText("Show hidden", { timeoutMs: 30_000 });
};

export default {
  id: "builtin-mcps-hidden-by-default",
  title: "Built-in Micx MCPs are hidden by default and revealed by Show hidden",
  spec: "evals/browser-extension-flows.md",
  kind: "user-facing",
  steps: [
    {
      name: "App booted",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__micxControl)", { timeoutMs: 60_000 });
      },
    },
    {
      name: "Navigate to Settings → Extensions → MCP",
      run: async (ctx) => {
        await ctx.navigateHash("/settings/extensions/mcp");
        await ctx.expectHashIncludes("/settings/extensions/mcp");
        await ctx.waitForText("Add Custom App", { timeoutMs: 30_000 });
        await ctx.waitFor(
          "document.body.innerText.toLowerCase().includes('available apps')",
          { timeoutMs: 30_000, label: "available apps section" },
        );
      },
    },
    {
      name: "Built-in Micx MCPs are hidden by default",
      run: async (ctx) => {
        const directoryEntry = await ctx.hasText("Notion") ? "Notion" : "Linear";
        await ctx.prove("Built-in Micx MCPs are hidden from the default extensions list", {
          voiceover: "The regular MCP directory still renders in Settings, but Micx's internal control entries are not listed by default.",
          assert: async () => {
            ctx.assert(await ctx.hasText(directoryEntry), "Expected Notion or Linear to prove the catalog rendered.");
            await ctx.expectNoText("Micx Cloud Control");
            await ctx.expectNoText("Micx UI Control");
            const hasHiddenCount = await ctx.eval("document.body.innerText.includes('Show hidden (')");
            ctx.assert(hasHiddenCount, "Expected Show hidden to advertise a hidden count.");
          },
          screenshot: {
            name: "builtin-mcps-hidden-default",
            claim: "Micx Cloud Control and Micx UI Control are hidden from the default extensions list while the rest of the catalog renders.",
            requireText: ["Show hidden", directoryEntry],
            rejectText: ["Micx Cloud Control", "Micx UI Control", "Something went wrong"],
            hashIncludes: "/settings/extensions/mcp",
          },
        });
      },
    },
    {
      name: "Show hidden reveals both entries",
      run: async (ctx) => {
        await ctx.prove("Show hidden reveals both built-in Micx MCP entries", {
          voiceover: "When the user asks to show hidden extensions, both built-in Micx MCP controls appear for inspection or management.",
          action: async () => {
            await revealHidden(ctx);
          },
          assert: async () => {
            await ctx.expectText("Micx Cloud Control", { timeoutMs: 30_000 });
            await ctx.expectText("Micx UI Control", { timeoutMs: 30_000 });
            await ctx.waitFor("document.body.innerText.includes('Showing hidden')", {
              timeoutMs: 10_000,
              label: "hidden entries revealed",
            });
            await ctx.eval(`(() => {
              const buttons = [...document.querySelectorAll("button")];
              const card = buttons.find((el) => (el.textContent ?? "").includes("Micx UI Control"));
              card?.scrollIntoView({ block: "center" });
              return Boolean(card);
            })()`);
          },
          screenshot: {
            name: "builtin-mcps-revealed",
            claim: "Show hidden reveals Micx Cloud Control and Micx UI Control with hidden styling.",
            requireText: ["Micx Cloud Control", "Micx UI Control", "Showing hidden"],
            rejectText: ["Something went wrong"],
            hashIncludes: "/settings/extensions/mcp",
          },
        });
      },
    },
  ],
};
