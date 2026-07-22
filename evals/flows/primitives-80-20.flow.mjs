import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

// Narration is loaded from the approved script (evals/voiceovers/primitives-80-20.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("primitives-80-20");

const MARKDOWN_PROMPT = [
  "Reply with exactly this Markdown and no extra text:",
  "",
  "## Primitive Markdown Proof",
  "",
  "**Bold status:** renderer is live.",
  "",
  "Inline marker: `inlineToken`.",
  "",
  "```js",
  "console.log(\"primitive proof\");",
  "```",
  "",
  "[OpenWork docs](https://openwork.dev)",
].join("\n");
const MARKDOWN_TEXT_MARKERS = ["Primitive Markdown Proof", "inlineToken", "console.log", "OpenWork docs"];
const NEW_SESSION_PROMPT = "Reply with exactly: primitive cleanup response ok";
const NEW_SESSION_RESPONSE = "primitive cleanup response ok";
const ERROR_TEXT = [
  "Something went wrong",
  "Migration failed",
  "migration warning",
  "Unhandled Runtime Error",
  "Cannot read properties",
];

let bootState = null;
let markdownSessionId = null;
let createdSessionId = null;
let newSessionTranscript = null;
let settingsState = null;
let restartState = null;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function json(value) {
  return JSON.stringify(value);
}

function sessionIdFromRoute(route) {
  if (typeof route !== "string") return null;
  const match = route.match(/ses_[A-Za-z0-9_-]+/);
  return match ? match[0] : null;
}

function includesAll(text, markers) {
  return markers.every((marker) => text.includes(marker));
}

function actionExpression(actionId, enabled = true) {
  return `(() => {
    const action = window.__openworkControl?.listActions?.().find((item) => item.id === ${json(actionId)});
    if (!action) return false;
    return ${enabled ? "!action.disabled" : "true"};
  })()`;
}

async function waitForControl(ctx, label = "control API") {
  await ctx.waitFor("Boolean(window.__openworkControl)", {
    timeoutMs: 60_000,
    label,
  });
  await ctx.waitFor("window.__openworkControl.snapshot().status !== 'acting'", {
    timeoutMs: 30_000,
    label: `${label} idle`,
  });
}

async function waitForAction(ctx, actionId, { enabled = true, timeoutMs = 45_000 } = {}) {
  await ctx.waitFor(actionExpression(actionId, enabled), {
    timeoutMs,
    label: `${enabled ? "enabled " : "registered "}${actionId}`,
  });
}

async function dismissStaleOverlays(ctx) {
  await ctx.eval(`(() => {
    for (let index = 0; index < 2; index += 1) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }
    for (const button of Array.from(document.querySelectorAll("button, [role='button']"))) {
      const label = [
        button.getAttribute("aria-label"),
        button.getAttribute("title"),
        button.textContent,
      ].filter(Boolean).join(" ");
      if (/^(close|dismiss error)$/i.test(label.trim())) button.click();
    }
    return true;
  })()`);
}

async function routeSession(ctx) {
  await waitForControl(ctx);
  await dismissStaleOverlays(ctx);
  await ctx.control("route.session");
  await waitForControl(ctx, "control API after session route");
  await waitForAction(ctx, "session.list_sessions", { enabled: false });
}

async function waitForSessionState(ctx) {
  await waitForControl(ctx);
  return ctx.waitFor(`(() => {
    const route = window.__openwork?.slice?.("route");
    if (!route || route.loading) return null;
    if (!Array.isArray(route.workspaces) || route.workspaces.length === 0) return null;
    if (typeof route.selectedWorkspaceId !== "string" || !route.selectedWorkspaceId.trim()) return null;
    if (route.connected !== true || route.tokenPresent !== true) return null;
    return route;
  })()`, {
    timeoutMs: 45_000,
    label: "loaded route inspector state",
  });
}

async function selectedSessionId(ctx) {
  return ctx.eval(`(() => {
    const route = window.__openwork?.slice?.("route");
    if (typeof route?.selectedSessionId === "string" && route.selectedSessionId.trim()) return route.selectedSessionId;
    return (${sessionIdFromRoute.toString()})(window.__openworkControl?.snapshot?.().route || "");
  })()`);
}

