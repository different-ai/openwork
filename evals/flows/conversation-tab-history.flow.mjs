import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "conversation-tab-history";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const state = {
  sessionIds: [],
  firstBoundary: null,
  lastBoundary: null,
};

export default {
  id: FLOW_ID,
  title: "Conversation tabs have browser-style Back and Forward history controls",
  kind: "user-facing",
  spec: "evals/voiceovers/conversation-tab-history.md",
  precondition: async (ctx) => {
    await ctx.waitFor("Boolean(window.__openworkControl)", {
      timeoutMs: 60_000,
      label: "control API",
    });
    const availability = await ctx.waitFor(
      `(() => {
        const control = window.__openworkControl;
        const action = control?.listActions?.().find((item) => item.id === "session.create_task");
        if (action && !action.disabled) return { ok: true };
        const route = control?.snapshot?.().route ?? "";
        const text = document.body.innerText;
        if (route.includes("welcome") || text.includes("Create or connect a workspace") || text.includes("Create workspace")) {
          return { ok: false, reason: "No workspace is available for conversation tabs; complete onboarding or create a workspace first." };
        }
        return null;
      })()`,
      { timeoutMs: 60_000, label: "workspace with enabled task creation" },
    ).catch(() => null);
    if (!availability?.ok) {
      return availability?.reason ?? "session.create_task did not become available; complete onboarding and ensure the selected workspace is healthy.";
    }
  },
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("Several conversations open as flat, shadowless tabs", {
          voiceover: vo[0],
          action: async () => {
            await ensureConversationTabs(ctx);
          },
          assert: async () => {
            const proof = await readTabStripState(ctx);
            ctx.assert(proof.tabCount >= 3, `Expected at least three conversation tabs, got ${proof.tabCount}`);
            ctx.assert(proof.hasBackButton, "Back history button was missing from the tab strip.");
            ctx.assert(proof.hasForwardButton, "Forward history button was missing from the tab strip.");
            ctx.assert(proof.controlsBeforeTabs, "History controls were not at the leading edge of the conversation tab strip.");
            ctx.assert(proof.controlsOutsideTabScroller, "History controls should remain fixed while only conversation tabs scroll.");
            ctx.assert(proof.controlsVisible, "History controls were not visible in the viewport.");
            ctx.assert(!proof.tabClassText.includes("shadow"), `Conversation tab classes still include shadow styling: ${proof.tabClassText}`);
            ctx.assert(proof.activeBoxShadow === "none", `Active conversation tab still casts a shadow: ${proof.activeBoxShadow}`);
          },
          screenshot: {
            name: "conversation-tabs-flat-strip",
            claim: "Several conversations are open as flat tabs with Back and Forward controls leading the strip.",
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("Back returns through conversation selection history", {
          voiceover: vo[1],
          action: async () => {
            const ids = await ensureConversationTabs(ctx);
            await clickConversationTab(ctx, ids[0]);
            await clickConversationTab(ctx, ids[1]);
            await clickConversationTab(ctx, ids[2]);
            await clickHistoryButton(ctx, "back", ids[1]);
          },
          assert: async () => {
            const ids = await ensureConversationTabs(ctx);
            const proof = await readTabStripState(ctx);
            ctx.assert(proof.currentSessionId === ids[1], `Back should have returned to the previous conversation ${ids[1]}, got ${proof.currentSessionId}`);
            ctx.assert(proof.activeTabMatchesRoute, "The active tab did not match the route after Back navigation.");
            ctx.assert(proof.backDisabled === false, "Back should remain enabled with earlier history available.");
            ctx.assert(proof.forwardDisabled === false, "Forward should be enabled after going back.");
          },
          screenshot: {
            name: "conversation-history-back",
            claim: "Clicking Back returns to the previous conversation in the visit stack.",
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("Forward retraces the conversation history branch", {
          voiceover: vo[2],
          action: async () => {
            const ids = await ensureConversationTabs(ctx);
            await clickHistoryButton(ctx, "forward", ids[2]);
          },
          assert: async () => {
            const ids = await ensureConversationTabs(ctx);
            const proof = await readTabStripState(ctx);
            ctx.assert(proof.currentSessionId === ids[2], `Forward should have returned to ${ids[2]}, got ${proof.currentSessionId}`);
            ctx.assert(proof.activeTabMatchesRoute, "The active tab did not match the route after Forward navigation.");
            ctx.assert(proof.backDisabled === false, "Back should be enabled after retracing forward.");
            ctx.assert(proof.forwardDisabled === true, "Forward should be disabled at the end of the history stack.");
          },
          screenshot: {
            name: "conversation-history-forward",
            claim: "Clicking Forward retraces the same conversation history branch without wrapping.",
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("Back and Forward disable at their history boundaries", {
          voiceover: vo[3],
          action: async () => {
            await ensureConversationTabs(ctx);
            state.firstBoundary = await clickUntilHistoryBoundary(ctx, "back");
            state.lastBoundary = await clickUntilHistoryBoundary(ctx, "forward");
            await clickUntilHistoryBoundary(ctx, "back");
          },
          assert: async () => {
            ctx.assert(state.firstBoundary?.backDisabled === true, `Back was not disabled at the first history entry: ${JSON.stringify(state.firstBoundary)}`);
            ctx.assert(state.firstBoundary?.forwardDisabled === false, "Forward should be enabled from the first history entry.");
            ctx.assert(state.lastBoundary?.forwardDisabled === true, `Forward was not disabled at the last history entry: ${JSON.stringify(state.lastBoundary)}`);
            ctx.assert(state.lastBoundary?.backDisabled === false, "Back should be enabled from the last history entry.");
          },
          screenshot: {
            name: "conversation-history-boundary-disabled",
            claim: "The history controls disable exactly at the beginning and end of the conversation visit stack.",
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
  ],
};

async function ensureConversationTabs(ctx) {
  if (state.sessionIds.length >= 3) {
    await waitForConversationTabs(ctx, state.sessionIds);
    return state.sessionIds;
  }

  await ctx.waitFor("Boolean(window.__openworkControl)", {
    timeoutMs: 60_000,
    label: "control API",
  });
  await ctx.waitFor(
    "window.__openworkControl.listActions().some((action) => action.id === 'session.create_task' && !action.disabled)",
    { timeoutMs: 60_000, label: "enabled session.create_task action" },
  );

  let previousSessionId = await currentSessionId(ctx);
  const sessionIds = [];
  for (let index = 0; index < 3; index += 1) {
    await ctx.control("session.create_task");
    const sessionId = await waitForNewSession(ctx, previousSessionId);
    sessionIds.push(sessionId);
    previousSessionId = sessionId;
  }

  state.sessionIds = sessionIds;
  await waitForConversationTabs(ctx, sessionIds);
  return state.sessionIds;
}

async function waitForNewSession(ctx, previousSessionId) {
  const previous = previousSessionId ?? "";
  return ctx.waitFor(
    `(() => {
      const id = currentRouteSessionId();
      return id && id !== ${JSON.stringify(previous)} ? id : null;
      function currentRouteSessionId() {
        const route = window.__openworkControl?.snapshot?.().route ?? window.location.hash ?? "";
        const match = new RegExp("(?:^|/)session/([^/?#]+)").exec(route);
        return match ? decodeURIComponent(match[1]) : null;
      }
    })()`,
    { timeoutMs: 30_000, label: "new session route" },
  );
}

async function currentSessionId(ctx) {
  return ctx.eval(`(() => {
    const route = window.__openworkControl?.snapshot?.().route ?? window.location.hash ?? "";
    const match = new RegExp("(?:^|/)session/([^/?#]+)").exec(route);
    return match ? decodeURIComponent(match[1]) : null;
  })()`);
}

async function waitForConversationTabs(ctx, sessionIds) {
  await ctx.waitFor(
    `(() => {
      const expectedIds = ${JSON.stringify(sessionIds)};
      const tabs = Array.from(document.querySelectorAll("[data-session-tab-id]"));
      const hasTabs = expectedIds.every((id) => tabs.some((tab) => tab.getAttribute("data-session-tab-id") === id));
      const route = window.__openworkControl?.snapshot?.().route ?? window.location.hash ?? "";
      const match = new RegExp("(?:^|/)session/([^/?#]+)").exec(route);
      const currentSessionId = match ? decodeURIComponent(match[1]) : null;
      const active = document.querySelector('[data-session-tab-active="true"]');
      return hasTabs &&
        active?.getAttribute("data-session-tab-id") === currentSessionId &&
        Boolean(document.querySelector('[data-conversation-history-control="back"]')) &&
        Boolean(document.querySelector('[data-conversation-history-control="forward"]'));
    })()`,
    { timeoutMs: 30_000, label: "conversation tabs and history controls" },
  );
}

async function clickConversationTab(ctx, sessionId) {
  const clicked = await ctx.eval(`(() => {
    const tab = Array.from(document.querySelectorAll("[data-session-tab-id]"))
      .find((item) => item.getAttribute("data-session-tab-id") === ${JSON.stringify(sessionId)});
    const button = tab?.querySelector("button");
    if (!button) return false;
    button.scrollIntoView({ block: "nearest", inline: "center" });
    button.click();
    return true;
  })()`);
  ctx.assert(clicked === true, `Could not click conversation tab ${sessionId}`);
  await waitForSession(ctx, sessionId);
}

async function clickHistoryButton(ctx, direction, expectedSessionId) {
  const clicked = await ctx.eval(`(() => {
    const button = document.querySelector(${JSON.stringify(`[data-conversation-history-control="${direction}"]`)});
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  ctx.assert(clicked === true, `Could not click enabled ${direction} history button.`);
  await waitForSession(ctx, expectedSessionId);
}

async function waitForSession(ctx, sessionId) {
  await ctx.waitFor(
    `(() => {
      const route = window.__openworkControl?.snapshot?.().route ?? window.location.hash ?? "";
      const match = new RegExp("(?:^|/)session/([^/?#]+)").exec(route);
      const currentSessionId = match ? decodeURIComponent(match[1]) : null;
      const active = document.querySelector('[data-session-tab-active="true"]');
      return currentSessionId === ${JSON.stringify(sessionId)} && active?.getAttribute("data-session-tab-id") === currentSessionId;
    })()`,
    { timeoutMs: 15_000, label: `session route ${sessionId}` },
  );
}

async function clickUntilHistoryBoundary(ctx, direction) {
  for (let index = 0; index < 12; index += 1) {
    const stateBeforeClick = await readTabStripState(ctx);
    if (direction === "back" && stateBeforeClick.backDisabled) return stateBeforeClick;
    if (direction === "forward" && stateBeforeClick.forwardDisabled) return stateBeforeClick;
    const beforeSessionId = stateBeforeClick.currentSessionId;
    const clicked = await ctx.eval(`(() => {
      const button = document.querySelector(${JSON.stringify(`[data-conversation-history-control="${direction}"]`)});
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`);
    ctx.assert(clicked === true, `Could not click ${direction} while walking to the history boundary.`);
    await ctx.waitFor(
      `(() => {
        const route = window.__openworkControl?.snapshot?.().route ?? window.location.hash ?? "";
        const match = new RegExp("(?:^|/)session/([^/?#]+)").exec(route);
        const id = match ? decodeURIComponent(match[1]) : null;
        const active = document.querySelector('[data-session-tab-active="true"]');
        return id && id !== ${JSON.stringify(beforeSessionId)} && active?.getAttribute("data-session-tab-id") === id;
      })()`,
      { timeoutMs: 15_000, label: `${direction} history route change` },
    );
  }
  return readTabStripState(ctx);
}

async function readTabStripState(ctx) {
  return ctx.eval(`(() => {
    const route = window.__openworkControl?.snapshot?.().route ?? window.location.hash ?? "";
    const match = new RegExp("(?:^|/)session/([^/?#]+)").exec(route);
    const currentSessionId = match ? decodeURIComponent(match[1]) : null;
    const tabs = Array.from(document.querySelectorAll("[data-session-tab-id]"));
    const back = document.querySelector('[data-conversation-history-control="back"]');
    const forward = document.querySelector('[data-conversation-history-control="forward"]');
    const controls = back?.closest('[aria-label="Conversation history controls"]') ?? null;
    const firstTab = tabs[0] ?? null;
    const tabScroller = firstTab?.parentElement ?? null;
    const active = tabs.find((tab) => tab.getAttribute("data-session-tab-id") === currentSessionId) ?? null;
    const tabClassText = tabs.map((tab) => tab.getAttribute("class") ?? "").join(" ");
    const controlsRect = controls?.getBoundingClientRect();
    return {
      currentSessionId,
      tabCount: tabs.length,
      hasBackButton: Boolean(back),
      hasForwardButton: Boolean(forward),
      backDisabled: back ? back.disabled === true : null,
      forwardDisabled: forward ? forward.disabled === true : null,
      controlsBeforeTabs: Boolean(controls && firstTab && (controls.compareDocumentPosition(firstTab) & Node.DOCUMENT_POSITION_FOLLOWING)),
      controlsOutsideTabScroller: Boolean(controls && tabScroller && !tabScroller.contains(controls)),
      controlsVisible: Boolean(controlsRect && controlsRect.left >= 0 && controlsRect.right <= window.innerWidth),
      activeTabMatchesRoute: active?.getAttribute("data-session-tab-id") === currentSessionId,
      tabClassText,
      activeBoxShadow: active ? getComputedStyle(active).boxShadow : "missing-active-tab",
    };
  })()`);
}
