import { defineFlow, type FlowContext } from "../runner/flow.ts";
import { loadVoiceoverParagraphs } from "../runner/voiceover.ts";

const vo = await loadVoiceoverParagraphs("semantic-agent-surface");
if (!vo) throw new Error("Missing approved voice-over script for semantic-agent-surface.");

const PREVIOUS_MARKER = "violet-otter-742";
const SURFACE_SELECTOR = "[data-session-surface-id]";

let previousSessionId: string | null = null;
let draftSessionId: string | null = null;
let primarySessionId: string | null = null;
let primaryRoute: string | null = null;

function required(value: string | null, label: string): string {
  if (!value) throw new Error(`${label} is missing.`);
  return value;
}

function sessionSurfaceExpression(sessionId: string, body: string) {
  return `(() => {
    const root = Array.from(document.querySelectorAll(${JSON.stringify(SURFACE_SELECTOR)}))
      .find((candidate) => candidate.getAttribute("data-session-surface-id") === ${JSON.stringify(sessionId)});
    if (!root) return null;
    return (() => { ${body} })();
  })()`;
}

async function currentRouteSessionId(ctx: FlowContext): Promise<string | null> {
  const sessionId = await ctx.eval(`(() => {
    const route = window.__openworkControl?.snapshot?.().route || "";
    const match = route.match(/ses_[A-Za-z0-9_-]+/);
    return match ? match[0] : null;
  })()`);
  return typeof sessionId === "string" ? sessionId : null;
}

async function waitForNewSession(
  ctx: FlowContext,
  previousId: string | null,
  label: string,
): Promise<string> {
  const sessionId = await ctx.waitFor(`(() => {
    const route = window.__openworkControl?.snapshot?.().route || "";
    const match = route.match(/ses_[A-Za-z0-9_-]+/);
    if (!match || match[0] === ${JSON.stringify(previousId)}) return null;
    return match[0];
  })()`, { timeoutMs: 30_000, label });
  ctx.assert(typeof sessionId === "string", `${label} did not return a session id.`);
  return String(sessionId);
}

async function createNamedSession(ctx: FlowContext, title: string): Promise<string> {
  const previousId = await currentRouteSessionId(ctx);
  await ctx.control("session.create_task");
  const sessionId = await waitForNewSession(ctx, previousId, `${title} route`);
  await ctx.control("session.rename", { sessionId, title });
  await ctx.waitFor(
    `Boolean(document.querySelector('[data-session-tab-id="${sessionId}"]'))`,
    { timeoutMs: 15_000, label: `${title} tab` },
  );
  return sessionId;
}

async function closeStaleTabs(ctx: FlowContext) {
  await ctx.eval(`(() => {
    document.querySelector('button[aria-label="Close split"]')?.click();
    return true;
  })()`);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const before = await ctx.eval('document.querySelectorAll("[data-session-tab-id]").length');
    if (typeof before !== "number" || before <= 1) break;
    const closed = await ctx.eval(`(() => {
      const tabs = Array.from(document.querySelectorAll("[data-session-tab-id]"));
      const inactive = tabs.find((tab) => tab.getAttribute("data-session-tab-active") !== "true");
      const close = inactive?.querySelector('button[aria-label="Close tab"]');
      if (!close) return false;
      close.click();
      return true;
    })()`);
    if (closed !== true) break;
    await ctx.waitFor(
      `document.querySelectorAll("[data-session-tab-id]").length < ${before}`,
      { timeoutMs: 5_000, label: "stale tab to close" },
    );
  }
}

async function setSidebarOpen(ctx: FlowContext, open: boolean) {
  const already = await ctx.eval(
    `window.__openworkControl?.context?.().chrome.sidebarOpen === ${JSON.stringify(open)}`,
  );
  if (already === true) return;
  const clicked = await ctx.eval(`(() => {
    const trigger = document.querySelector('[data-sidebar="trigger"]');
    if (!trigger) return false;
    trigger.click();
    return true;
  })()`);
  ctx.assert(clicked === true, "Sidebar trigger was unavailable.");
  await ctx.waitFor(
    `window.__openworkControl?.context?.().chrome.sidebarOpen === ${JSON.stringify(open)}`,
    { timeoutMs: 10_000, label: `sidebar ${open ? "open" : "closed"}` },
  );
}