async function waitForSelectedSessionId(ctx, previousSessionId, label = "selected session id") {
  return ctx.waitFor(`(() => {
    const previous = ${json(previousSessionId ?? "")};
    const route = window.__openwork?.slice?.("route");
    const selected = typeof route?.selectedSessionId === "string" ? route.selectedSessionId.trim() : "";
    if (selected && selected !== previous) return selected;
    const controlRoute = window.__openworkControl?.snapshot?.().route || "";
    const match = controlRoute.match(/ses_[A-Za-z0-9_-]+/);
    const routed = match ? match[0] : "";
    return routed && routed !== previous ? routed : null;
  })()`, {
    timeoutMs: 45_000,
    label,
  });
}

async function waitForSessionRoute(ctx, sessionId) {
  await ctx.waitFor(`(() => {
    const expected = ${json(sessionId)};
    const route = window.__openwork?.slice?.("route");
    if (route?.selectedSessionId === expected) return true;
    return (window.__openworkControl?.snapshot?.().route || "").includes(expected);
  })()`, {
    timeoutMs: 45_000,
    label: `session route ${sessionId}`,
  });
}

async function waitForComposer(ctx) {
  await waitForAction(ctx, "composer.set_text");
  await ctx.waitFor("Boolean(document.querySelector('[contenteditable=\"true\"]'))", {
    timeoutMs: 30_000,
    label: "composer editor",
  });
}

async function waitForSessionListed(ctx, sessionId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const sessions = await ctx.control("session.list_sessions");
    if (Array.isArray(sessions) && sessions.some((session) => session.sessionId === sessionId)) return sessions;
    await wait(250);
  }
  throw new Error(`Session ${sessionId} did not appear in the sidebar session list.`);
}

async function readTranscript(ctx, count = 30) {
  await waitForAction(ctx, "session.read_transcript", { enabled: false });
  return ctx.control("session.read_transcript", { count });
}

function transcriptMessages(transcript) {
  return Array.isArray(transcript?.messages) ? transcript.messages : [];
}

function transcriptHasRoleText(transcript, role, text) {
  return transcriptMessages(transcript).some((message) => (
    message?.role === role && typeof message.text === "string" && message.text.includes(text)
  ));
}

