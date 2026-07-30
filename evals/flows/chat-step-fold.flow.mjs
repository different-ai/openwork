import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const vo = await loadVoiceoverParagraphs("chat-step-fold");

/**
 * A finished turn's steps fold behind a "Worked for …" line (real duration
 * from the assistant's completed timestamp), and reasoning between tool
 * calls no longer fragments the aggregate summary. Proven on the
 * deterministic seeded turn (dev-only `eval.chat_transcript.seed`), which
 * ships steps and the final answer interleaved in ONE assistant message —
 * the exact shape OpenCode delivers.
 */
export default {
  id: "chat-step-fold",
  title: "Finished turns fold behind 'Worked for …'; aggregates survive thinking",
  kind: "user-facing",
  precondition: async (ctx) => {
    await ctx.waitFor("Boolean(window.__openworkControl)", {
      timeoutMs: 60_000,
      label: "control API",
    });
    const state = await ctx.waitFor(
      `(() => {
        const control = window.__openworkControl;
        const route = control.snapshot().route;
        if (route.startsWith("/welcome") || route.startsWith("/signin")) return "blocked";
        const action = control.listActions().find((a) => a.id === "session.create_task");
        if (action && !action.disabled) return "ready";
        return null;
      })()`,
      { timeoutMs: 30_000, label: "session.create_task enabled (or welcome/signin)" },
    );
    return state === "blocked"
      ? "Profile is not onboarded (welcome/signin); this flow requires a workspace."
      : null;
  },
  steps: [
    {
      name: "A finished turn folds behind a duration line, answer stays visible",
      run: async (ctx) => {
        // Idempotency: reload resets any panels a previous run left open.
        await ctx.eval("location.reload()");
        await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API after reload" });
        await ctx.waitFor(
          `window.__openworkControl.listActions().some((a) => a.id === "session.create_task" && !a.disabled)`,
          { timeoutMs: 30_000, label: "task creation ready" },
        );
        await ctx.control("session.create_task");
        await ctx.waitFor(
          `window.__openworkControl.listActions().some((a) => a.id === "eval.chat_transcript.seed" && !a.disabled)`,
          { timeoutMs: 30_000, label: "chat transcript seed action" },
        );
        await ctx.control("eval.chat_transcript.seed");

        await ctx.prove("Steps fold into one 'Worked for 1m 35s' line; the answer stays visible", {
          voiceover: vo[0],
          action: async () => {
            await ctx.waitForText("Worked for 1m 35s", { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectText("Worked for 1m 35s");
            // The answer is outside the fold.
            await ctx.expectText("Your plan is drafted");
            // Step-level content is folded away until expanded.
            await ctx.expectNoText("git status --short");
            await ctx.expectNoText("Fetched Google Workspace Calendar Events");
          },
          screenshot: {
            name: "turn-folded-worked-for",
            requireText: ["Worked for 1m 35s", "Your plan is drafted"],
            rejectText: ["git status --short"],
          },
        });
      },
    },
    {
      name: "Expanding the fold shows one aggregate line despite interleaved reasoning",
      run: async (ctx) => {
        await ctx.prove("The reopened run keeps tool work merged into a single aggregate line", {
          voiceover: vo[1],
          action: async () => {
            await ctx.waitFor(`(() => {
              const trigger = [...document.querySelectorAll("button")]
                .find((node) => node.textContent.includes("Worked for"));
              if (!trigger) return false;
              if (trigger.getAttribute("aria-expanded") !== "true") trigger.click();
              return trigger.getAttribute("aria-expanded") === "true";
            })()`, { timeoutMs: 15_000, label: "step fold expanded" });
            await ctx.waitForText("Edited 1 file, ran 2 commands, read 1 file", { timeoutMs: 15_000 });
            await ctx.eval(`document.querySelector("[data-tool-aggregate]")?.scrollIntoView({ block: "center" })`);
          },
          assert: async () => {
            // One merged summary — the seeded turn has reasoning before the
            // calls, which previously fragmented this into per-call lines.
            await ctx.expectText("Edited 1 file, ran 2 commands, read 1 file");
            const aggregateCount = await ctx.eval(
              `document.querySelectorAll("[data-tool-aggregate]").length`,
            );
            ctx.assert(
              aggregateCount === 1,
              `Expected exactly one aggregate group, got ${aggregateCount}.`,
            );
          },
          screenshot: {
            name: "fold-expanded-single-aggregate",
            requireText: ["Edited 1 file, ran 2 commands, read 1 file"],
          },
        });
      },
    },
  ],
};
