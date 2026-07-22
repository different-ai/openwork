/**
 * User-facing flow demo: Find in conversation is owned by one split-screen pane,
 * so only that pane renders the bar and receives highlights.
 */

const FIND_INPUT = 'input[aria-label="Find in conversation"]';
const HIGHLIGHT = 'mark[data-search-highlight="true"]';
const SURFACE = '[data-session-surface-id]';
const PROMPT = "Reply with exactly this sentence and nothing else: The calm walrus watched the quiet harbor.";
const QUERY = "walrus";

let sessionA = null;
let sessionB = null;

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
    await ctx.waitFor(
      `(() => !document.querySelector(${JSON.stringify(FIND_INPUT)})
        && document.querySelectorAll(${JSON.stringify(HIGHLIGHT)}).length === 0)()`,
      { label: "stale find bar and highlights to clear" },
    );
  }
}

function surfaceStateExpression() {
  return `(() => {
    const roots = Array.from(document.querySelectorAll(${JSON.stringify(SURFACE)}));
    return roots.map((root) => root.getAttribute('data-session-surface-id'));
  })()`;
}

function paneMatchStateExpression(paneId) {
  return `(() => {
    const root = Array.from(document.querySelectorAll(${JSON.stringify(SURFACE)}))
      .find((candidate) => candidate.getAttribute('data-session-surface-id') === ${JSON.stringify(paneId)});
    if (!root) return { mounted: false, marks: 0, counter: "", input: false };
    const input = root.querySelector(${JSON.stringify(FIND_INPUT)});
    const bar = input ? input.parentElement : null;
    const counter = bar ? bar.querySelector('[aria-live="polite"]') : null;
    return {
      mounted: true,
      marks: root.querySelectorAll(${JSON.stringify(HIGHLIGHT)}).length,
      counter: counter ? counter.textContent.trim() : "",
      input: Boolean(input),
    };
  })()`;
}

