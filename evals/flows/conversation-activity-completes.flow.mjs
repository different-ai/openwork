import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "conversation-activity-completes";
const REPLY = "conversation activity complete";
const PROMPT =
  `Run the command \`sleep 3; pwd\`, then reply with exactly: ${REPLY}`;
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const state = {
  sessionId: null,
};

function currentSessionIdExpression(previousSessionId = "") {
  return `(() => {
    const route = window.__openworkControl?.snapshot?.().route ?? window.location.hash ?? "";
    const match = /(?:^|\\/)session\\/([^/?#]+)/.exec(route);
    const sessionId = match ? decodeURIComponent(match[1]) : null;
    return sessionId && sessionId !== ${JSON.stringify(previousSessionId)} ? sessionId : null;
  })()`;
}

function activityIndicatorExpression(sessionId, present) {
  return `(() => {
    const row = document.querySelector(${JSON.stringify(
      `[data-sidebar-session-id="${sessionId}"]`,
    )});
    const indicator = row?.querySelector("[data-session-loading-indicator]");
    return ${present ? "Boolean(indicator)" : "!indicator"};
  })()`;
}

function assistantReplyExpression() {
  return `(() => Array
    .from(document.querySelectorAll('[data-message-role="assistant"]'))
    .some((element) => (element.textContent || "").includes(${JSON.stringify(REPLY)})))()`;
}

export default {
  id: FLOW_ID,
  title: "Conversation activity ends when the response completes",
  kind: "user-facing",
  spec: "evals/voiceovers/conversation-activity-completes.md",
  precondition: async (ctx) => {
    await ctx.waitFor("Boolean(window.__openworkControl)", {
      timeoutMs: 60_000,
      label: "control API",
    });
    const readiness = await ctx.waitFor(
      `(() => {
        const control = window.__openworkControl;
        const route = control.snapshot().route;
        if (route.startsWith("/welcome") || route.startsWith("/signin")) return "blocked";
        const create = control.listActions().find((action) => action.id === "session.create_task");
        return create && !create.disabled ? "ready" : null;
      })()`,
      {
        timeoutMs: 30_000,
        label: "session creation enabled or onboarding required",
      },
    );
    return readiness === "blocked"
      ? "Profile is not onboarded; this flow requires a workspace and usable model."
      : null;
  },
  steps: [
    {
      name: "The conversation shows activity while the response is running",
      run: async (ctx) => {
        await ctx.prove("The selected conversation shows left-lane activity during active work", {
          voiceover: vo[0],
          action: async () => {
            await ctx.control("session.create_task");
            state.sessionId = await ctx.waitFor(currentSessionIdExpression(), {
              timeoutMs: 30_000,
              label: "new conversation route",
            });
            await ctx.waitFor(
              "window.__openworkControl.listActions().some((action) => action.id === 'composer.set_text' && !action.disabled)",
              { timeoutMs: 30_000, label: "composer text action" },
            );
            await ctx.control("composer.set_text", { text: PROMPT });
            await ctx.waitFor(
              "window.__openworkControl.listActions().some((action) => action.id === 'composer.send' && !action.disabled)",
              { timeoutMs: 30_000, label: "composer send action" },
            );
            await ctx.control("composer.send");
            await ctx.waitFor(
              activityIndicatorExpression(state.sessionId, true),
              { timeoutMs: 30_000, label: "active conversation indicator" },
            );
          },
          assert: async () => {
            ctx.assert(Boolean(state.sessionId), "No active conversation was recorded.");
            const visible = await ctx.eval(
              activityIndicatorExpression(state.sessionId, true),
            );
            ctx.assert(visible === true, "The active conversation has no left activity indicator.");
          },
          screenshot: {
            name: "conversation-activity-running",
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "The indicator clears and remains clear after revisiting",
      run: async (ctx) => {
        await ctx.prove("Completed conversation activity stays cleared after navigation", {
          voiceover: vo[1],
          action: async () => {
            await ctx.waitFor(assistantReplyExpression(), {
              timeoutMs: 180_000,
              label: "completed assistant response",
            });
            await ctx.waitFor(
              activityIndicatorExpression(state.sessionId, false),
              { timeoutMs: 30_000, label: "cleared conversation indicator" },
            );

            await ctx.control("session.create_task");
            await ctx.waitFor(currentSessionIdExpression(state.sessionId), {
              timeoutMs: 30_000,
              label: "different conversation route",
            });
            await ctx.waitFor(
              "window.__openworkControl.listActions().some((action) => action.id === 'session.open' && !action.disabled)",
              { timeoutMs: 30_000, label: "open conversation action" },
            );
            await ctx.control("session.open", { sessionId: state.sessionId });
            await ctx.waitFor(
              `window.__openworkControl.snapshot().route.includes(${JSON.stringify(`/session/${state.sessionId}`)})`,
              { timeoutMs: 30_000, label: "completed conversation reopened" },
            );
          },
          assert: async () => {
            const replyVisible = await ctx.eval(assistantReplyExpression());
            ctx.assert(replyVisible === true, "The completed response is not visible after reopening.");
            const cleared = await ctx.eval(
              activityIndicatorExpression(state.sessionId, false),
            );
            ctx.assert(cleared === true, "The completed conversation activity indicator returned.");
            await ctx.expectNoText("Something went wrong");
          },
          screenshot: {
            name: "conversation-activity-complete",
            requireText: [REPLY],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
  ],
};