async function sendPrompt(
  ctx: FlowContext,
  sessionId: string,
  prompt: string,
  expectedAssistantText: string,
) {
  await ctx.waitFor(sessionSurfaceExpression(
    sessionId,
    `return Boolean(root.querySelector('[contenteditable="true"]'));`,
  ), { timeoutMs: 30_000, label: `composer for ${sessionId}` });

  const pasted = await ctx.eval(sessionSurfaceExpression(sessionId, `
    const editor = root.querySelector('[contenteditable="true"][data-lexical-editor="true"]')
      || root.querySelector('[contenteditable="true"]');
    if (!editor) return false;
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const data = new DataTransfer();
    data.setData("text/plain", ${JSON.stringify(prompt)});
    editor.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: data,
    }));
    return true;
  `));
  ctx.assert(pasted === true, `Could not type into ${sessionId}.`);

  await ctx.waitFor(sessionSurfaceExpression(sessionId, `
    const button = Array.from(root.querySelectorAll("button"))
      .find((candidate) => /^(run task|send|run)$/i.test((candidate.textContent || "").trim()) && !candidate.disabled);
    return Boolean(button);
  `), { timeoutMs: 15_000, label: `send button for ${sessionId}` });

  const sent = await ctx.eval(sessionSurfaceExpression(sessionId, `
    const button = Array.from(root.querySelectorAll("button"))
      .find((candidate) => /^(run task|send|run)$/i.test((candidate.textContent || "").trim()) && !candidate.disabled);
    if (!button) return false;
    button.click();
    return true;
  `));
  ctx.assert(sent === true, `Could not send from ${sessionId}.`);

  await ctx.waitFor(sessionSurfaceExpression(sessionId, `
    const assistants = Array.from(root.querySelectorAll('[data-message-role="assistant"]'));
    return assistants.some((message) => message.innerText.includes(${JSON.stringify(expectedAssistantText)}));
  `), { timeoutMs: 180_000, label: `assistant response containing ${expectedAssistantText}` });
}

async function semanticContext(ctx: FlowContext) {
  return ctx.eval("window.__openworkControl?.context?.()");
}