export default {
  id: "find-split-screen",
  title: "Find in conversation stays scoped to one split-screen pane",
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
      ? "Profile is not onboarded (welcome/signin); split-screen find requires a workspace."
      : null;
  },
  steps: [
    {
      name: "Seed session A with a searchable reply",
      run: async (ctx) => {
        await ctx.prove("Session A contains walrus in both the prompt and assistant reply", {
          claim: "The flow creates a first session where 'walrus' appears in both user and assistant messages, so pane-scoped highlighting can be proven later.",
          voiceover:
            "First I seed a conversation on the left side of our story. The word walrus appears in my prompt and in the assistant's exact reply, so this session will have multiple readable matches.",
          action: async () => {
            const previous = await currentRouteSessionId(ctx);
            await ctx.control("session.create_task");
            sessionA = await waitForNewRouteSessionId(ctx, previous, "session A id in route");
            ctx.assert(Boolean(sessionA), "No session A id was captured from the route.");

            const pasted = await pasteComposer(ctx, PROMPT);
            ctx.assert(pasted?.ok, `Composer not ready: ${pasted?.reason ?? "unknown"}`);
            const submitted = await submitComposer(ctx);
            ctx.assert(submitted !== "none", "Could not submit the composer message.");
            ctx.log(`session A: ${sessionA}; submit: ${submitted}`);
          },
          assert: async () => {
            await ctx.waitFor(
              `(() => {
                const root = Array.from(document.querySelectorAll(${JSON.stringify(SURFACE)}))
                  .find((candidate) => candidate.getAttribute('data-session-surface-id') === ${JSON.stringify(sessionA)});
                if (!root) return false;
                const userHasWalrus = Array.from(root.querySelectorAll('[data-message-role="user"]'))
                  .some((message) => message.innerText.toLowerCase().includes(${JSON.stringify(QUERY)}));
                const assistantHasWalrus = Array.from(root.querySelectorAll('[data-message-role="assistant"]'))
                  .some((message) => message.innerText.toLowerCase().includes(${JSON.stringify(QUERY)}));
                return userHasWalrus && assistantHasWalrus;
              })()`,
              { timeoutMs: 60_000, label: "walrus appears in user and assistant messages in session A" },
            );
            const settleStarted = await ctx.eval("Date.now()");
            await ctx.waitFor(`Date.now() - ${settleStarted} >= 1500`, {
              timeoutMs: 3_000,
              label: "session A transcript settled",
            });
            await ctx.expectNoText("Something went wrong");
          },
          screenshot: {
            name: "split-find-seeded-session-a",
            requireText: ["walrus"],
          },
        });
      },
    },
    {
      name: "Open session B and split session A beside it",
      run: async (ctx) => {
        await ctx.prove("Split screen shows B as the primary pane and A as the split pane", {
          claim: "Creating a second session and opening session A in split view mounts exactly two session surfaces: B first and A second.",
          voiceover:
            "Next I create a second, empty conversation and use the tab strip to open the first one in split view. The app now shows two live transcript panes side by side: the new session first, and the walrus session beside it.",
          action: async () => {
            const previous = await currentRouteSessionId(ctx);
            await ctx.control("session.create_task");
            sessionB = await waitForNewRouteSessionId(ctx, previous, "session B id in route");
            ctx.assert(Boolean(sessionB), "No session B id was captured from the route.");
            ctx.assert(sessionB !== sessionA, `Expected session B to differ from session A, saw ${sessionB}.`);

            // Idempotence: a previous run may have left a split pane open.
            const closedStaleSplit = await ctx.eval(`(() => {
              const button = document.querySelector('button[aria-label="Close split"]');
              if (!button) return false;
              button.click();
              return true;
            })()`);
            if (closedStaleSplit) {
              await ctx.waitFor(
                `document.querySelectorAll(${JSON.stringify(SURFACE)}).length === 1`,
                { label: "stale split pane to close" },
              );
            }

            // Target session A's tab specifically: the tab strip persists
            // tabs from earlier sessions, so "first enabled split button"
            // could split a stale session.
            const clicked = await ctx.eval(`(() => {
              const tab = document.querySelector('[data-session-tab-id=${JSON.stringify(sessionA)}]');
              if (!tab) return { ok: false, reason: "tab for session A not found" };
              const button = tab.querySelector('button[aria-label="Open in split view"]');
              if (!button || button.disabled) return { ok: false, reason: "split button missing or disabled" };
              button.click();
              return { ok: true };
            })()`);
            ctx.assert(clicked.ok, `Could not split session A's tab: ${JSON.stringify(clicked)}.`);
          },
          assert: async () => {
            const ids = await ctx.waitFor(
              `(() => {
                const ids = ${surfaceStateExpression()};
                return ids.length === 2 ? ids : null;
              })()`,
              { timeoutMs: 30_000, label: "two split-screen session surfaces" },
            );
            ctx.assert(ids.includes(sessionA) && ids.includes(sessionB), `Expected panes ${sessionA} and ${sessionB}, saw ${ids.join(", ")}.`);
            ctx.assert(ids[0] === sessionB && ids[1] === sessionA, `Expected DOM order B then A, saw ${ids.join(", ")}.`);
          },
          screenshot: {
            name: "split-find-two-panes",
          },
        });
      },
    },
    {
      name: "Cmd/Ctrl+F opens exactly one find bar",
      run: async (ctx) => {
        await ctx.prove("Only one split-screen pane claims the find shortcut", {
          claim: "Pressing Cmd/Ctrl+F in split-screen renders exactly one Find in conversation bar, not one per mounted session surface.",
          voiceover:
            "With both panes visible, I press the find shortcut. The important fix is visible immediately: only one compact find bar appears, so the two panes no longer compete with duplicate search chrome.",
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
            await ctx.waitFor(
              `document.querySelectorAll(${JSON.stringify(FIND_INPUT)}).length === 1`,
              { timeoutMs: 10_000, label: "one find input after shortcut" },
            );
          },
          assert: async () => {
            const state = await ctx.eval(`(() => {
              const inputs = Array.from(document.querySelectorAll(${JSON.stringify(FIND_INPUT)}));
              const root = inputs[0] ? inputs[0].closest(${JSON.stringify(SURFACE)}) : null;
              return {
                count: inputs.length,
                scopedCount: document.querySelectorAll('[data-session-surface-id] input[aria-label="Find in conversation"]').length,
                owner: root ? root.getAttribute('data-session-surface-id') : null,
              };
            })()`);
            ctx.assert(state.count === 1, `Expected one find input, saw ${state.count}.`);
            ctx.assert(state.scopedCount === 1, `Expected one pane-scoped find input, saw ${state.scopedCount}.`);
            ctx.assert(Boolean(state.owner), "The single find input was not inside a session surface.");
            ctx.log(`find owner after shortcut: ${state.owner}`);
          },
          screenshot: {
            name: "split-find-one-bar",
          },
        });
      },
    },
    {
      name: "Clicking the split pane makes Cmd/Ctrl+F target it",
      run: async (ctx) => {
        await ctx.prove("Interacting with pane A scopes find and highlights only pane A", {
          claim: "After clicking the split pane, Cmd/Ctrl+F opens the bar inside session A; typing 'walrus' highlights A and leaves session B unmarked.",
          voiceover:
            "Now I click inside the split pane that contains the walrus conversation and press the same shortcut again. The find bar moves to that pane, the walrus matches highlight there, and the empty pane stays completely unmarked.",
          action: async () => {
            await closeFindBarIfOpen(ctx);
            const clickedPane = await ctx.eval(`(() => {
              const root = Array.from(document.querySelectorAll(${JSON.stringify(SURFACE)}))
                .find((candidate) => candidate.getAttribute('data-session-surface-id') === ${JSON.stringify(sessionA)});
              if (!root) return false;
              const target = root.querySelector('[data-message-role]') || root;
              target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
              target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
              target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
              return true;
            })()`);
            ctx.assert(clickedPane, `Could not dispatch pointer events inside split pane ${sessionA}.`);
            await ctx.eval(`(() => {
              window.dispatchEvent(new KeyboardEvent("keydown", {
                key: "f",
                metaKey: true,
                ctrlKey: true,
                bubbles: true,
              }));
              return true;
            })()`);
            await ctx.waitFor(
              `(() => {
                const pane = ${paneMatchStateExpression(sessionA)};
                return pane.input && document.querySelectorAll(${JSON.stringify(FIND_INPUT)}).length === 1;
              })()`,
              { timeoutMs: 10_000, label: "find input owned by split pane A" },
            );
            await ctx.fill(FIND_INPUT, QUERY);
            await ctx.waitFor(
              `(() => {
                const paneA = ${paneMatchStateExpression(sessionA)};
                const paneB = ${paneMatchStateExpression(sessionB)};
                return paneA.marks >= 2 && paneB.marks === 0 && paneA.counter.startsWith("1/");
              })()`,
              { timeoutMs: 10_000, label: "walrus highlights only in pane A" },
            );
          },
          assert: async () => {
            const paneA = await ctx.eval(paneMatchStateExpression(sessionA));
            const paneB = await ctx.eval(paneMatchStateExpression(sessionB));
            ctx.assert(paneA.input, `Find input is not inside split pane ${sessionA}.`);
            ctx.assert(paneA.marks >= 2, `Expected at least two pane A highlights, saw ${paneA.marks}.`);
            ctx.assert(paneB.marks === 0, `Expected pane B to have zero highlights, saw ${paneB.marks}.`);
            ctx.assert(paneA.counter.startsWith("1/"), `Expected pane A counter to start with 1/, saw '${paneA.counter}'.`);
          },
          screenshot: {
            name: "split-find-pane-a-highlighted",
            requireText: ["walrus"],
          },
        });
      },
    },
    {
      name: "Escape closes find and clears both panes",
      run: async (ctx) => {
        await ctx.prove("Escape removes the pane-owned find state everywhere", {
          claim: "Pressing Escape closes the only find bar and clears all search highlight marks from both split-screen panes.",
          voiceover:
            "Finally I close find with Escape. The search chrome disappears and every highlight is gone across both panes, leaving split-screen clean again.",
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
              { timeoutMs: 10_000, label: "no find inputs and no highlights" },
            );
          },
          assert: async () => {
            const state = await ctx.eval(`(() => ({
              inputs: document.querySelectorAll(${JSON.stringify(FIND_INPUT)}).length,
              marks: document.querySelectorAll(${JSON.stringify(HIGHLIGHT)}).length,
            }))()`);
            ctx.assert(state.inputs === 0, `Expected zero find inputs, saw ${state.inputs}.`);
            ctx.assert(state.marks === 0, `Expected zero highlights, saw ${state.marks}.`);
          },
          screenshot: {
            name: "split-find-closed-cleared",
            rejectText: ["No matches"],
          },
        });
      },
    },
  ],
};
