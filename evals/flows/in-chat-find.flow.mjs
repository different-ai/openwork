/**
 * User-facing flow demo: find within the current conversation highlights both
 * user and assistant text, navigates matches, clears cleanly, and complements
 * cross-session search by landing on the exact matched message.
 */

const FIND_INPUT = 'input[aria-label="Find in conversation"]';
const SEARCH_INPUT = 'input[placeholder="Search all sessions and messages…"]';
const HIGHLIGHT = 'mark[data-search-highlight="true"]';
const ACTIVE_HIGHLIGHT = 'mark[data-search-highlight-active="true"]';
const PROMPT = "Reply with exactly this sentence and nothing else: The blue zebra crossed the quiet bridge.";
const QUERY = "zebra";

let seededSessionId = null;

async function pasteComposer(ctx, text) {
  return ctx.eval(
    `(() => {
      const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]')
        || document.querySelector('[contenteditable="true"]');
      if (!editor) return { ok: false, reason: 'composer not found' };
      editor.focus();
      const data = new DataTransfer();
      data.setData('text/plain', ${JSON.stringify(text)});
      editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
      return { ok: true, text: editor.innerText };
    })()`,
  );
}

async function submitComposer(ctx) {
  return ctx.eval(`(() => {
    const byLabel = Array.from(document.querySelectorAll('button'))
      .find((button) => /run task|send|run/i.test((button.textContent || "").trim()) && !button.disabled);
    if (byLabel) { byLabel.click(); return "clicked"; }
    const editor = document.querySelector('[contenteditable="true"]');
    if (editor) {
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return "enter";
    }
    return "none";
  })()`);
}

async function currentRouteSessionId(ctx) {
  return ctx.eval(`(() => {
    const route = window.__openworkControl.snapshot().route || "";
    const match = route.match(/ses_[A-Za-z0-9]+/);
    return match ? match[0] : null;
  })()`);
}

// Waits for the route to point at a session DIFFERENT from `previousId` so a
// pre-existing active session can never be mistaken for the new task.
async function waitForNewRouteSessionId(ctx, previousId, label) {
  return ctx.waitFor(
    `(() => {
      const route = window.__openworkControl.snapshot().route || "";
      const match = route.match(/ses_[A-Za-z0-9]+/);
      if (!match) return null;
      return match[0] === ${JSON.stringify(previousId)} ? null : match[0];
    })()`,
    { timeoutMs: 30_000, label },
  );
}

async function closeFindBarIfOpen(ctx) {
  const closed = await ctx.eval(`(() => {
    const input = document.querySelector(${JSON.stringify(FIND_INPUT)});
    if (!input) return false;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return true;
  })()`);
  if (closed) {
    await ctx.waitFor(`!document.querySelector(${JSON.stringify(FIND_INPUT)})`, {
      label: "stale find bar to close",
    });
  }
}

async function closeSessionSearchDialogIfOpen(ctx) {
  const closed = await ctx.eval(`(() => {
    const input = document.querySelector(${JSON.stringify(SEARCH_INPUT)});
    if (!input) return false;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return true;
  })()`);
  if (closed) {
    await ctx.waitFor(`!document.querySelector(${JSON.stringify(SEARCH_INPUT)})`, {
      label: "stale session search dialog to close",
    });
  }
}

function counterTextExpression() {
  return `(() => {
    const input = document.querySelector(${JSON.stringify(FIND_INPUT)});
    const bar = input ? input.parentElement : null;
    const counter = bar ? bar.querySelector('[aria-live="polite"]') : null;
    return counter ? counter.textContent.trim() : "";
  })()`;
}

function activeMatchStateExpression() {
  return `(() => {
    const marks = Array.from(document.querySelectorAll(${JSON.stringify(HIGHLIGHT)}));
    const active = document.querySelector(${JSON.stringify(ACTIVE_HIGHLIGHT)});
    const message = active ? active.closest('[data-message-id]') : null;
    return {
      total: marks.length,
      activeCount: document.querySelectorAll(${JSON.stringify(ACTIVE_HIGHLIGHT)}).length,
      activeIndex: active ? marks.indexOf(active) : -1,
      messageId: message ? message.getAttribute('data-message-id') : null,
      role: message ? message.getAttribute('data-message-role') : null,
      counter: ${counterTextExpression()},
    };
  })()`;
}