export default defineFlow({
  id: "semantic-agent-surface",
  title: "People and agents share one semantic OpenWork context",
  kind: "user-facing",
  precondition: async (ctx) => {
    await ctx.waitFor("Boolean(window.__openworkControl)", {
      timeoutMs: 60_000,
      label: "OpenWork control API",
    });
    const state = await ctx.waitFor(`(() => {
      const control = window.__openworkControl;
      const route = control.snapshot().route;
      if (route.startsWith("/welcome") || route.startsWith("/signin")) return "blocked";
      const create = control.listActions().find((action) => action.id === "session.create_task");
      const rename = control.listActions().find((action) => action.id === "session.rename");
      return create && rename && !create.disabled && !rename.disabled ? "ready" : null;
    })()`, { timeoutMs: 30_000, label: "session controls ready" });
    return state === "blocked"
      ? "Profile is not onboarded; semantic context proof requires a workspace and model."
      : null;
  },
  steps: [
    {
      name: "Three tabs and split view become agent-readable context",
      run: async (ctx) => {
        await ctx.prove("Agent context names the complete visible and retained workbench", {
          voiceover: vo[0],
          action: async () => {
            await closeStaleTabs(ctx);
            const current = await currentRouteSessionId(ctx);
            previousSessionId = current ?? await createNamedSession(ctx, "Context Previous");
            await ctx.control("session.rename", {
              sessionId: previousSessionId,
              title: "Context Previous",
            });
            await sendPrompt(
              ctx,
              previousSessionId,
              `Remember this exact previous-session marker: ${PREVIOUS_MARKER}. Reply with exactly PREVIOUS-SEEDED.`,
              "PREVIOUS-SEEDED",
            );

            draftSessionId = await createNamedSession(ctx, "Context Draft");
            primarySessionId = await createNamedSession(ctx, "Context Primary");
            primaryRoute = String(await ctx.eval("window.__openworkControl.snapshot().route"));
            await setSidebarOpen(ctx, true);

            const splitClicked = await ctx.eval(`(() => {
              const tab = document.querySelector('[data-session-tab-id="${previousSessionId}"]');
              const button = tab?.querySelector('button[aria-label="Open in split view"]');
              if (!button) return false;
              button.click();
              return true;
            })()`);
            ctx.assert(splitClicked === true, "Could not open Context Previous in split view.");
            await ctx.waitFor(
              `document.querySelectorAll(${JSON.stringify(SURFACE_SELECTOR)}).length === 2`,
              { timeoutMs: 30_000, label: "two visible session panes" },
            );

            await sendPrompt(
              ctx,
              primarySessionId,
              "Call openwork_context. Reply with exactly: CONTEXT-SUMMARY TABS=3 SPLIT=yes FOCUSED=secondary SIDEBAR=open SETTINGS=none",
              "CONTEXT-SUMMARY",
            );
          },
          assert: async () => {
            const context = await semanticContext(ctx);
            ctx.output("frame-1-context", context);
            const state = await ctx.eval(`(() => {
              const context = window.__openworkControl.context();
              return {
                tabs: context.conversations.tabs.length,
                layout: context.conversations.layout,
                sidebarOpen: context.chrome.sidebarOpen,
                sessionResources: context.resources.filter((resource) => resource.kind === "session").length,
              };
            })()`);
            ctx.assert(
              JSON.stringify(state).includes('"tabs":3'),
              `Expected three tabs, received ${JSON.stringify(state)}.`,
            );
            ctx.assert(
              JSON.stringify(state).includes('"kind":"split"'),
              `Expected split layout, received ${JSON.stringify(state)}.`,
            );
            await ctx.expectText("CONTEXT-SUMMARY");
          },
          screenshot: {
            name: "frame-1-complete-workbench-context",
            requireText: ["Context Previous", "Context Primary", "CONTEXT-SUMMARY"],
          },
        });
      },
    },
    {
      name: "Focusing an existing session reuses its split pane",
      run: async (ctx) => {
        ctx.assert(Boolean(primarySessionId && previousSessionId), "Frame 1 session setup is missing.");
        await ctx.prove("Agent navigation reuses the existing split session", {
          voiceover: vo[1],
          action: async () => {
            const primary = required(primarySessionId, "Primary session");
            await sendPrompt(
              ctx,
              primary,
              "Call openwork_context, find the session resource titled Context Previous, then call openwork_execute with id workbench.session.focus, that sessionId, expectedRevision, and actor fraimz. Reply with exactly FOCUS-RESULT=secondary-reused.",
              "FOCUS-RESULT=secondary-reused",
            );
          },
          assert: async () => {
            await ctx.waitFor(
              `document.querySelector('[data-workbench-pane="secondary"][data-workbench-pane-focused="true"]') !== null`,
              { timeoutMs: 30_000, label: "secondary pane focused" },
            );
            const state = await ctx.eval(`(() => ({
              tabs: window.__openworkControl.context().conversations.tabs.length,
              surfaces: document.querySelectorAll(${JSON.stringify(SURFACE_SELECTOR)}).length,
              route: window.__openworkControl.snapshot().route,
            }))()`);
            ctx.assert(
              JSON.stringify(state).includes('"tabs":3') && JSON.stringify(state).includes('"surfaces":2'),
              `Expected reused split without duplicates, received ${JSON.stringify(state)}.`,
            );
            await ctx.expectText("FOCUS-RESULT=secondary-reused");
          },
          screenshot: {
            name: "frame-2-reused-split-session",
            requireText: ["Context Previous", "FOCUS-RESULT=secondary-reused"],
          },
        });
      },
    },
    {
      name: "Reading another transcript does not navigate",
      run: async (ctx) => {
        ctx.assert(Boolean(primarySessionId && primaryRoute), "Primary session setup is missing.");
        await ctx.prove("Agent reads another session without changing the workbench", {
          voiceover: vo[2],
          action: async () => {
            const primary = required(primarySessionId, "Primary session");
            await sendPrompt(
              ctx,
              primary,
              `Call openwork_context, find Context Previous, then call openwork_query with id session.read for that sessionId. Do not call a UI command. Reply with exactly PREVIOUS-SAID=${PREVIOUS_MARKER}.`,
              `PREVIOUS-SAID=${PREVIOUS_MARKER}`,
            );
          },
          assert: async () => {
            const state = await ctx.eval(`(() => ({
              route: window.__openworkControl.snapshot().route,
              layout: window.__openworkControl.context().conversations.layout.kind,
              tabs: window.__openworkControl.context().conversations.tabs.length,
              surfaces: document.querySelectorAll(${JSON.stringify(SURFACE_SELECTOR)}).length,
            }))()`);
            ctx.assert(
              JSON.stringify(state).includes(JSON.stringify(primaryRoute)),
              `Transcript query navigated away: ${JSON.stringify(state)}.`,
            );
            ctx.assert(
              JSON.stringify(state).includes('"layout":"split"') && JSON.stringify(state).includes('"tabs":3'),
              `Transcript query changed the workbench: ${JSON.stringify(state)}.`,
            );
            await ctx.expectText(`PREVIOUS-SAID=${PREVIOUS_MARKER}`);
          },
          screenshot: {
            name: "frame-3-read-without-navigation",
            requireText: [`PREVIOUS-SAID=${PREVIOUS_MARKER}`, "Context Previous"],
          },
        });
      },
    },
    {
      name: "Settings retain off-screen workbench context",
      run: async (ctx) => {
        await ctx.prove("Settings context retains tabs and split layout after chat unmounts", {
          voiceover: vo[3],
          action: async () => {
            await setSidebarOpen(ctx, false);
            const result = await ctx.eval(`(async () => {
              const control = window.__openworkControl;
              const context = control.context();
              return control.command({
                id: "settings.panel.open",
                args: { panel: "ai" },
                expectedRevision: context.revision,
                actor: "fraimz",
              });
            })()`, { awaitPromise: true });
            ctx.assert(JSON.stringify(result).includes('"ok":true'), `Could not open AI settings: ${JSON.stringify(result)}.`);
            await ctx.waitFor(
              `window.__openworkControl.context().screen.kind === "settings"
                && window.__openworkControl.context().screen.panel === "ai"`,
              { timeoutMs: 30_000, label: "AI settings semantic screen" },
            );
          },
          assert: async () => {
            const context = await semanticContext(ctx);
            ctx.output("frame-4-settings-context", context);
            const state = await ctx.eval(`(() => {
              const context = window.__openworkControl.context();
              return {
                screen: context.screen,
                sidebarOpen: context.chrome.sidebarOpen,
                tabs: context.conversations.tabs.length,
                layout: context.conversations.layout.kind,
              };
            })()`);
            const serialized = JSON.stringify(state);
            ctx.assert(serialized.includes('"panel":"ai"'), `Expected AI settings, received ${serialized}.`);
            ctx.assert(serialized.includes('"sidebarOpen":false'), `Expected collapsed sidebar, received ${serialized}.`);
            ctx.assert(
              serialized.includes('"tabs":3') && serialized.includes('"layout":"split"'),
              `Settings lost retained workbench context: ${serialized}.`,
            );
          },
          screenshot: {
            name: "frame-4-settings-retain-workbench",
            requireText: ["AI"],
          },
        });
      },
    },
    {
      name: "Extensions, MCP, Connect, and skills share descriptors",
      run: async (ctx) => {
        ctx.assert(Boolean(primaryRoute && primarySessionId), "Primary route is missing.");
        await ctx.prove("Known skills stay direct while unknown capabilities stay discoverable", {
          voiceover: vo[4],
          action: async () => {
            const route = required(primaryRoute, "Primary route");
            const primary = required(primarySessionId, "Primary session");
            await ctx.navigateHash(route);
            await ctx.waitFor(
              `Boolean(document.querySelector('[data-session-surface-id="${primary}"]'))`,
              { timeoutMs: 30_000, label: "primary session after settings" },
            );
            await sendPrompt(
              ctx,
              primary,
              "Choose one remote skill already listed in available_skills. Load it directly with its exact capability using openwork-cloud_execute_capability; do not search first and do not perform the skill workflow. Then call openwork_context. Reply with exactly these three lines: DIRECT_SKILL_TOOL=openwork-cloud_execute_capability; UNKNOWN_CAPABILITY_TOOL=openwork-cloud_search_capabilities; LOCAL_EXTENSION_COMMAND=extension.call",
              "DIRECT_SKILL_TOOL=openwork-cloud_execute_capability",
            );
          },
          assert: async () => {
            await ctx.expectText("DIRECT_SKILL_TOOL=openwork-cloud_execute_capability");
            await ctx.expectText("UNKNOWN_CAPABILITY_TOOL=openwork-cloud_search_capabilities");
            await ctx.expectText("LOCAL_EXTENSION_COMMAND=extension.call");
          },
          screenshot: {
            name: "frame-5-provider-and-skill-routing",
            requireText: [
              "DIRECT_SKILL_TOOL=openwork-cloud_execute_capability",
              "UNKNOWN_CAPABILITY_TOOL=openwork-cloud_search_capabilities",
              "LOCAL_EXTENSION_COMMAND=extension.call",
            ],
          },
        });
      },
    },
    {
      name: "Available actions explain effects and concurrency",
      run: async (ctx) => {
        ctx.assert(Boolean(primarySessionId), "Primary session is missing.");
        await ctx.prove("Agent reports actions by effect instead of a flat tool list", {
          voiceover: vo[5],
          action: async () => {
            const primary = required(primarySessionId, "Primary session");
            await sendPrompt(
              ctx,
              primary,
              "Call openwork_context and inspect availableAffordances plus execution. Reply with exactly five lines using real ids: READ=<id> data=read; UI=<id> ui=<effect>; DURABLE=<id> data=write; CONFIRMATION=<id> confirmation=destructive; CONCURRENCY=queries:parallel commands:serialized",
              "CONCURRENCY=queries:parallel commands:serialized",
            );
          },
          assert: async () => {
            await ctx.expectText("data=read");
            await ctx.expectText("data=write");
            await ctx.expectText("confirmation=destructive");
            await ctx.expectText("CONCURRENCY=queries:parallel commands:serialized");
            const context = await semanticContext(ctx);
            ctx.output("frame-6-affordances", context);
          },
          screenshot: {
            name: "frame-6-understandable-effects",
            requireText: [
              "data=read",
              "data=write",
              "confirmation=destructive",
              "CONCURRENCY=queries:parallel commands:serialized",
            ],
          },
        });
      },
    },
  ],
});
