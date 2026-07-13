import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/packaged-suggestion-icon.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("packaged-suggestion-icon");

export default {
  id: "packaged-suggestion-icon",
  title: "Suggestion card icon loads in a packaged Electron build under file://",
  kind: "user-facing",
  preserveTheme: true,
  steps: [
    {
      name: "Frame 1 — suggestion cards visible with a loaded icon on Browse the web",
      run: async (ctx) => {
        await ctx.prove("The session empty state shows all three suggestion cards, and the Browse the web icon loaded with non-zero natural dimensions under file://", {
          voiceover: vo[0],
          action: async () => {
            await ctx.waitForText("Browse the web", { timeoutMs: 30_000 });
            await ctx.waitFor(`(() => {
              const buttons = Array.from(document.querySelectorAll("button"));
              const browseBtn = buttons.find((b) => (b.textContent || "").includes("Browse the web"));
              if (!browseBtn) return false;
              const img = browseBtn.querySelector("img");
              return Boolean(img && img.complete && img.naturalWidth > 0);
            })()`, { timeoutMs: 30_000, label: "Browse the web icon image loaded under file://" });
          },
          assert: async () => {
            await ctx.expectText("Edit a CSV");
            await ctx.expectText("Browse the web");
            await ctx.expectText("Connect an extension");
            const result = await ctx.eval(`(() => {
              const buttons = Array.from(document.querySelectorAll("button"));
              const browseBtn = buttons.find((b) => (b.textContent || "").includes("Browse the web"));
              if (!browseBtn) return { found: false };
              const img = browseBtn.querySelector("img");
              if (!img) return { found: true, hasImg: false };
              return {
                found: true,
                hasImg: true,
                src: img.getAttribute("src"),
                complete: img.complete,
                naturalWidth: img.naturalWidth,
                naturalHeight: img.naturalHeight,
                pageProtocol: location.protocol,
              };
            })()`);
            ctx.assert(result.found, "Browse the web button not found.");
            ctx.assert(result.hasImg, "Browse the web button has no img element.");
            ctx.assert(result.complete, "Browse the web icon image did not finish loading.");
            ctx.assert(result.naturalWidth > 0, `Browse the web icon naturalWidth is ${result.naturalWidth}, expected > 0.`);
            ctx.assert(result.pageProtocol === "file:", `Expected file:// protocol but got ${result.pageProtocol}`);
          },
          screenshot: {
            name: "suggestion-cards-icon-loaded",
            requireText: ["Edit a CSV", "Browse the web", "Connect an extension"],
          },
        });
      },
    },
    {
      name: "Frame 2 — icon src is a rebased relative path, not a bare absolute path",
      run: async (ctx) => {
        await ctx.prove("The Browse the web icon src is a relative path rebased by resolveExtensionIconSrc, not a bare absolute /openwork-mark.svg", {
          voiceover: vo[1],
          action: async () => {
            const result = await ctx.eval(`(() => {
              const buttons = Array.from(document.querySelectorAll("button"));
              const browseBtn = buttons.find((b) => (b.textContent || "").includes("Browse the web"));
              if (!browseBtn) return { found: false };
              const img = browseBtn.querySelector("img");
              return {
                found: true,
                src: img ? img.getAttribute("src") : null,
                currentSrc: img ? img.currentSrc : null,
              };
            })()`);
            ctx.output("icon-src", JSON.stringify(result, null, 2));
          },
          assert: async () => {
            const result = await ctx.eval(`(() => {
              const buttons = Array.from(document.querySelectorAll("button"));
              const browseBtn = buttons.find((b) => (b.textContent || "").includes("Browse the web"));
              if (!browseBtn) return { found: false };
              const img = browseBtn.querySelector("img");
              return {
                found: true,
                src: img ? img.getAttribute("src") : null,
              };
            })()`);
            ctx.assert(result.found, "Browse the web button not found.");
            ctx.assert(result.src !== null, "Browse the web img has no src attribute.");
            ctx.assert(!result.src.startsWith("/openwork-mark"), `Icon src is absolute "${result.src}" — should be rebased to relative.`);
            ctx.assert(result.src.includes("openwork-mark.svg"), `Icon src "${result.src}" does not reference openwork-mark.svg.`);
          },
        });
      },
    },
  ],
};
