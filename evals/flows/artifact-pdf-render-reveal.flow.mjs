/**
 * PDF artifacts render inline and "Show in folder" works.
 *
 * 1. Seed a real one-page PDF into the workspace and open it as an artifact tab.
 * 2. Confirm the PDF actually renders inline (Chromium's built-in viewer inside
 *    an <object>/<iframe> pointed at a blob URL — not a blank frame).
 * 3. Click "Show in folder" and confirm the reveal completes without surfacing
 *    an error toast (the file exists on disk, so the reveal resolves cleanly).
 */
export default {
  id: "artifact-pdf-render-reveal",
  title: "PDF artifacts render inline and Show in folder works",
  spec: "evals/react-session-flows.md",
  steps: [
    {
      name: "App is ready and Electron-backed",
      run: async (ctx) => {
        await ctx.prove("App boots to a session surface with the control API", {
          action: async () => {
            await ctx.waitFor("Boolean(window.__openworkControl)", {
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
        await ctx.prove("A session is active and the PDF seed action is available", {
          action: async () => {
            const hasSelectedSession = await ctx.eval(`window.__openworkControl.snapshot().route.includes("/session/")`);
            if (!hasSelectedSession) {
              await ctx.control("session.create_task");
              await ctx.waitFor(
                `window.__openworkControl.snapshot().route.includes("/session/")`,
                { timeoutMs: 60_000, label: "session route after task creation" },
              );
            }
            // Mount the side panel (registers the seed action) only if not open.
            await ctx.eval(`(() => {
              const seedReady = window.__openworkControl.listActions()
                .some((a) => a.id === "eval.artifact_tabs.seed_pdf" && !a.disabled);
              if (seedReady) return "already-open";
              const button = Array.from(document.querySelectorAll("button"))
                .find((item) => item.getAttribute("aria-label") === "Browser" && !item.disabled);
              button?.click();
              return button ? "clicked" : "no-button";
            })()`);
          },
          assert: async () => {
            await ctx.waitFor(
              `window.__openworkControl.listActions().some((a) => a.id === "eval.artifact_tabs.seed_pdf" && !a.disabled)`,
              { timeoutMs: 30_000, label: "PDF seed action enabled" },
            );
          },
        });
      },
    },
    {
      name: "Open a PDF artifact and confirm it renders inline",
      run: async (ctx) => {
        await ctx.prove("A PDF artifact renders inline via an embedded PDF viewer (not a blank frame)", {
          action: async () => {
            await ctx.control("eval.artifact_tabs.seed_pdf");
            await ctx.waitFor(
              `document.querySelectorAll('button[aria-label^="Select tab: sample-document.pdf"]').length >= 1`,
              { timeoutMs: 30_000, label: "seeded PDF artifact tab present" },
            );
            // Wait for the <embed> PDF viewer to mount with a blob URL.
            await ctx.waitFor(
              `(() => {
                const embed = document.querySelector('embed[type="application/pdf"]');
                const src = embed ? embed.getAttribute("src") || "" : "";
                return Boolean(embed) && src.startsWith("blob:");
              })()`,
              { timeoutMs: 30_000, label: "PDF embed mounted with blob URL" },
            );
          },
          assert: async () => {
            const result = await ctx.eval(`(() => {
              const embed = document.querySelector('embed[type="application/pdf"]');
              if (!embed) return { ok: false, reason: "no <embed> PDF viewer" };
              const rect = embed.getBoundingClientRect();
              const src = embed.getAttribute("src") || "";
              // The embed must be a real, sized region pointed at the blob URL.
              return {
                ok: true,
                hasBlob: src.startsWith("blob:"),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                visible: rect.width > 100 && rect.height > 100,
              };
            })()`);
            ctx.assert(result.ok, result.reason || "PDF embed not found.");
            ctx.assert(result.hasBlob, "PDF embed is not pointed at a blob URL.");
            ctx.assert(
              result.visible,
              `PDF embed is not visibly sized (width=${result.width}px, height=${result.height}px).`,
            );
            ctx.log(`PDF embed sized ${result.width}x${result.height}px with blob URL`);
          },
          screenshot: { name: "pdf-rendered-inline" },
        });
      },
    },
    {
      name: "Show in folder completes without an error toast",
      run: async (ctx) => {
        await ctx.prove("Clicking Show in folder reveals the file without surfacing an error", {
          action: async () => {
            // Dismiss any pre-existing toasts so we measure only this action.
            await ctx.eval(`(() => {
              document.querySelectorAll('[data-sonner-toast]').forEach((node) => node.remove());
              return true;
            })()`);
            const clicked = await ctx.eval(`(() => {
              const button = Array.from(document.querySelectorAll("button"))
                .find((item) => item.getAttribute("aria-label") === "Show in folder" && !item.disabled);
              if (!button) return "no-button";
              button.click();
              return "clicked";
            })()`);
            ctx.assert(clicked === "clicked", `Show in folder button not found: ${clicked}`);
            // Give the IPC round-trip a moment to surface a toast on failure.
            await ctx.waitFor("true", { timeoutMs: 1_500, label: "reveal settle" }).catch(() => undefined);
          },
          assert: async () => {
            const result = await ctx.eval(`(() => {
              const toasts = Array.from(document.querySelectorAll('[data-sonner-toast]'));
              const errorToast = toasts.find((node) =>
                node.getAttribute("data-type") === "error" ||
                /could not|unavailable|error|not found/i.test(node.textContent || ""),
              );
              return {
                hadErrorToast: Boolean(errorToast),
                errorText: errorToast ? (errorToast.textContent || "").slice(0, 120) : "",
              };
            })()`);
            ctx.assert(
              !result.hadErrorToast,
              `Show in folder surfaced an error toast: "${result.errorText}".`,
            );
            ctx.log("Show in folder completed without an error toast");
          },
          // Reveal opens the OS file manager (outside the app window), so the
          // app's own frame is intentionally unchanged. The assertion above
          // (no error toast) is the real proof; this is a visual checkpoint.
          screenshot: { name: "show-in-folder-no-error", allowInvalid: true },
        });
      },
    },
  ],
};
