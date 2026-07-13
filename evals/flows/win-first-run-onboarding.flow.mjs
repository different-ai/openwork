import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/win-first-run-onboarding.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("win-first-run-onboarding");
const MSG = "Reply with exactly: Windows onboarding OK";
const EDITOR_SELECTOR = '[contenteditable="true"][data-lexical-editor="true"]';

export default {
  id: "win-first-run-onboarding",
  title: "Windows first run: chat-ready landing, held first send, provider step, free-model reply",
  kind: "user-facing",
  preserveTheme: true,
  steps: [
    {
      name: "Frame 1 — first-run loader holds the boot surface",
      run: async (ctx) => {
        await ctx.prove("First launch shows the Preparing workspace loader instead of an empty session picker", {
          claim: "A factory-reset Windows launch starts on the full-screen Preparing workspace loader as the topmost surface while OpenWork creates the default workspace.",
          voiceover: vo[0],
          // "The instant the app opens there is no welcome wizard and no empty picker — j"
          action: async () => {
            await ctx.waitForText("Preparing workspace", { timeoutMs: 60_000 });
          },
          assert: async () => {
            await ctx.expectText("Preparing workspace", { timeoutMs: 1_000 });
            const occlusion = await ctx.eval(`(() => {
              const overlayTop = document.elementFromPoint(Math.floor(innerWidth / 2), Math.floor(innerHeight / 2));
              const status = overlayTop ? overlayTop.closest('[role="status"]') : null;
              const leaves = Array.from(document.querySelectorAll("*")).filter(
                (el) => el.children.length === 0 && (el.textContent || "").includes("Select or create a session"),
              );
              const emptyStateVisible = leaves.some((el) => {
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) return false;
                const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                return Boolean(top && (el === top || el.contains(top) || top.contains(el)));
              });
              return { loaderOnTop: Boolean(status), emptyStateVisible };
            })()`);
            ctx.assert(occlusion.loaderOnTop, "The Preparing workspace loader overlay is not the topmost element at the viewport center.");
            ctx.assert(!occlusion.emptyStateVisible, "The select-or-create empty state is visible to the user during first-run boot.");
          },
          screenshot: {
            name: "first-run-loader",
            requireText: ["Preparing workspace"],
          },
        });
      },
    },
    {
      name: "Frame 2 — auto-created session is chat-ready",
      run: async (ctx) => {
        await ctx.prove("The loader hands off directly to a ready first session", {
          claim: "When the engine is ready, OpenWork lands on an auto-created session with the composer and Ready for new tasks status visible, never the select-or-create empty state.",
          voiceover: vo[1],
          // "When the engine is ready the loader hands off straight into a live chat sess"
          action: async () => {
            await ctx.waitFor('location.hash.includes("/session/")', {
              timeoutMs: 150_000,
              label: "auto-created first session route",
            });
            await ctx.waitFor('!document.body.innerText.includes("Preparing workspace")', {
              timeoutMs: 150_000,
              label: "Preparing workspace loader dismissed",
            });
          },
          assert: async () => {
            await ctx.expectText("Describe your task", { timeoutMs: 30_000 });
            await ctx.expectText("Ready for new tasks", { timeoutMs: 30_000 });
            await ctx.expectHashIncludes("/session/");
            await ctx.expectNoText("Select or create a session");
          },
          screenshot: {
            name: "chat-ready-session",
            requireText: ["Describe your task", "Ready for new tasks"],
            rejectText: ["Select or create a session"],
            hashIncludes: "/session/",
          },
        });
      },
    },
    {
      name: "Frame 3 — first send is held for provider choice",
      run: async (ctx) => {
        await ctx.prove("Running the first task opens the provider choice step before sending", {
          claim: "The first Run task click keeps the draft in place and asks whether to use OpenWork Models, bring an API key, or skip to the free model.",
          voiceover: vo[2],
          // "The user types their first message and presses Run task. Instead of sending "
          action: async () => {
            await ctx.waitFor(`Boolean(document.querySelector(${JSON.stringify(EDITOR_SELECTOR)}))`, {
              timeoutMs: 30_000,
              label: "Lexical composer editor",
            });
            await ctx.eval(`(() => {
              const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
              if (!editor) throw new Error("composer editor missing");
              editor.focus();
              const data = new DataTransfer();
              data.setData("text/plain", ${JSON.stringify(MSG)});
              editor.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
              return true;
            })()`);
            await ctx.waitFor(`(() => {
              const editor = document.querySelector(${JSON.stringify(EDITOR_SELECTOR)});
              return Boolean(editor && editor.innerText.includes(${JSON.stringify(MSG)}));
            })()`, { timeoutMs: 30_000, label: "pasted draft in composer" });
            await ctx.waitFor(`(() => {
              const buttons = Array.from(document.querySelectorAll("button"));
              return buttons.some((button) => (button.textContent ?? "").includes("Run task") && !button.disabled);
            })()`, { timeoutMs: 30_000, label: "enabled Run task button" });
            await ctx.clickText("Run task", { selector: "button", timeoutMs: 30_000 });
            await ctx.waitForText("Power your first task", { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectText("Power your first task");
            await ctx.expectText("Use OpenWork Models");
            await ctx.expectText("Bring your own API key");
            await ctx.expectText("Skip and use the free model");
          },
          screenshot: {
            name: "provider-choice-step",
            requireText: ["Power your first task", "Use OpenWork Models", "Skip and use the free model"],
          },
        });
      },
    },
    {
      name: "Frame 4 — skip free model sends held draft and completes setup",
      run: async (ctx) => {
        await ctx.prove("Skipping to the free model auto-sends the held draft and marks provider setup complete", {
          claim: "After choosing the free model, the provider step disappears, the held Windows onboarding draft is answered, and the one-shot provider preference is persisted.",
          voiceover: vo[3],
          // "The user picks skip and use the free model. The held message sends itself im"
          action: async () => {
            await ctx.clickText("Skip and use the free model", { selector: "button", timeoutMs: 30_000 });
            await ctx.waitFor('!document.body.innerText.includes("Power your first task")', {
              timeoutMs: 30_000,
              label: "provider step dismissed",
            });
            await ctx.waitFor(`(() => {
              const text = document.body.innerText;
              return text.split(${JSON.stringify("Windows onboarding OK")}).length > 2;
            })()`, { timeoutMs: 120_000, label: "free model reply appears after held draft resend" });
          },
          assert: async () => {
            const result = await ctx.eval(`(() => {
              const rawPreferences = localStorage.getItem("openwork.preferences");
              const preferences = rawPreferences ? JSON.parse(rawPreferences) : null;
              const text = document.body.innerText;
              return {
                providerStepCompleted: preferences?.providerStepCompleted === true,
                promoStartupShown: localStorage.getItem("openwork.openworkModelsPromo.startupShown"),
                replyCount: text.split(${JSON.stringify("Windows onboarding OK")}).length - 1,
              };
            })()`);
            ctx.assert(result.providerStepCompleted === true, "providerStepCompleted was not true in openwork.preferences.");
            ctx.assert(result.promoStartupShown === "1", "openwork.openworkModelsPromo.startupShown was not set to 1.");
            ctx.assert(result.replyCount > 1, "Windows onboarding OK did not appear in both the user draft and assistant reply.");
            await ctx.expectNoText("Power your first task");
          },
          screenshot: {
            name: "free-model-reply-complete",
            requireText: ["Windows onboarding OK"],
            rejectText: ["Power your first task"],
          },
        });
      },
    },
  ],
};
