import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const vo = await loadVoiceoverParagraphs("chat-transcript-sentences");

/**
 * Paper chat transcript rules, proven on a deterministic seeded turn
 * (dev-only `eval.chat_transcript.seed` control action): capability calls
 * as sentences, aggregated tool runs, collapsed thinking, linkified bare
 * URLs with favicons, minimal failed calls, and the per-turn FILES strip.
 */
export default {
  id: "chat-transcript-sentences",
  title: "Chat transcript renders sentences, aggregates, chips — never raw JSON",
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
      name: "Seeded turn renders capability sentences and linkified user URL",
      run: async (ctx) => {
        // Idempotency: a previous run may have left panels expanded in this
        // renderer; a reload resets all component state before we seed.
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
        // The finished turn folds its steps behind a "Worked for …" line;
        // expand it so the step-level assertions below can see the run.
        await ctx.waitForText("Worked for 1m 35s", { timeoutMs: 30_000 });
        await ctx.waitFor(`(() => {
          const trigger = [...document.querySelectorAll("button")]
            .find((node) => node.textContent.includes("Worked for"));
          if (!trigger) return false;
          if (trigger.getAttribute("aria-expanded") !== "true") trigger.click();
          return trigger.getAttribute("aria-expanded") === "true";
        })()`, { timeoutMs: 15_000, label: "step fold expanded" });
        await ctx.waitForText("Fetched Google Workspace Calendar Events", { timeoutMs: 30_000 });

        await ctx.prove("Capability call reads as a sentence; the pasted link gets a favicon", {
          voiceover: vo[0],
          assert: async () => {
            const link = await ctx.eval(`(() => {
              const anchor = [...document.querySelectorAll('a[href="https://linear.app"]')][0];
              if (!anchor) return null;
              const scope = anchor.closest("div");
              const favicon = anchor.querySelector("img[src*='favicons']")
                || scope?.querySelector("img[src*='favicons']");
              return {
                linkified: true,
                favicon: Boolean(favicon),
                decoration: getComputedStyle(anchor).textDecorationLine,
              };
            })()`);
            ctx.assert(link?.linkified, "Bare https://linear.app in the user message is not a link.");
            ctx.assert(link?.favicon, "No favicon rendered next to the linear.app link.");
            ctx.assert(link?.decoration === "none", `Chat links must not be underlined (got ${link?.decoration}).`);
            await ctx.expectText("Fetched Google Workspace Calendar Events");
            // Sentence line, not a JSON card: no raw braces in the visible line.
            const rawJson = await ctx.eval(`(() => {
              const el = [...document.querySelectorAll('[data-capability-call="openwork-cloud_execute_capability"]')][0];
              return el ? el.textContent.includes("{") : null;
            })()`);
            ctx.assert(rawJson === false, "Capability line leaks raw JSON while collapsed.");
          },
          screenshot: {
            name: "capability-sentence-and-favicon-link",
            requireText: ["Fetched Google Workspace Calendar Events"],
          },
        });
      },
    },
    {
      name: "Consecutive tool calls aggregate into one expandable line",
      run: async (ctx) => {
        await ctx.prove("Aggregate line summarizes the work and expands to rows with file chips", {
          voiceover: vo[1],
          action: async () => {
            await ctx.waitForText("Edited 1 file, ran 2 commands, read 1 file", { timeoutMs: 15_000 });
            // Expand via the aggregate group's own trigger; clickText can hit
            // a stale match while the transcript is still settling.
            await ctx.waitFor(`(() => {
              const group = document.querySelector("[data-tool-aggregate]");
              const trigger = group?.querySelector("button");
              if (!trigger) return false;
              if (!group.textContent.includes("git status --short")) trigger.click();
              return group.textContent.includes("git status --short");
            })()`, { timeoutMs: 15_000, label: "expanded aggregate rows" });
            await ctx.eval(`document.querySelector("[data-tool-aggregate]")?.scrollIntoView({ block: "center" })`);
            // The rows reveal with a height transition; wait until the command
            // row is actually laid out, or the frame can double the previous.
            await ctx.waitFor(`(() => {
              const leaf = [...document.querySelectorAll("[data-tool-aggregate] *")]
                .find((node) => node.childElementCount === 0 && node.textContent.includes("git status --short"));
              return Boolean(leaf && leaf.getClientRects().length > 0);
            })()`, { timeoutMs: 10_000, label: "aggregate rows painted" });
          },
          assert: async () => {
            await ctx.expectText("Edited 1 file, ran 2 commands, read 1 file");
            await ctx.waitForText("git status --short", { timeoutMs: 10_000 });
            await ctx.expectText("plan-tomorrow.md");
            await ctx.expectText("meeting-notes.md");
          },
          screenshot: {
            name: "aggregate-expanded-with-file-chips",
            requireText: ["git status --short", "plan-tomorrow.md"],
          },
        });
      },
    },
    {
      name: "Thinking is collapsed by default and opens on demand",
      run: async (ctx) => {
        await ctx.prove("Reasoning hides behind a Thought toggle until clicked", {
          voiceover: vo[2],
          action: async () => {
            const collapsed = await ctx.eval(
              `!document.body.innerText.includes("Calendar first, then open issues")`,
            );
            ctx.assert(collapsed, "Reasoning content is visible before expanding.");
            await ctx.clickText("Thought", { timeoutMs: 10_000 });
          },
          assert: async () => {
            await ctx.waitForText("Calendar first, then open issues", { timeoutMs: 10_000 });
            await ctx.eval(`[...document.querySelectorAll("button")]
              .find((b) => b.textContent.includes("Thought"))
              ?.scrollIntoView({ block: "center" })`);
          },
          screenshot: {
            name: "thinking-expanded",
            requireText: ["Planning approach"],
          },
        });
      },
    },
    {
      name: "Failed call stays minimal and expands into the failure card",
      run: async (ctx) => {
        await ctx.prove("Failure is one muted line; expanding reveals quote and instruction", {
          voiceover: vo[3],
          action: async () => {
            const collapsed = await ctx.eval(
              `!document.body.innerText.includes("What did we decide about pricing?")`,
            );
            ctx.assert(collapsed, "Failure card content is visible before expanding.");
            await ctx.eval(`(() => {
              const line = document.querySelector('[data-capability-call="granola_ask_about_meetings"] button');
              line?.click();
              return Boolean(line);
            })()`);
          },
          assert: async () => {
            await ctx.expectText("failed");
            await ctx.waitForText("What did we decide about pricing?", { timeoutMs: 10_000 });
            await ctx.expectText("Technical details");
            await ctx.eval(`document.querySelector('[data-capability-call="granola_ask_about_meetings"]')?.scrollIntoView({ block: "center" })`);
          },
          screenshot: {
            name: "failed-call-card",
            requireText: ["What did we decide about pricing?", "Technical details"],
          },
        });
      },
    },
    {
      name: "The turn ends with the FILES strip",
      run: async (ctx) => {
        await ctx.prove("A FILES strip lists every touched file as an openable chip", {
          voiceover: vo[4],
          action: async () => {
            // Collapse the failure card again so this frame is visually its own.
            await ctx.eval(`(() => {
              const line = document.querySelector('[data-capability-call="granola_ask_about_meetings"] button');
              line?.click();
              return true;
            })()`);
            await ctx.waitFor(
              `!document.body.innerText.includes("What did we decide about pricing?")`,
              { timeoutMs: 10_000, label: "failure card collapsed" },
            );
            await ctx.eval(`document.querySelector("[data-files-strip]")?.scrollIntoView({ block: "center" })`);
          },
          assert: async () => {
            const strip = await ctx.eval(`(() => {
              const strip = document.querySelector("[data-files-strip]");
              if (!strip) return null;
              return {
                label: strip.textContent.includes("Files"),
                plan: strip.textContent.includes("plan-tomorrow.md"),
                notes: strip.textContent.includes("meeting-notes.md"),
              };
            })()`);
            ctx.assert(strip, "No FILES strip rendered for the seeded turn.");
            ctx.assert(strip.label, "FILES strip is missing its label.");
            ctx.assert(strip.plan && strip.notes, "FILES strip is missing touched file chips.");
            // Assistant markdown link also carries a favicon.
            const favicon = await ctx.eval(`(() => {
              const anchor = [...document.querySelectorAll('a[href*="openworklabs.com"]')][0];
              return Boolean(anchor && (anchor.querySelector("img[src*='favicons']")
                || anchor.previousElementSibling?.matches?.("img[src*='favicons']")));
            })()`);
            ctx.assert(favicon, "Assistant markdown link has no favicon.");
          },
          screenshot: {
            name: "files-strip",
            requireText: ["FILES", "plan-tomorrow.md"],
          },
        });
      },
    },
  ],
};
