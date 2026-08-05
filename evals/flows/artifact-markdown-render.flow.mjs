/**
 * Markdown artifacts render inline (merged view): opening a `.md` artifact shows
 * a live-preview CodeMirror editor where the markdown is *rendered* (headings
 * styled, `#` markers hidden) while still being fully editable as source.
 */
export default {
  id: "artifact-markdown-render",
  title: "Markdown artifacts render inline in an editable merged view",
  spec: "evals/react-session-flows.md",
  steps: [
    {
      name: "App is ready and Electron-backed",
      run: async (ctx) => {
        await ctx.prove("App boots to a session surface with the control API", {
          action: async () => {
            await ctx.waitFor("Boolean(window.__micxControl)", {
              timeoutMs: 60_000,
              label: "control API",
            });
          },
          assert: async () => {
            const userAgent = await ctx.eval("navigator.userAgent");
            ctx.assert(userAgent.includes("Electron/"), `Expected Electron userAgent, got ${userAgent}`);
          },
          screenshot: { name: "booted" },
        });
      },
    },
    {
      name: "Open a session and mount the artifact side panel",
      run: async (ctx) => {
        await ctx.prove("A session is active and the artifact seed action is available", {
          action: async () => {
            const hasSelectedSession = await ctx.eval(`window.__micxControl.snapshot().route.includes("/session/")`);
            if (!hasSelectedSession) {
              await ctx.control("session.create_task");
              await ctx.waitFor(
                `window.__micxControl.snapshot().route.includes("/session/")`,
                { timeoutMs: 60_000, label: "session route after task creation" },
              );
            }
            // Mount the side panel (which registers the seed action) only if it
            // is not already open — clicking "Browser" toggles the panel.
            await ctx.eval(`(() => {
              const seedReady = window.__micxControl.listActions()
                .some((a) => a.id === "eval.artifact_tabs.seed_overflow" && !a.disabled);
              if (seedReady) return "already-open";
              const button = Array.from(document.querySelectorAll("button"))
                .find((item) => item.getAttribute("aria-label") === "Browser" && !item.disabled);
              button?.click();
              return button ? "clicked" : "no-button";
            })()`);
          },
          assert: async () => {
            await ctx.waitFor(
              `window.__micxControl.listActions().some((a) => a.id === "eval.artifact_tabs.seed_overflow" && !a.disabled)`,
              { timeoutMs: 30_000, label: "artifact seed action enabled" },
            );
          },
        });
      },
    },
    {
      name: "Open a markdown artifact and confirm it renders inline",
      run: async (ctx) => {
        await ctx.prove("A markdown artifact opens in an editable, rendered merged view", {
          action: async () => {
            // Seed writes real markdown files ("# Overflow tab NN") and opens them
            // as artifact tabs with preview: "markdown".
            await ctx.control("eval.artifact_tabs.seed_overflow", { count: 12 });
            // Make sure an artifact tab is the *active* panel view (the panel may
            // still be showing a browser tab), then wait for the editor.
            await ctx.waitFor(
              `document.querySelectorAll('button[aria-label^="Select tab: overflow-tab"]').length >= 12`,
              { timeoutMs: 30_000, label: "seeded artifact tabs present" },
            );
            await ctx.eval(`(() => {
              const tabs = Array.from(document.querySelectorAll('button[aria-label^="Select tab: overflow-tab"]'));
              const last = tabs[tabs.length - 1];
              last?.click();
              return Boolean(last);
            })()`);
            await ctx.waitFor(
              `(() => {
                const cm = document.querySelector(".cm-editor .cm-content");
                return Boolean(cm) && /Overflow tab/.test(cm.textContent || "");
              })()`,
              { timeoutMs: 30_000, label: "markdown CodeMirror editor mounted with content" },
            );
          },
          assert: async () => {
            const result = await ctx.eval(`(() => {
              const content = document.querySelector(".cm-editor .cm-content");
              if (!content) return { ok: false, reason: "no cm-content" };
              // Live-preview heading decoration must be applied to the heading text.
              const h1 = content.querySelector(".cm-md-h1");
              const headingFontSize = h1 ? parseFloat(getComputedStyle(h1).fontSize) : 0;
              const bodyFontSize = parseFloat(getComputedStyle(content).fontSize) || 14;
              // The literal "#" HeaderMark should be hidden (not visible as text)
              // on the rendered heading line when it is not being edited.
              const text = content.textContent || "";
              const hasRenderedHeadingNode = Boolean(h1) && /Overflow tab/.test(h1.textContent || "");
              return {
                ok: true,
                hasRenderedHeadingNode,
                headingFontSize,
                bodyFontSize,
                headingLargerThanBody: headingFontSize > bodyFontSize,
                rawText: text.slice(0, 80),
              };
            })()`);
            ctx.assert(result.ok, result.reason || "Markdown editor not found.");
            ctx.assert(
              result.hasRenderedHeadingNode,
              "Heading text was not wrapped in a live-preview heading decoration (.cm-md-h1).",
            );
            ctx.assert(
              result.headingLargerThanBody,
              `Rendered heading not visually larger than body (heading=${result.headingFontSize}px, body=${result.bodyFontSize}px).`,
            );
            ctx.log(`heading=${result.headingFontSize}px body=${result.bodyFontSize}px`);
          },
          screenshot: { name: "markdown-rendered-inline" },
        });
      },
    },
    {
      name: "Markdown source markers hide off the active line",
      run: async (ctx) => {
        await ctx.prove("The literal '#' marker is hidden on heading lines that are not being edited", {
          action: async () => {
            // Move the editor selection off the heading line (line 1) to the end
            // of the document via the CodeMirror view API so the `#` HeaderMark on
            // line 1 is replaced/hidden. A raw DOM selection would not update CM's
            // internal selection model, so we reach the EditorView on the node.
            const moved = await ctx.eval(`(() => {
              const view = window.__artifactEditorView;
              if (!view || !view.dispatch) return "no-view";
              const end = view.state.doc.length;
              view.dispatch({ selection: { anchor: end, head: end } });
              view.focus();
              return "ok";
            })()`);
            ctx.assert(moved === "ok", `Could not move selection off the heading line: ${moved}`);
            await ctx.waitFor(
              `(() => {
                const firstLine = document.querySelector(".cm-editor .cm-content .cm-line");
                const text = firstLine ? (firstLine.textContent || "").trim() : "";
                return text.length > 0 && !text.startsWith("#");
              })()`,
              { timeoutMs: 5_000, label: "heading line marker hidden" },
            );
          },
          assert: async () => {
            const result = await ctx.eval(`(() => {
              const content = document.querySelector(".cm-editor .cm-content");
              if (!content) return { ok: false, reason: "no cm-content" };
              const firstLine = content.querySelector(".cm-line");
              const lineText = firstLine ? (firstLine.textContent || "").trim() : "";
              const h1 = content.querySelector(".cm-md-h1");
              return {
                ok: true,
                lineText,
                markerHidden: !lineText.startsWith("#") && lineText.includes("Overflow tab"),
                stillRendered: Boolean(h1),
              };
            })()`);
            ctx.assert(result.ok, result.reason || "Markdown editor not found.");
            ctx.assert(
              result.markerHidden,
              `Heading line still shows the literal '#' marker: "${result.lineText}".`,
            );
            ctx.assert(result.stillRendered, "Heading lost its rendered styling after moving selection.");
            ctx.log(`heading line now reads: "${result.lineText}"`);
          },
          screenshot: { name: "markdown-markers-hidden" },
        });
      },
    },
  ],
};