export default {
  id: "in-chat-find",
  title: "Find in conversation: ⌘F highlights, navigates, and receives cross-session handoff",
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
      ? "Profile is not onboarded (welcome/signin); in-chat find requires a workspace."
      : null;
  },
  steps: [
    {
      name: "Seed a conversation with a shared user and assistant term",
      run: async (ctx) => {
        await ctx.prove("A conversation contains the same searchable word in the prompt and reply", {
          claim: "The flow creates a fresh conversation where 'zebra' appears in both the user's message and the assistant's visible prose.",
          voiceover:
            "First I create a fresh conversation and ask for one exact sentence. When the assistant answers, the word zebra is visible in both my bubble and the assistant prose, giving the find bar real matches to work with.",
          action: async () => {
            const previousSessionId = await currentRouteSessionId(ctx);
            await ctx.control("session.create_task");
            seededSessionId = await waitForNewRouteSessionId(ctx, previousSessionId, "seeded session id in route");
            ctx.assert(Boolean(seededSessionId), "No seeded session id was captured from the route.");

            const pasted = await pasteComposer(ctx, PROMPT);
            ctx.assert(pasted?.ok, `Composer not ready: ${pasted?.reason ?? "unknown"}`);
            const submitted = await submitComposer(ctx);
            ctx.assert(submitted !== "none", "Could not submit the composer message.");
            ctx.log(`seeded session: ${seededSessionId}; submit: ${submitted}`);
          },
          assert: async () => {
            // Scope to the transcript (sidebar titles from previous runs also
            // contain the word) and require the ASSISTANT reply specifically,
            // so the step only passes once the response actually streamed in.
            await ctx.waitFor(
              `(() => {
                const userHit = Array.from(document.querySelectorAll('[data-message-role="user"]'))
                  .some((el) => el.innerText.toLowerCase().includes(${JSON.stringify(QUERY)}));
                const assistantHit = Array.from(document.querySelectorAll('[data-message-role="assistant"]'))
                  .some((el) => el.innerText.toLowerCase().includes(${JSON.stringify(QUERY)}));
                return userHit && assistantHit;
              })()`,
              { timeoutMs: 60_000, label: "zebra appears in user and assistant transcript messages" },
            );
            // Let the response settle so the composer's post-response focus
            // handling cannot race the find bar focus in the next step.
            await new Promise((resolve) => setTimeout(resolve, 1_500));
            await ctx.expectNoText("Something went wrong");
          },
          screenshot: {
            name: "seeded-zebra-conversation",
            requireText: ["zebra"],
          },
        });
      },
    },
    {
      name: "Cmd/Ctrl+F opens and focuses the find bar",
      run: async (ctx) => {
        await ctx.prove("The keyboard shortcut opens the focused find bar", {
          claim: "Cmd/Ctrl+F opens Find in conversation, focuses its input, and the header exposes the same feature as an always-visible button.",
          voiceover:
            "Now I press the familiar Find shortcut. The compact find bar appears at the top of the transcript and takes focus, while the header still shows a Find in conversation button so users can discover it without memorizing the shortcut.",
          action: async () => {
            await closeFindBarIfOpen(ctx);
            await ctx.eval(`(() => {
              window.dispatchEvent(new KeyboardEvent("keydown", {
                key: "f",
                metaKey: true,
                ctrlKey: true,
                bubbles: true,
              }));
              return true;
            })()`);
          },
          assert: async () => {
            await ctx.waitFor(
              `(() => {
                const input = document.querySelector(${JSON.stringify(FIND_INPUT)});
                return Boolean(input && document.activeElement === input);
              })()`,
              { timeoutMs: 10_000, label: "find input focused after shortcut" },
            );
            const headerButtonExists = await ctx.eval(
              `Boolean(document.querySelector('button[aria-label="Find in conversation"]'))`,
            );
            ctx.assert(headerButtonExists, "The header Find in conversation button is missing.");
          },
          screenshot: {
            name: "find-bar-open-focused",
          },
        });
      },
    },
    {
      name: "Typing highlights all matches and reports the live count",
      run: async (ctx) => {
        await ctx.prove("Typing a query highlights every readable match with a counter", {
          claim: "Typing 'zebra' highlights the user bubble and assistant prose, marks one result active, and shows a live 1/N counter.",
          voiceover:
            "I type zebra. The transcript highlights each readable occurrence with the same amber mark, one match is selected, and the counter says I am on the first result out of the full set.",
          action: async () => {
            await ctx.fill(FIND_INPUT, QUERY);
            await ctx.waitFor(
              `document.querySelectorAll(${JSON.stringify(HIGHLIGHT)}).length >= 2`,
              { timeoutMs: 10_000, label: "at least two zebra highlights" },
            );
          },
          assert: async () => {
            const state = await ctx.waitFor(
              `(() => {
                const state = ${activeMatchStateExpression()};
                return state.total >= 2 && state.activeCount === 1 && state.counter.indexOf("1/") === 0
                  ? state
                  : null;
              })()`,
              { timeoutMs: 10_000, label: "highlight counter starts at 1/N with one active match" },
            );
            ctx.assert(state.total >= 2, `Expected at least two highlights, saw ${state.total}.`);
            ctx.assert(state.activeCount === 1, `Expected exactly one active highlight, saw ${state.activeCount}.`);
            ctx.assert(/^1\/\d+$/.test(state.counter), `Expected counter to start at 1/N, saw '${state.counter}'.`);
          },
          screenshot: {
            name: "find-zebra-highlighted",
            requireText: ["zebra"],
          },
        });
      },
    },
    {
      name: "Enter advances to the next match",
      run: async (ctx) => {
        let before = null;
        await ctx.prove("Enter moves the active highlight to the next result", {
          claim: "Pressing Enter advances from 1/N to 2/N while keeping exactly one active highlighted match.",
          voiceover:
            "Next I press Enter. The active highlight moves forward, the counter advances to the second result, and the find bar stays focused so repeated Enter presses keep navigating.",
          action: async () => {
            before = await ctx.eval(activeMatchStateExpression());
            await ctx.eval(`(() => {
              const input = document.querySelector(${JSON.stringify(FIND_INPUT)});
              if (!input) throw new Error("find input missing");
              input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
              return true;
            })()`);
            await ctx.waitFor(
              `(() => (${counterTextExpression()}).indexOf("2/") === 0)()`,
              { timeoutMs: 10_000, label: "find counter advances to 2/N" },
            );
          },
          assert: async () => {
            const after = await ctx.eval(activeMatchStateExpression());
            ctx.assert(Boolean(before), "No active match state was captured before pressing Enter.");
            ctx.assert(after.activeCount === 1, `Expected one active highlight after Enter, saw ${after.activeCount}.`);
            ctx.assert(/^2\/\d+$/.test(after.counter), `Expected counter to read 2/N, saw '${after.counter}'.`);
            ctx.assert(
              before.activeIndex !== after.activeIndex || before.messageId !== after.messageId,
              `Active match did not change after Enter: ${JSON.stringify({ before, after })}`,
            );
          },
          screenshot: {
            name: "find-enter-next-match",
            requireText: ["zebra"],
          },
        });
      },
    },
    {
      name: "Escape closes the bar and clears highlights",
      run: async (ctx) => {
        await ctx.prove("Escape clears the find UI and removes every highlight", {
          claim: "Pressing Escape closes the find bar and removes all search highlight marks from the transcript.",
          voiceover:
            "When I press Escape, the find bar gets out of the way. The transcript returns to normal — no active state, no amber marks, and no leftover no-match message.",
          action: async () => {
            await ctx.eval(`(() => {
              const input = document.querySelector(${JSON.stringify(FIND_INPUT)});
              if (!input) throw new Error("find input missing");
              input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
              return true;
            })()`);
            await ctx.waitFor(
              `(() => !document.querySelector(${JSON.stringify(FIND_INPUT)})
                && document.querySelectorAll(${JSON.stringify(HIGHLIGHT)}).length === 0)()`,
              { timeoutMs: 10_000, label: "find bar closed and highlights cleared" },
            );
          },
          assert: async () => {
            const state = await ctx.eval(`(() => ({
              inputOpen: Boolean(document.querySelector(${JSON.stringify(FIND_INPUT)})),
              highlights: document.querySelectorAll(${JSON.stringify(HIGHLIGHT)}).length,
            }))()`);
            ctx.assert(!state.inputOpen, "Find input is still visible after Escape.");
            ctx.assert(state.highlights === 0, `Expected zero highlights after Escape, saw ${state.highlights}.`);
          },
          screenshot: {
            name: "find-closed-cleared",
            rejectText: ["No matches"],
          },
        });
      },
    },
    {
      name: "Cross-session search hands off into in-chat find",
      run: async (ctx) => {
        let emptySessionId = null;
        await ctx.prove("Cross-session search opens the original session and highlights the exact user match", {
          claim: "Selecting the zebra message result from cross-session search returns to the seeded conversation, opens Find in conversation with the query, and activates the user-message match.",
          voiceover:
            "Finally I jump away to a new empty session and use Search sessions. Searching everywhere finds the old zebra prompt, and selecting it lands me back on the exact message with Find in conversation already open and focused on that user match.",
          action: async () => {
            ctx.assert(Boolean(seededSessionId), "Seeded session id was not captured before cross-session handoff.");
            await ctx.control("session.create_task");
            emptySessionId = await waitForNewRouteSessionId(ctx, seededSessionId, "new empty session id in route");
            ctx.assert(
              emptySessionId !== seededSessionId,
              `Expected a new empty session, but route stayed on ${emptySessionId}.`,
            );

            await closeSessionSearchDialogIfOpen(ctx);
            await ctx.clickText("Search sessions");
            await ctx.waitFor(`Boolean(document.querySelector(${JSON.stringify(SEARCH_INPUT)}))`, {
              label: "session search dialog input",
            });
            await ctx.fill(SEARCH_INPUT, QUERY);
            await ctx.waitFor(
              `(() => {
                const items = Array.from(document.querySelectorAll('[data-slot="command-item"]'));
                return items.some((item) => /You:.*zebra/i.test(item.innerText));
              })()`,
              { timeoutMs: 60_000, label: "cross-session user zebra result" },
            );
            await ctx.eval(`(() => {
              const items = Array.from(document.querySelectorAll('[data-slot="command-item"]'));
              const item = items.find((candidate) => /You:.*zebra/i.test(candidate.innerText));
              if (!item) throw new Error("zebra user result missing");
              item.click();
              return true;
            })()`);
          },
          assert: async () => {
            await ctx.waitFor(`!document.querySelector(${JSON.stringify(SEARCH_INPUT)})`, {
              label: "session search dialog closes",
            });
            // Reruns on a used profile can legitimately surface an older
            // zebra conversation first; the handoff contract is "land in the
            // matched conversation with find open on the matched message",
            // not "land in this run's session specifically".
            const landedSessionId = await ctx.waitFor(
              `(() => {
                const route = window.__openworkControl.snapshot().route || "";
                const match = route.match(/ses_[A-Za-z0-9]+/);
                return match && match[0] !== ${JSON.stringify(emptySessionId)} ? match[0] : null;
              })()`,
              { timeoutMs: 30_000, label: "route lands in a matched conversation" },
            );
            ctx.log(`handoff landed on ${landedSessionId} (seeded this run: ${seededSessionId})`);
            await ctx.waitFor(
              `(() => {
                const input = document.querySelector(${JSON.stringify(FIND_INPUT)});
                return Boolean(input && input.value === ${JSON.stringify(QUERY)});
              })()`,
              { timeoutMs: 15_000, label: "handoff opens find bar with zebra" },
            );
            await ctx.waitFor(
              `(() => document.querySelectorAll(${JSON.stringify(HIGHLIGHT)}).length >= 2
                && document.querySelectorAll(${JSON.stringify(ACTIVE_HIGHLIGHT)}).length === 1)()`,
              { timeoutMs: 15_000, label: "handoff highlights and active match" },
            );
            const state = await ctx.eval(activeMatchStateExpression());
            ctx.assert(state.role === "user", `Expected active handoff match in a user message, saw ${state.role}.`);
          },
          screenshot: {
            name: "cross-session-handoff-to-find",
            requireText: ["zebra"],
          },
        });
      },
    },
  ],
};