async function waitForAssistantResponseInTranscript(ctx, response, { timeoutMs = 120_000, count = 30 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastTranscript = null;
  let lastError = null;

  await waitForAction(ctx, "session.read_transcript", { enabled: false, timeoutMs: Math.min(timeoutMs, 45_000) });
  while (Date.now() < deadline) {
    try {
      const transcript = await readTranscript(ctx, count);
      lastTranscript = transcript;
      lastError = null;
      if (transcriptHasRoleText(transcript, "assistant", response)) return transcript;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await wait(500);
  }

  const summary = transcriptMessages(lastTranscript)
    .map((message) => `${message?.role ?? "unknown"}: ${String(message?.text ?? "").slice(0, 140)}`)
    .join(" | ");
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for an assistant transcript message containing ${JSON.stringify(response)}` +
      (lastError ? `; last error: ${lastError}` : "") +
      (summary ? `; transcript: ${summary}` : ""),
  );
}

function markdownDomInfoExpression() {
  return `(() => {
    const assistantMessages = Array.from(document.querySelectorAll('[data-message-role="assistant"]'));
    const proofMessage = assistantMessages.find((message) => ${json(MARKDOWN_TEXT_MARKERS)}.every((marker) => message.textContent.includes(marker)));
    if (!proofMessage) return { ok: false, reason: "assistant markdown proof message not visible", assistantMessages: assistantMessages.length };
    const codeBlock = proofMessage.querySelector('[data-openwork-code-block]');
    const inlineCode = Array.from(proofMessage.querySelectorAll('code')).find((code) => !code.closest('[data-openwork-code-block]') && code.textContent.includes('inlineToken'));
    const link = proofMessage.querySelector('a[data-openwork-link-href="https://openwork.dev"], a[href="https://openwork.dev/"]');
    const strong = Array.from(proofMessage.querySelectorAll('strong')).find((node) => node.textContent.includes('Bold status'));
    return {
      ok: Boolean(codeBlock && inlineCode && link && strong),
      reason: "markdown render inspection",
      hasCodeBlock: Boolean(codeBlock),
      codeText: codeBlock?.textContent || "",
      hasInlineCode: Boolean(inlineCode),
      inlineCodeText: inlineCode?.textContent || "",
      hasLink: Boolean(link),
      linkText: link?.textContent || "",
      linkHref: link?.getAttribute('href') || "",
      linkTarget: link?.getAttribute('target') || "",
      linkRel: link?.getAttribute('rel') || "",
      hasStrong: Boolean(strong),
      strongText: strong?.textContent || "",
    };
  })()`;
}

async function waitForMarkdownProof(ctx) {
  await ctx.waitFor(`(() => {
    const text = document.body.innerText;
    return ${json(MARKDOWN_TEXT_MARKERS)}.every((marker) => text.includes(marker));
  })()`, {
    timeoutMs: 120_000,
    label: "visible markdown proof text",
  });
  await ctx.waitFor(`(${markdownDomInfoExpression()}).ok`, {
    timeoutMs: 30_000,
    label: "canonical markdown/link/code DOM",
  });
}

async function openSession(ctx, sessionId) {
  await waitForAction(ctx, "session.open", { enabled: false });
  await ctx.control("session.open", { sessionId });
  await waitForSessionRoute(ctx, sessionId);
}

async function sessionHasMarkdownProof(ctx, sessionId) {
  await openSession(ctx, sessionId);
  await waitForAction(ctx, "session.read_transcript", { enabled: false });
  const transcript = await readTranscript(ctx).catch(() => null);
  const text = JSON.stringify(transcript ?? {});
  if (!includesAll(text, MARKDOWN_TEXT_MARKERS)) return false;
  const info = await ctx.eval(markdownDomInfoExpression()).catch(() => ({ ok: false }));
  return info?.ok === true;
}

async function ensureMarkdownProofSession(ctx) {
  await routeSession(ctx);
  const currentId = await selectedSessionId(ctx);
  const sessions = await ctx.control("session.list_sessions");
  const candidateIds = [];
  if (currentId) candidateIds.push(currentId);
  if (Array.isArray(sessions)) {
    for (const session of sessions) {
      if (session?.sessionId && !candidateIds.includes(session.sessionId)) candidateIds.push(session.sessionId);
    }
  }

  for (const sessionId of candidateIds.slice(0, 8)) {
    if (await sessionHasMarkdownProof(ctx, sessionId)) return sessionId;
  }

  const previousSessionId = await selectedSessionId(ctx);
  await waitForAction(ctx, "session.create_task");
  await ctx.control("session.create_task");
  const sessionId = await waitForSelectedSessionId(ctx, previousSessionId, "markdown proof session id");
  await waitForComposer(ctx);
  await ctx.control("composer.set_text", { text: MARKDOWN_PROMPT });
  await ctx.waitFor(`document.body.innerText.includes(${json("Primitive Markdown Proof")})`, {
    timeoutMs: 10_000,
    label: "markdown prompt visible in composer",
  });
  await waitForAction(ctx, "composer.send");
  await ctx.control("composer.send");
  await waitForMarkdownProof(ctx);
  await waitForSessionListed(ctx, sessionId);
  return sessionId;
}

async function assertNoVisibleErrors(ctx) {
  const text = await ctx.eval("document.body.innerText");
  for (const marker of ERROR_TEXT) {
    ctx.assert(!text.includes(marker), `Unexpected visible error text: ${marker}`);
  }
}

async function collectBootState(ctx) {
  const state = await waitForSessionState(ctx);
  const selectedWorkspace = state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId);
  const sessions = state.sessionsByWorkspaceId?.[state.selectedWorkspaceId] ?? [];
  return {
    route: windowRoute(state),
    baseUrl: state.baseUrl,
    connected: state.connected,
    tokenPresent: state.tokenPresent,
    selectedWorkspaceId: state.selectedWorkspaceId,
    selectedWorkspaceName: selectedWorkspace?.displayNameResolved ?? selectedWorkspace?.path ?? "workspace",
    sessionCount: Array.isArray(sessions) ? sessions.length : 0,
    routeError: state.routeError ?? null,
  };
}

function windowRoute(state) {
  return typeof state?.route === "string" ? state.route : "";
}

async function assertBootState(ctx, state) {
  ctx.assert(state.connected === true, `OpenWork server is not connected: ${JSON.stringify(state)}`);
  ctx.assert(state.tokenPresent === true, `OpenWork token is missing: ${JSON.stringify(state)}`);
  ctx.assert(Boolean(state.selectedWorkspaceId), `No selected workspace: ${JSON.stringify(state)}`);
  ctx.assert(state.routeError === null, `Route reported an error: ${JSON.stringify(state.routeError)}`);
  await ctx.expectText("Search sessions");
  await ctx.expectText("Add workspace");
  await assertNoVisibleErrors(ctx);
}

async function sendPromptAndWait(ctx, prompt, response) {
  await waitForComposer(ctx);
  await ctx.control("composer.set_text", { text: prompt });
  await ctx.waitFor(`document.body.innerText.includes(${json(prompt)})`, {
    timeoutMs: 10_000,
    label: "prompt visible in composer",
  });
  await waitForAction(ctx, "composer.send");
  await ctx.control("composer.send");
  return waitForAssistantResponseInTranscript(ctx, response);
}

async function openSettingsPanel(ctx, panel, requiredText) {
  await waitForControl(ctx);
  await dismissStaleOverlays(ctx);
  await waitForAction(ctx, "settings.panel.open", { enabled: false });
  await ctx.control("settings.panel.open", { panel });
  await ctx.waitFor(`window.__openworkControl.snapshot().route.includes(${json(`/settings/${panel}`)})`, {
    timeoutMs: 30_000,
    label: `${panel} settings route`,
  });
  await ctx.waitForText(requiredText, { timeoutMs: 45_000 });
}

async function inspectConnectSurface(ctx) {
  return ctx.eval(`(() => {
    const text = document.body.innerText;
    const route = window.__openworkControl?.snapshot?.().route || "";
    return {
      route,
      hasHeader: text.includes("Connect for teams"),
      hasDescription: text.includes("Use team-approved cloud connections"),
      hasAgentAccess: text.includes("Agent access"),
      hasOrganization: text.includes("From your organization"),
      hasPitch: text.includes("Connect is the new way"),
      hasSignin: text.includes("Sign in") || text.includes("Open browser"),
      hasLoading: text.includes("Loading Connect"),
    };
  })()`);
}

async function inspectExtensionsSurface(ctx) {
  return ctx.eval(`(() => {
    const text = document.body.innerText;
    const route = window.__openworkControl?.snapshot?.().route || "";
    return {
      route,
      hasExtensionsHeader: text.includes("Extensions (Legacy)") || text.includes("Extensions"),
      hasMyExtensions: text.includes("My Extensions"),
      hasMarketplace: text.includes("Marketplace"),
      hasRefresh: text.includes("Refresh"),
      hasAddApp: text.includes("Add App") || text.includes("Available apps") || text.includes("No apps connected yet"),
      hasConnectPath: text.includes("OpenWork Connect") || text.includes("Open Connect") || text.includes("Marketplace content now lives in Connect") || text.includes("My Extensions"),
    };
  })()`);
}

async function reloadRendererClient(ctx) {
  await ctx.eval("(() => { window.location.reload(); return true; })()");
  await waitForControl(ctx, "control API after renderer reload");
}

export default {
  id: "primitives-80-20",
  title: "Primitive cleanup leaves the user-facing OpenWork journey unchanged",
  kind: "user-facing",
  precondition: async (ctx) => {
    await waitForControl(ctx);
    const route = await ctx.eval("window.__openworkControl.snapshot().route || ''");
    if (route.startsWith("/welcome") || route.startsWith("/signin") || route.startsWith("/onboarding")) {
      return "Profile is not onboarded (welcome/signin/onboarding); primitives proof requires an existing workspace.";
    }
    await routeSession(ctx);
    const state = await ctx.waitFor(`(() => {
      const route = window.__openwork?.slice?.("route");
      if (!route || route.loading) return null;
      const action = window.__openworkControl.listActions().find((item) => item.id === "session.create_task");
      if (action && !action.disabled && route.connected && route.selectedWorkspaceId) return "ready";
      return null;
    })()`, {
      timeoutMs: 45_000,
      label: "usable workspace session route",
    });
    return state === "ready" ? null : "Session route did not become usable.";
  },
  steps: [
    {
      name: "Existing workspace boots cleanly",
      run: async (ctx) => {
        await ctx.prove("OpenWork lands on an existing workspace session surface with no migration or error warning", {
          voiceover: vo[0],
          action: async () => {
            await routeSession(ctx);
            await ctx.ensureLightMode();
            bootState = await collectBootState(ctx);
          },
          assert: async () => {
            ctx.assert(bootState !== null, "Boot state was not captured.");
            await assertBootState(ctx, bootState);
            ctx.log(`workspace ${bootState.selectedWorkspaceId} has ${bootState.sessionCount} listed sessions`);
          },
          screenshot: {
            name: "existing-workspace-session-surface",
            requireText: ["Search sessions", "Add workspace"],
            rejectText: ERROR_TEXT,
            hashIncludes: "/session",
          },
        });
      },
    },
    {
      name: "Conversation markdown renders through the supported path",
      run: async (ctx) => {
        await ctx.prove("A conversation opens with supported Markdown, link, and code-block rendering intact", {
          voiceover: vo[1],
          action: async () => {
            markdownSessionId = await ensureMarkdownProofSession(ctx);
            await openSession(ctx, markdownSessionId);
            await waitForMarkdownProof(ctx);
          },
          assert: async () => {
            ctx.assert(Boolean(markdownSessionId), "Markdown proof session was not selected.");
            const transcript = await readTranscript(ctx);
            ctx.assert(JSON.stringify(transcript).includes("Primitive Markdown Proof"), "Transcript does not include the markdown proof message.");
            const info = await ctx.eval(markdownDomInfoExpression());
            ctx.assert(info.ok === true, `Markdown renderer did not expose the expected DOM: ${JSON.stringify(info)}`);
            ctx.assert(info.hasCodeBlock === true && info.codeText.includes("console.log"), `Code block is missing: ${JSON.stringify(info)}`);
            ctx.assert(info.hasInlineCode === true && info.inlineCodeText.includes("inlineToken"), `Inline code is missing: ${JSON.stringify(info)}`);
            ctx.assert(info.hasLink === true && info.linkText.includes("OpenWork docs"), `Link is missing: ${JSON.stringify(info)}`);
            ctx.assert(info.linkTarget === "_blank", `Link target changed: ${JSON.stringify(info)}`);
          },
          screenshot: {
            name: "markdown-code-link-conversation",
            requireText: MARKDOWN_TEXT_MARKERS,
            rejectText: ERROR_TEXT,
            hashIncludes: "/session",
          },
        });
      },
    },
    {
      name: "New session prompt streams a response",
      run: async (ctx) => {
        await ctx.prove("Creating a new session lists it in the sidebar and streams the assistant response", {
          voiceover: vo[2],
          action: async () => {
            await routeSession(ctx);
            const previousSessionId = await selectedSessionId(ctx);
            await waitForAction(ctx, "session.create_task");
            await ctx.control("session.create_task");
            createdSessionId = await waitForSelectedSessionId(ctx, previousSessionId, "newly created session id");
            await waitForSessionListed(ctx, createdSessionId);
            newSessionTranscript = await sendPromptAndWait(ctx, NEW_SESSION_PROMPT, NEW_SESSION_RESPONSE);
          },
          assert: async () => {
            ctx.assert(Boolean(createdSessionId), "New session id was not captured.");
            const sessions = await waitForSessionListed(ctx, createdSessionId);
            ctx.assert(sessions.some((session) => session.sessionId === createdSessionId), `Session ${createdSessionId} is not listed.`);
            const transcript = newSessionTranscript ?? await waitForAssistantResponseInTranscript(ctx, NEW_SESSION_RESPONSE, { count: 6 });
            const messages = transcriptMessages(transcript);
            ctx.assert(messages.some((message) => message.role === "user" && message.text.includes(NEW_SESSION_PROMPT)), "User prompt was not persisted in the transcript.");
            ctx.assert(transcriptHasRoleText(transcript, "assistant", NEW_SESSION_RESPONSE), "Assistant response was not persisted in the transcript.");
            await ctx.expectText(NEW_SESSION_RESPONSE);
            await assertNoVisibleErrors(ctx);
          },
          screenshot: {
            name: "new-session-response-streamed",
            requireText: [NEW_SESSION_RESPONSE],
            rejectText: ERROR_TEXT,
            hashIncludes: "/session",
          },
        });
      },
    },
    {
      name: "Connections and extensions settings load",
      run: async (ctx) => {
        await ctx.prove("Connections and extensions settings load through the current server-backed settings surfaces", {
          voiceover: vo[3],
          action: async () => {
            await openSettingsPanel(ctx, "connect", "Connect for teams");
            const connect = await inspectConnectSurface(ctx);
            await openSettingsPanel(ctx, "extensions", "My Extensions");
            await ctx.waitForText("Refresh", { timeoutMs: 30_000 });
            const extensions = await inspectExtensionsSurface(ctx);
            settingsState = { connect, extensions };
          },
          assert: async () => {
            ctx.assert(settingsState !== null, "Settings state was not captured.");
            ctx.assert(settingsState.connect.route.includes("/settings/connect"), `Connect route did not load: ${JSON.stringify(settingsState.connect)}`);
            ctx.assert(settingsState.connect.hasHeader && settingsState.connect.hasDescription, `Connect header did not render: ${JSON.stringify(settingsState.connect)}`);
            ctx.assert(settingsState.extensions.route.includes("/settings/extensions"), `Extensions route did not load: ${JSON.stringify(settingsState.extensions)}`);
            ctx.assert(settingsState.extensions.hasExtensionsHeader, `Extensions header did not render: ${JSON.stringify(settingsState.extensions)}`);
            ctx.assert(settingsState.extensions.hasMyExtensions && settingsState.extensions.hasMarketplace && settingsState.extensions.hasRefresh, `Extensions MCP surface did not render: ${JSON.stringify(settingsState.extensions)}`);
            ctx.assert(settingsState.extensions.hasConnectPath, `Extensions did not expose the current Connect/marketplace path: ${JSON.stringify(settingsState.extensions)}`);
            await assertNoVisibleErrors(ctx);
          },
          screenshot: {
            name: "settings-extensions-server-backed-surface",
            requireText: ["Extensions (Legacy)", "My Extensions", "Refresh"],
            rejectText: ERROR_TEXT,
            hashIncludes: "/settings/extensions",
          },
        });
      },
    },
    {
      name: "Restart restores durable workspace state",
      run: async (ctx) => {
        await ctx.prove("Reopening OpenWork restores the workspace, session history, settings route, and server connection", {
          voiceover: vo[4],
          action: async () => {
            ctx.assert(Boolean(createdSessionId), "No created session id is available for restart proof.");
            const beforeWorkspaceId = bootState?.selectedWorkspaceId ?? null;
            await reloadRendererClient(ctx);
            await routeSession(ctx);
            const afterBoot = await collectBootState(ctx);
            const listedSessions = await waitForSessionListed(ctx, createdSessionId);
            await openSession(ctx, createdSessionId);
            const transcript = await waitForAssistantResponseInTranscript(ctx, NEW_SESSION_RESPONSE, { timeoutMs: 60_000, count: 6 });
            await openSettingsPanel(ctx, "connect", "Connect for teams");
            const connect = await inspectConnectSurface(ctx);
            restartState = { beforeWorkspaceId, afterBoot, listedSessions, transcript, connect };
          },
          assert: async () => {
            ctx.assert(restartState !== null, "Restart state was not captured.");
            ctx.assert(restartState.afterBoot.connected === true, `Server connection did not return: ${JSON.stringify(restartState.afterBoot)}`);
            ctx.assert(restartState.afterBoot.tokenPresent === true, `Server token did not return: ${JSON.stringify(restartState.afterBoot)}`);
            ctx.assert(
              !restartState.beforeWorkspaceId || restartState.afterBoot.selectedWorkspaceId === restartState.beforeWorkspaceId,
              `Workspace changed across restart: ${JSON.stringify(restartState)}`,
            );
            ctx.assert(restartState.listedSessions.some((session) => session.sessionId === createdSessionId), `Session ${createdSessionId} was not listed after renderer reload.`);
            ctx.assert(transcriptHasRoleText(restartState.transcript, "user", NEW_SESSION_PROMPT), "Restarted transcript is missing the user prompt.");
            ctx.assert(transcriptHasRoleText(restartState.transcript, "assistant", NEW_SESSION_RESPONSE), "Restarted transcript is missing the assistant response.");
            ctx.assert(restartState.connect.route.includes("/settings/connect"), `Settings route did not return after restart: ${JSON.stringify(restartState.connect)}`);
            ctx.assert(restartState.connect.hasHeader && restartState.connect.hasDescription, `Connect settings did not render after restart: ${JSON.stringify(restartState.connect)}`);
            await assertNoVisibleErrors(ctx);
          },
          screenshot: {
            name: "restarted-connect-settings-restored",
            requireText: ["OpenWork Connect", "Connect for teams"],
            rejectText: ERROR_TEXT,
            hashIncludes: "/settings/connect",
          },
        });
      },
    },
  ],
};
