import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/chat-no-empty-message-placeholder.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("chat-no-empty-message-placeholder");

const PROMPT = "Reply with exactly: empty-message-probe ok";
const REPLY = "empty-message-probe ok";

async function closeStaleDialogs(ctx) {
  await ctx.eval(`(() => {
    for (let index = 0; index < 3; index += 1) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }
    const active = document.activeElement;
    if (active && typeof active.blur === "function") active.blur();
    return true;
  })()`);
}

async function bootPrecondition(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", {
    timeoutMs: 60_000,
    label: "control API",
  });
  await closeStaleDialogs(ctx);
  const state = await ctx.waitFor(
    `(() => {
      const control = window.__openworkControl;
      const route = String(control.snapshot().route || "");
      if (route.startsWith("/welcome") || route.startsWith("/signin")) return "blocked";
      const action = control.listActions().find((item) => item.id === "session.create_task");
      if (action && !action.disabled) return "ready";
      return null;
    })()`,
    { timeoutMs: 30_000, label: "session.create_task enabled (or welcome/signin)" },
  );
  return state === "blocked"
    ? "Profile is not onboarded (welcome/signin); chat placeholder flow requires a workspace."
    : null;
}

async function waitForActiveSessionId(ctx) {
  return ctx.waitFor(
    `(() => {
      const route = String(window.__openworkControl.snapshot().route || "");
      const match = route.match(/ses_[A-Za-z0-9]+/);
      return match ? match[0] : null;
    })()`,
    { timeoutMs: 30_000, label: "active session id in route" },
  );
}

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
  const ran = await ctx.eval(`(() => {
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
  ctx.assert(ran !== "none", "Could not submit the composer message.");
  ctx.log(`submit: ${ran}`);
  return ran;
}

async function installEmptyMessageProbe(ctx) {
  const seen = await ctx.eval(`(() => {
    if (window.__emptyMessageProbeObserver) window.__emptyMessageProbeObserver.disconnect();
    window.__emptyMessageProbe = { seen: false };
    const check = () => {
      if (document.body.innerText.includes("Empty message")) window.__emptyMessageProbe.seen = true;
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    window.__emptyMessageProbeObserver = observer;
    check();
    return window.__emptyMessageProbe.seen;
  })()`);
  ctx.assert(seen === false, "The page already contained the literal Empty message placeholder before submit.");
}

async function readEmptyMessageProbe(ctx) {
  return ctx.eval(`(() => ({
    seen: Boolean(window.__emptyMessageProbe?.seen),
    bodyHasEmptyMessage: document.body.innerText.includes("Empty message"),
  }))()`);
}

async function hoverAssistantReply(ctx) {
  const point = await ctx.eval(`(() => {
    const message = Array.from(document.querySelectorAll('[data-message-role="assistant"]'))
      .find((candidate) => candidate.innerText.includes(${JSON.stringify(REPLY)}));
    if (!message) return null;
    message.scrollIntoView({ block: "center", inline: "center" });
    const rect = message.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (point) {
    await ctx.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  }
}

export default {
  id: "chat-no-empty-message-placeholder",
  title: "Sending a prompt never shows Empty message placeholder debris",
  kind: "user-facing",
  precondition: bootPrecondition,
  steps: [
    {
      name: "Fresh task is ready for chat",
      run: async (ctx) => {
        await ctx.prove("A fresh task opens on a real session route", {
          voiceover: vo[0],
          action: async () => {
            await closeStaleDialogs(ctx);
            await ctx.control("session.create_task");
          },
          assert: async () => {
            const sessionId = await waitForActiveSessionId(ctx);
            ctx.assert(Boolean(sessionId), "No active session id after create_task.");
            ctx.log(`active session: ${sessionId}`);
          },
          screenshot: { name: "fresh-task", hashIncludes: "ses_", rejectText: ["Something went wrong"] },
        });
      },
    },
    {
      name: "Prompt submits without placeholder flash",
      run: async (ctx) => {
        await ctx.prove("The submit window is continuously watched and never shows Empty message", {
          voiceover: vo[1],
          action: async () => {
            await installEmptyMessageProbe(ctx);
            const pasted = await pasteComposer(ctx, PROMPT);
            ctx.assert(pasted?.ok, `Composer not ready: ${pasted?.reason ?? "unknown"}`);
            await submitComposer(ctx);
          },
          assert: async () => {
            await ctx.waitForText(PROMPT, { timeoutMs: 30_000 });
            await ctx.waitFor(
              `(() => Array.from(document.querySelectorAll('[data-message-role="user"]'))
                .some((message) => message.innerText.includes(${JSON.stringify(PROMPT)})))()`,
              { timeoutMs: 30_000, label: "submitted user bubble" },
            );
            const probe = await readEmptyMessageProbe(ctx);
            ctx.assert(probe?.seen === false, "The Empty message placeholder appeared during submit.");
            await ctx.expectNoText("Empty message");
            ctx.log(`empty message probe after submit: ${JSON.stringify(probe)}`);
          },
          screenshot: {
            name: "submitted-without-empty-placeholder",
            requireText: [PROMPT],
            rejectText: ["Empty message", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Completed reply stays clean",
      run: async (ctx) => {
        await ctx.prove("The completed transcript has the reply and still no placeholder text", {
          voiceover: vo[2],
          action: async () => {
            await ctx.waitFor(
              `(() => Array.from(document.querySelectorAll('[data-message-role="assistant"]'))
                .some((message) => message.innerText.includes(${JSON.stringify(REPLY)})))()`,
              { timeoutMs: 90_000, label: "assistant reply text" },
            );
            await hoverAssistantReply(ctx);
          },
          assert: async () => {
            await ctx.waitForText(REPLY, { timeoutMs: 90_000 });
            const probe = await readEmptyMessageProbe(ctx);
            ctx.assert(probe?.seen === false, "The Empty message placeholder appeared before the reply completed.");
            ctx.assert(probe?.bodyHasEmptyMessage === false, "document.body still contains Empty message.");
            await ctx.expectNoText("Empty message");
            ctx.log(`empty message probe final: ${JSON.stringify(probe)}`);
            ctx.output("empty-message-probe", JSON.stringify(probe, null, 2));
          },
          screenshot: {
            name: "reply-complete-no-empty-placeholder",
            requireText: [REPLY],
            rejectText: ["Empty message", "Something went wrong"],
          },
        });
      },
    },
  ],
};
