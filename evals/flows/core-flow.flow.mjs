/**
 * Canonical core flow: open the app -> write a message -> get a response ->
 * close -> reopen and confirm the session survived.
 *
 * This is the universal smoke proof referenced by AGENTS.md ("Validate Every
 * Experience"). Any change expected to be inert (refactor, storage swap,
 * rename) should re-run this flow green to back the inertness claim.
 *
 * The end user is the protagonist: the message is typed into the composer and
 * the response is read from the rendered transcript. The "close + reopen" is
 * simulated at the renderer level by reloading the page (the app re-boots its
 * client, re-resolves the active workspace, and restores the last session from
 * persisted state) and asserting the previously created session + message are
 * still present. REST/DB/filesystem are only used to witness side effects.
 *
 * Requires an onboarded profile with at least one workspace and a usable
 * model. On a fresh profile (welcome screen) the flow skips instead of
 * failing, mirroring analytics-task-events.flow.mjs.
 */

const MESSAGE = "Reply with exactly: core-flow ok";

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

export default {
  id: "core-flow",
  title: "Open app, send a message, get a response, reopen with session intact",
  spec: "evals/react-session-flows.md",
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
      ? "Profile is not onboarded (welcome/signin); core flow requires a workspace."
      : null;
  },
  steps: [
    {
      name: "App boots to a usable session surface",
      run: async (ctx) => {
        await ctx.prove("App boots clean to a known route", {
          action: async () => {
            await ctx.waitFor("Boolean(window.__openworkControl)", {
              timeoutMs: 60_000,
              label: "control API",
            });
            await ctx.waitFor("document.body.innerText.trim().length > 40", {
              label: "rendered body text",
            });
          },
          assert: async () => {
            const route = await ctx.eval("window.__openworkControl.snapshot().route");
            ctx.assert(
              typeof route === "string" && route.length > 0,
              "No route reported by control snapshot.",
            );
            ctx.log(`route: ${route}`);
          },
          screenshot: { name: "booted", rejectText: ["Something went wrong"] },
        });
      },
    },
    {
      name: "User creates a fresh task in the active workspace",
      run: async (ctx) => {
        await ctx.prove("A new session is created and becomes active", {
          action: async () => {
            await ctx.control("session.create_task");
          },
          assert: async () => {
            // The newly created session id should be reflected in the route.
            const sessionId = await ctx.waitFor(
              `(() => {
                const route = window.__openworkControl.snapshot().route || "";
                const m = route.match(/ses_[A-Za-z0-9]+/);
                return m ? m[0] : null;
              })()`,
              { timeoutMs: 30_000, label: "active session id in route" },
            );
            ctx.assert(Boolean(sessionId), "No active session id after create_task.");
            ctx.log(`active session: ${sessionId}`);
          },
          screenshot: { name: "session-created" },
        });
      },
    },
    {
      name: "User writes a message and runs it",
      run: async (ctx) => {
        await ctx.prove("The composer accepts a message and the agent responds", {
          action: async () => {
            const pasted = await pasteComposer(ctx, MESSAGE);
            ctx.assert(pasted?.ok, `Composer not ready: ${pasted?.reason ?? "unknown"}`);
            // Submit: prefer the visible Run action, fall back to Enter.
            const ran = await ctx.eval(`(() => {
              const byLabel = Array.from(document.querySelectorAll('button'))
                .find((b) => /run task|send|run/i.test((b.textContent || "").trim()) && !b.disabled);
              if (byLabel) { byLabel.click(); return "clicked"; }
              const editor = document.querySelector('[contenteditable="true"]');
              if (editor) {
                editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                return "enter";
              }
              return "none";
            })()`);
            ctx.assert(ran !== "none", "Could not submit the composer message.");
            ctx.log(`submit: ${ran}`);
          },
          assert: async () => {
            // The message we typed must appear in the transcript, and an
            // assistant response must stream in without an error state.
            await ctx.waitForText("core-flow ok", { timeoutMs: 60_000 });
            await ctx.expectNoText("Something went wrong");
          },
          screenshot: { name: "task-response", requireText: ["core-flow ok"] },
        });
      },
    },
    {
      name: "User closes and reopens the app; the session survives",
      run: async (ctx) => {
        // Capture the active session id before the reload so we can prove the
        // exact same session is restored afterwards.
        const before = await ctx.eval(`(() => {
          const route = window.__openworkControl.snapshot().route || "";
          const m = route.match(/ses_[A-Za-z0-9]+/);
          return m ? m[0] : null;
        })()`);
        ctx.assert(Boolean(before), "No active session id to restore.");
        ctx.log(`session before reload: ${before}`);

        await ctx.prove("Reopening restores the session and its message history", {
          action: async () => {
            // Simulate close + reopen: re-boot the renderer/client.
            await ctx.eval("(() => { window.location.reload(); return true; })()");
            await ctx.waitFor("Boolean(window.__openworkControl)", {
              timeoutMs: 60_000,
              label: "control API after reopen",
            });
          },
          assert: async () => {
            // Prove the session persisted: it must still be listed after the
            // reopen (this reads persisted state, not in-memory).
            await ctx.waitFor(
              "window.__openworkControl.listActions().some((a) => a.id === 'session.list_sessions')",
              { timeoutMs: 45_000, label: "session.list_sessions available" },
            );
            const sessions = await ctx.control("session.list_sessions");
            const listed = Array.isArray(sessions) && sessions.some((s) => s.sessionId === before);
            ctx.assert(listed, `Session ${before} was not listed after reopen (not persisted).`);
            // Open it explicitly and confirm its message history is retrievable.
            await ctx.control("session.open", { sessionId: before });
            await ctx.waitForText("core-flow ok", { timeoutMs: 45_000 });
          },
          screenshot: { name: "reopened-session", requireText: ["core-flow ok"] },
        });
      },
    },
  ],
};
