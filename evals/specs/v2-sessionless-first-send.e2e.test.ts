import { expect } from "vitest";
import { browserScript, resolveEvalEngine, spec } from "@openwork/testkit";
import { sessionlessFirstSendWorld } from "../worlds/first-run.ts";
import { mobileChatInteractionWorld } from "../worlds/first-run.ts";
import { mobileChatGeometry, simulateKeyboardViewport } from "../worlds/mobile-chat-viewport.ts";
import { setViewport } from "@openwork/cdp";
import { localSendDenOutageWorld } from "../worlds/local-send-den-outage.ts";

const test = spec.world(sessionlessFirstSendWorld, {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
  needs: { env: ["OPENWORK_EVAL_ENGINE"] },
});

const mobileTest = spec.world(mobileChatInteractionWorld, {
  timeout: 600_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
  needs: { env: ["OPENWORK_EVAL_ENGINE"] },
});

mobileTest("MOBILE-CHAT-01 keyboard geometry and new turns keep a stable chat layout", async ({ world, user, probe, step, evidence }) => {
  await world.app.client.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await world.app.client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await world.openNewTask();
  await user.see("composer", { editable: true });
  await step("mobile chat has only a sidebar toggle and preserves sidebar actions", async () => {
    const chrome = await probe.eventually(() => mobileChatGeometry(world.app), { within: 10_000, label: "sidebar-only chat chrome", until: (value) => Boolean(value.navigation) && !value.headerVisible });
    expect(chrome.navigationCount).toBe(1);
    expect(chrome.navigation?.width).toBeGreaterThanOrEqual(44);
    expect(chrome.navigation?.height).toBeGreaterThanOrEqual(44);
    expect(chrome.overflowVisible).toBe(false);
    expect(chrome.headerTitleVisible).toBe(false);
    expect(chrome.headerWorkspaceVisible).toBe(false);
    expect(chrome.editor?.top).toBeGreaterThanOrEqual(chrome.navigation?.bottom ?? Infinity);
    await user.looks(["Mobile chat has no top bar, title, divider or overflow control: only an unboxed sidebar icon at the top left, with the composer unobstructed."]);
    await user.click({ role: "button", label: "Open sidebar" });
    await user.see({ role: "button", label: "Library" });
    await user.click({ role: "button", label: "Chat actions" });
    await user.see({ role: "menuitem", label: "Files" });
    await user.press("Escape");
    await user.press("Escape");
    await user.notSee({ role: "button", label: "Chat actions" });
    await user.see({ role: "button", label: "Open sidebar" });
    evidence.recordJsonArtifact("Sidebar-only mobile chrome geometry", chrome);
  });
  await user.looks(["At phone width, the new-chat composer sits near the bottom of the app rather than directly below the heading."]);

  const pickerFocus = () => probe.eval(browserScript(() => {
    const active = document.activeElement;
    return {
      activeTag: active?.tagName,
      activeText: active?.textContent?.trim(),
      activeLabel: active?.getAttribute("aria-label"),
      activePlaceholder: active?.getAttribute("placeholder"),
      rootControlFocused: Boolean(document.querySelector('[data-slot="model-select-root"]')?.contains(active)),
      inputs: [...document.querySelectorAll<HTMLInputElement>('[role="dialog"] input:not([type="hidden"])')]
        .filter((input) => input.getClientRects().length > 0)
        .map((input) => ({ placeholder: input.placeholder, fontSize: Number.parseFloat(getComputedStyle(input).fontSize), focused: input === active })),
    };
  }, []));

  await step("mobile model and provider navigation does not reopen search or lose focus", async () => {
    await probe.eventually(() => probe.composer(), { within: 30_000, label: "fixture model ready", until: (value) => !value.modelUnavailable });
    const routeBefore = await world.route();
    await user.click({ role: "button", label: "Change model" });
    await user.click({ role: "button", label: /^Model\s+First send model/ });
    await user.see({ placeholder: "Search models..." });
    const modelSearch = await pickerFocus();
    expect(modelSearch.inputs.some((input) => input.placeholder === "Search models..." && input.fontSize >= 16)).toBe(true);
    expect(modelSearch.activeTag).toBe("BUTTON");
    expect(modelSearch.activeText).toBe("Model");
    expect(modelSearch.inputs.some((input) => input.focused)).toBe(false);
    await user.looks(["At phone width, the model picker has a readable search field, a Model back control, and model/provider actions inside the viewport."]);
    await user.click({ role: "button", label: "Model" });
    const modelBack = await pickerFocus();
    expect(modelBack.rootControlFocused).toBe(true);
    expect(modelBack.activeTag).toBe("BUTTON");
    expect(modelBack.activeText).toMatch(/^Model/);
    await user.click({ role: "button", label: /^Model\s+First send model/ });
    await user.click({ role: "button", label: "Connect more providers" });
    await user.see({ placeholder: "Filter providers by name or ID" });
    const providerSearch = await probe.eventually(pickerFocus, {
      within: 10_000, label: "mobile provider dialog focuses its title, not search",
      until: (value) => value.activeText === "Connect providers" && value.activeTag !== "INPUT",
    });
    expect(providerSearch.inputs.some((input) => input.placeholder === "Filter providers by name or ID" && input.fontSize >= 16)).toBe(true);
    expect(providerSearch.inputs.some((input) => input.focused)).toBe(false);
    await user.looks(["At phone width, Connect providers shows a readable filter field, provider rows and a close action without horizontal overflow."]);
    await user.type({ placeholder: "Filter providers by name or ID" }, "Google");
    await user.click({ role: "button", label: /^Google/ });
    await user.see({ placeholder: "sk-..." });
    const providerSelected = await pickerFocus();
    expect(providerSelected.inputs.some((input) => input.placeholder === "sk-..." && input.fontSize >= 16)).toBe(true);
    expect(providerSelected.activeTag).not.toBe("BODY");
    expect(providerSelected.inputs.some((input) => input.focused)).toBe(false);
    await user.looks(["The mobile Google provider form shows its API key field and Back/Close actions within the viewport; no credential has been entered."]);
    await user.click({ role: "button", label: "Back" });
    const providerBack = await pickerFocus();
    expect(providerBack.activeTag).toBe("BUTTON");
    expect(providerBack.activeText).toMatch(/^Google/);
    expect(providerBack.inputs.some((input) => input.focused)).toBe(false);
    await user.notSee({ placeholder: "sk-..." });
    await user.press("Escape");
    await user.notSee({ placeholder: "Filter providers by name or ID" });
    // CDP's mouse clicks can open the restored model trigger's focus tooltip.
    // Dismiss it before the separate simulated-keyboard/composer interaction.
    await user.press("Escape");
    expect(await world.route()).toBe(routeBefore);
    expect((await probe.composer()).draftText).toBe("");
    expect(await world.requests()).toHaveLength(0);
    evidence.recordJsonArtifact("Chromium mobile picker focus and computed input fonts (not native Safari zoom)", { modelSearch, modelBack, providerSearch, providerSelected, providerBack });
    evidence.recordAssertionEvidence("Mobile picker navigation preserves focus without automatic search focus or provider submission",
      "Model Back restores its root control; provider selection and Back retain dialog/row focus; visible search and API-key inputs compute to at least 16px; no credential is entered, no prompt is sent and the route/draft are unchanged.", true);
  });

  await simulateKeyboardViewport(world.app, 470, 80);
  const read = () => mobileChatGeometry(world.app);
  const keyboard = await probe.eventually(read, {
    within: 10_000, label: "chat shell follows keyboard viewport shrink and pan",
    until: (value) => Boolean(value.shell && Math.abs(value.shell.top - 80) < 2 && Math.abs(value.shell.height - 470) < 2),
  });
  expect(keyboard.editorFontSize).toBeGreaterThanOrEqual(16);
  expect(keyboard.editor?.bottom).toBeLessThanOrEqual(550);
  expect(keyboard.toolbar?.height).toBeLessThanOrEqual(40);
  expect(keyboard.send?.right).toBeLessThanOrEqual(390);
  evidence.recordJsonArtifact("Simulated keyboard viewport geometry, not an iOS keyboard", keyboard);

  await user.click("composer");
  const focused = await probe.eventually(read, {
    within: 10_000, label: "mobile composition hides the greeting, suggestions and header metadata",
    until: (value) => !value.greetingVisible && !value.suggestionsVisible && !value.headerTitleVisible && !value.headerWorkspaceVisible,
  });
  evidence.recordJsonArtifact("Focused mobile composition without introduction or header metadata", focused);
  await user.looks(["While composing on mobile, greeting and suggestions are hidden; only the sidebar icon remains above the conversation, with no header bar or overflow control."]);
  await user.type("composer", world.prompt);
  await probe.eventually(() => probe.composer(), { within: 30_000, label: "mobile send enabled", until: (value) => value.runTaskEnabled });
  const before = await read();
  await using transition = await world.transition(evidence.dir);
  if (!before.send) throw new Error("Missing mobile send control");
  await world.app.client.send("Input.dispatchTouchEvent", {
    type: "touchStart", touchPoints: [{ x: (before.send.left + before.send.right) / 2, y: (before.send.top + before.send.bottom) / 2 }],
  });
  await world.app.client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await probe.eventually(() => transition.read(), { within: 10_000, label: "held first mobile session creation", until: (value) => value.held === 1 });
  const held = await read();
  expect(held.greetingVisible).toBe(false);
  expect(held.suggestionsVisible).toBe(false);
  expect(held.headerTitleVisible).toBe(false);
  expect(held.headerWorkspaceVisible).toBe(false);
  expect((await probe.composer()).draftText).toBe("");
  expect(held.editorFocused).toBe(true);
  expect(Math.abs((held.editor?.bottom ?? 0) - (before.editor?.bottom ?? 0))).toBeLessThanOrEqual(2);
  await user.looks(["The mobile composer remains visible inside the shortened app viewport while the first send is pending; only the sidebar icon remains at the top."]);
  await transition.release();
  await user.see({ text: "Paragraph 18:" }, { timeoutMs: 120_000 });
  const persisted = await read();
  expect(persisted.headerTitleVisible).toBe(false);
  expect(persisted.headerWorkspaceVisible).toBe(false);
  expect(persisted.userCount).toBe(1);
  expect(persisted.headerVisible).toBe(false);
  expect(persisted.thread?.top).toBeGreaterThanOrEqual(persisted.navigation?.bottom ?? Infinity);
  expect(persisted.editor?.bottom).toBeLessThanOrEqual(550);
  expect(Math.abs((persisted.editor?.bottom ?? 0) - (held.editor?.bottom ?? 0))).toBeLessThanOrEqual(16);
  evidence.recordJsonArtifact("First-send composer handoff geometry", { before, held, persisted });

  await step("a new mobile turn reserves answer space and survives keyboard dismissal", async () => {
    await user.type("composer", world.followupPrompt);
    await user.click("Run task");
    await user.see({ text: world.followupReply }, { timeoutMs: 90_000 });
    const anchored = await probe.eventually(read, {
      within: 10_000, label: "new user turn aligned at the transcript start",
      until: (value) => Boolean(value.latestUser && value.thread && Math.abs(value.latestUser.top - value.thread.top) <= 8),
    });
    expect(anchored.userCount).toBe(2);
    await user.looks(["The latest user message starts near the top of the transcript with the short assistant answer below it and the compact composer at the bottom of the shortened viewport."]);
    await simulateKeyboardViewport(world.app, 844, 0);
    const dismissed = await probe.eventually(read, {
      within: 10_000, label: "keyboard dismissal retains new turn position",
      until: (value) => Boolean(value.shell?.height === 844 && value.latestUser && value.thread && Math.abs(value.latestUser.top - value.thread.top) <= 8),
    });
    expect(dismissed.pageScroll).toBe(0);
    // Scroll anchoring can place a message on a half CSS pixel; the transcript
    // itself must still start strictly below the in-flow navigation target.
    expect(dismissed.thread?.top).toBeGreaterThanOrEqual(dismissed.navigation?.bottom ?? Infinity);
    expect((dismissed.latestUser?.top ?? -Infinity) + 1).toBeGreaterThanOrEqual(dismissed.navigation?.bottom ?? Infinity);
    expect(dismissed.editor?.top).toBeGreaterThanOrEqual(dismissed.navigation?.bottom ?? Infinity);
    await user.notSee({ role: "button", label: "Jump to latest" });
    evidence.recordJsonArtifact("New turn before and after simulated keyboard dismissal", { anchored, dismissed });
    await user.looks(["At full phone height, the latest user turn remains at the top of the conversation pane and the composer stays at the bottom."]);
    if (!dismissed.thread) throw new Error("Missing mobile transcript viewport");
    await world.app.client.send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x: 195, y: dismissed.thread.top + 100, deltaX: 0, deltaY: -240,
    });
    const reading = await probe.eventually(read, {
      within: 10_000, label: "manual reading takes precedence over new-turn anchoring",
      until: (value) => value.scrollTop < dismissed.scrollTop - 100,
    });
    await user.see({ role: "button", label: "Jump to latest" });
    evidence.recordAssertionEvidence("Reserved answer space does not show a false jump affordance or trap manual scrolling", JSON.stringify({ dismissed, reading }), true);
    await user.click({ role: "button", label: "Jump to latest" });
    await user.click({ role: "button", label: "Open sidebar" });
    await user.click({ role: "button", label: "Chat actions" });
    await user.click({ role: "menuitem", label: "Find in conversation" });
    await probe.eventually(() => probe.eval(browserScript(() => {
      const sidebar = document.querySelector('[data-sidebar="sidebar"][data-mobile="true"]');
      return !sidebar || sidebar.getClientRects().length === 0;
    }, [])), { within: 5_000, label: "sidebar exit completes after selecting Find", until: (closed) => closed });
    await user.notSee({ role: "button", label: "Chat actions" });
    await user.see({ placeholder: "Find in conversation" });
    await user.press("Escape");
  });

  await step("narrow phone and desktop retain usable composer controls", async () => {
    await setViewport(world.app, { width: 320, height: 844, deviceScaleFactor: 1 });
    await simulateKeyboardViewport(world.app, 844, 0);
    const narrow = await probe.eventually(read, { within: 10_000, label: "narrow phone toolbar fits", until: (value) => Boolean(value.shell?.width === 320 && value.send && value.send.right <= 320) });
    expect(narrow.toolbar?.height).toBeLessThanOrEqual(40);
    expect(narrow.headerVisible).toBe(false);
    expect(narrow.navigationCount).toBe(1);
    await user.looks(["At narrow phone width, the composer send button and model control remain inside the viewport without horizontal overflow."]);
    await setViewport(world.app, { width: 1440, height: 900, deviceScaleFactor: 1 });
    await simulateKeyboardViewport(world.app, 450, 90);
    const desktop = await probe.eventually(read, { within: 10_000, label: "desktop ignores mobile keyboard shell geometry", until: (value) => Boolean(value.shell && value.shell.height > 800) });
    expect(desktop.editor?.height).toBeGreaterThanOrEqual(60);
    expect(desktop.headerTitleVisible).toBe(true);
    expect(desktop.headerWorkspaceVisible).toBe(true);
    expect(desktop.headerVisible).toBe(true);
    expect(desktop.navigation).toBeNull();
    await user.looks(["At desktop width, the normal full-height chat layout and larger composer remain visible."]);
    evidence.recordAssertionEvidence("Mobile viewport and turn layout do not resize the desktop shell", JSON.stringify({ narrow, desktop }), true);
    await user.click({ role: "button", label: "Change model" });
    await user.click({ role: "button", label: /^Model\s+First send model/ });
    const desktopSearch = await probe.eventually(pickerFocus, {
      within: 10_000, label: "desktop model search retains keyboard focus",
      until: (value) => value.activePlaceholder === "Search models...",
    });
    expect(desktopSearch.inputs.find((input) => input.placeholder === "Search models...")?.fontSize).toBe(13);
    evidence.recordJsonArtifact("Desktop picker retains 13px focused search", desktopSearch);
    await user.looks(["At desktop width, the model picker shows its compact search field, model options and provider actions."]);
    await user.press("Escape");
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const outageTest = spec.world(localSendDenOutageWorld, {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
  needs: { placement: "local", env: ["OPENWORK_EVAL_ENGINE"] },
});

outageTest("DEN-LOCAL-SEND configured v1 identity sends to inference while Den is unavailable", async ({ world, user, probe, evidence }) => {
  await world.openNewTask();
  expect(world.hostedServerIdentityInstalled).toBe(true);
  expect(world.rendererCloudSignedIn).toBe(false);
  expect(await world.route()).toBe(world.sessionlessRoute);
  await user.see("composer", { editable: true });
  const sessionsBefore = await world.readNative(world.sessionsPath);
  expect(sessionsBefore.status).toBe(200);
  expect(await world.requests()).toHaveLength(0);
  expect(await world.denUnavailable()).toBe(503);
  const denBefore = world.denRequests(); // Baseline includes the sole explicit outage probe.
  evidence.recordJsonArtifact("Pre-outage engine readiness", { ...world.readiness, denBefore });
  await user.type("composer", world.prompt);
  await probe.eventually(() => probe.composer(), {
    within: 30_000, label: "configured local provider enables Run task during Den outage",
    until: (state) => state.runTaskEnabled && state.draftText.trim() === world.prompt,
  });
  await user.press("Enter");
  const prefix = `${world.sessionlessRoute}/`;
  const route = await probe.eventually(() => world.route(), {
    within: 30_000, label: "persisted v1 session route during Den outage",
    until: (value) => value.startsWith(prefix) && /^ses_[^/?#]+$/.test(value.slice(prefix.length)),
  });
  const sessionId = route.slice(prefix.length);
  try {
    const text = await probe.eventually(() => probe.text(), {
      within: 30_000, label: "local inference reply during Den outage",
      until: (value) => value.includes(world.reply) || value.includes("Task interrupted"),
    });
    expect(text, "engine must not interrupt the configured-provider task").not.toContain("Task interrupted");
    await user.see({ text: world.reply }, { timeoutMs: 5_000 });
  } finally {
    const reads = await Promise.allSettled([
      world.readNative(world.messagesPath(sessionId)),
      world.readNative("/cloud-provider-sync/status"),
      world.requests().then((requests) => ({ finalMarkerMatchedRequests: requests.length })),
      probe.text(),
    ]);
    evidence.recordJsonArtifact("Outage send diagnostics", {
      sessionId, denBefore, denAfter: world.denRequests(),
      reads: reads.map((result, index) => ({
        boundary: ["nativeMessages", "reloadStatus", "mockInference", "visibleText"][index],
        ...(result.status === "fulfilled" ? { value: result.value } : { error: String(result.reason) }),
      })),
    });
  }
  const native = await probe.eventually(() => world.readNative(world.messagesPath(sessionId)), {
    within: 20_000, label: "native v1 persists the inference reply",
    until: (response) => response.status === 200 && nativeMessages(response.body)
      .some((message) => message.role === "assistant" && message.text.includes(world.reply)),
  });
  const messages = nativeMessages(native.body);
  expect(messages.filter((message) => message.role === "user" && message.text.includes(world.prompt))).toHaveLength(1);
  expect(messages.some((message) => message.role === "assistant" && message.text.includes(world.reply))).toBe(true);
  const sessionsAfter = await world.readNative(world.sessionsPath);
  expect(sessionsAfter.status).toBe(200);
  expect(nativeSessionIds(sessionsAfter.body)).toEqual([...nativeSessionIds(sessionsBefore.body), sessionId].sort());
  expect(await world.route()).toBe(route);
  expect(await world.requests()).toHaveLength(1); // Base witness filters final requests by this prompt's unique marker.
  expect((await probe.composer()).userMessageCount).toBe(1);
  expect(world.denRequests()).toEqual(denBefore);
  evidence.recordJsonArtifact("Den outage request counts", {
    hostedServerIdentityInstalled: world.hostedServerIdentityInstalled,
    rendererCloudSignedIn: world.rendererCloudSignedIn,
    before: denBefore, after: world.denRequests(), sessionId,
  });
  evidence.recordAssertionEvidence("Configured local v1 inference does not preflight Den",
    "Host-side Den identity installed against healthy policy; renderer is not Cloud-signed-in. After explicit Den 503 probe, real Enter submission persisted one prompt and its visible reply through exactly one marker-matched mock final request, with no further Den requests.", true);
});

function textOf(value: unknown): string {
  return isRecord(value) && typeof value.text === "string" ? value.text : "";
}

function nativeItems(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (isRecord(body) && Array.isArray(body.data)) return body.data;
  throw new Error(`Unexpected native list: ${JSON.stringify(body)}`);
}

/**
 * Engine-native message list, normalized the way the app reads each engine:
 * v1 returns an array of `{ info: { role }, parts: [{ text }] }`; v2 returns
 * `{ data: [{ role | type, content: [{ text }] | text }] }`.
 */
function nativeMessages(body: unknown): { role: string; text: string }[] {
  return nativeItems(body).flatMap((message) => {
    if (!isRecord(message)) return [];
    const info = isRecord(message.info) ? message.info : message;
    const role = typeof info.role === "string" ? info.role : typeof info.type === "string" ? info.type : "";
    const parts = Array.isArray(message.parts) ? message.parts : Array.isArray(message.content) ? message.content : [message];
    return [{ role, text: parts.map(textOf).join("\n") }];
  });
}

function nativeSessionIds(body: unknown): string[] {
  return nativeItems(body).flatMap((session) => isRecord(session) && typeof session.id === "string" ? [session.id] : []).sort();
}

test(`${resolveEvalEngine()}: Run task on the sessionless New task route creates the session and delivers the first prompt`, async ({ world, user, probe, step, evidence }) => {
  const { prompt, engine } = world;
  const persistedPrefix = `${world.sessionlessRoute}/`;
  const readSessions = async () => {
    const response = await world.readNative(world.sessionsPath);
    expect(response.status, world.sessionsPath).toBe(200);
    return nativeSessionIds(response.body);
  };

  await step("the person lands on the sessionless New task route with an empty, editable composer", async () => {
    await world.openNewTask();
    const routing = await world.readNative("/experimental/engine-v2-preview/status");
    expect(routing.status).toBe(200);
    expect(routing.body).toMatchObject({ chatRouting: engine === "v2" });
    if (engine === "v2") expect(routing.body).toMatchObject({ enabled: true, running: true });
    expect(await world.route()).toBe(world.sessionlessRoute);
    await user.see("composer", { editable: true });
    const composer = await probe.eventually(() => probe.composer(), {
      within: 60_000,
      label: "empty New task composer with its model ready",
      until: (state) => state.composerEditable && state.draftText.trim() === "" && !state.modelUnavailable,
    });
    expect(composer.userMessageCount).toBe(0);
  });
  const sessionsBefore = await readSessions();

  for (const newerDraft of ["", "Keep this newer continuation intact."]) {
    await step(newerDraft ? "creation failure preserves a newer draft and guards restoration of the unsent prompt" : "creation failure restores the unsent prompt without creating a session", async () => {
      await user.type("composer", prompt);
      await using rejected = await world.transition(evidence.dir);
      evidence.recordJsonArtifact("Creation failure recording", { engine, newerDraft: Boolean(newerDraft), path: rejected.filmPath });
      await user.press("Enter");
      await probe.eventually(() => rejected.read(), {
        within: 10_000, label: "creation held before rejection", until: (state) => state.held === 1,
      });
      if (newerDraft) await user.type("composer", newerDraft);
      await rejected.fail();
      const recovered = await probe.eventually(async () => ({ composer: await probe.composer(), recovery: await world.recovery() }), {
        within: 15_000, label: "failed creation preserves editable content and exposes its error",
        until: (state) => state.composer.composerEditable && state.composer.draftText === (newerDraft || prompt)
          && !state.recovery.starting && state.recovery.error.length > 0,
      });
      evidence.recordJsonArtifact("Creation failure restoration", recovered);
      expect(await world.route()).toBe(world.sessionlessRoute);
      expect(recovered.composer.userMessageCount).toBe(0);
      expect(recovered.recovery.restoreVisible).toBe(Boolean(newerDraft));
      expect(recovered.recovery.restoreDisabled).toBe(Boolean(newerDraft));
      expect(rejected.read()).toMatchObject({ creation: 1, prompt: 0, expired: false });
      expect(await readSessions()).toEqual(sessionsBefore);
      expect(await world.requests()).toHaveLength(0);
      await user.looks(newerDraft ? [
        `The New task hero shows the creation error "Session creation rejected by OPE-51 fixture." and the composer contains "${newerDraft}".`,
        "The action 'Clear the current draft to restore the unsent message' is visible below the error; there is no submitted user-message bubble or Starting indicator.",
      ] : [
        "The New task hero shows the creation error 'Session creation rejected by OPE-51 fixture.' and the original prompt beginning 'Summarize this workspace in one sentence.' is restored inside the composer.",
        "There is no submitted user-message bubble, Starting indicator, or 'Clear the current draft to restore the unsent message' action.",
      ]);
      await user.click({ placeholder: "Describe your task..." });
      await user.press(world.app.handle.hostKind !== "daytona" && process.platform === "darwin" ? "Meta+A" : "Control+A");
      await user.press("Backspace");
      if (newerDraft) {
        await user.click({ role: "button", label: "Clear the current draft to restore the unsent message" });
        await user.see("composer", { text: prompt, editable: true });
        expect((await world.recovery()).restoreVisible).toBe(false);
        await user.looks([
          "The original prompt beginning 'Summarize this workspace in one sentence.' is visible inside the New task composer, with the creation error still visible above it.",
          "The newer text 'Keep this newer continuation intact.' and the 'Clear the current draft to restore the unsent message' action are absent; there is no submitted user-message bubble or Starting indicator.",
        ]);
        await user.click({ placeholder: "Describe your task..." });
        await user.press(world.app.handle.hostKind !== "daytona" && process.platform === "darwin" ? "Meta+A" : "Control+A");
        await user.press("Backspace");
      }
      expect((await probe.composer()).draftText).toBe("");
      evidence.recordAssertionEvidence("Rejected creation retains recoverable content without admitting a session or prompt",
        newerDraft ? "Newer draft remains editable; restoration stays disabled until it is cleared, then restores the original prompt exactly." : "Original prompt is restored automatically; no session or provider request is created.", true);
    });
  }

  await user.reload();
  await user.see("composer", { text: "", editable: true });
  expect((await world.recovery()).error).toBe("");
  await step("typing a prompt enables Run task", async () => {
    await user.type("composer", prompt);
    await user.see("composer", { text: prompt });
    const composer = await probe.eventually(() => probe.composer(), {
      within: 30_000,
      label: "enabled Run task",
      until: (state) => state.runTaskEnabled && state.draftText.trim() === prompt,
    });
    expect(await world.route()).toBe(world.sessionlessRoute);
  });

  await using transition = await world.transition(evidence.dir);
  evidence.recordJsonArtifact("Sessionless transition recording", { engine, path: transition.filmPath });
  await user.looks([
    "The 'What do you need done?' hero heading is visible above a composer containing the prompt beginning 'Summarize this workspace in one sentence.'.",
    "There is no creation error, Starting indicator, or submitted user-message bubble above the populated composer.",
  ]);
  await user.press("Enter");
  await user.press("Enter");
  await step("slow session creation keeps an unmoved busy hero composer without intermediate labels or a temporary user row", async () => {
    await probe.eventually(() => transition.read(), {
      within: 10_000, label: "one held session creation", until: (state) => state.held === 1,
    });
    const samples = await probe.eventually(() => transition.samples(), {
      within: 10_000, label: "busy creating control sampled across the slow creation interval",
      until: (values) => {
        const preparing = values.filter((sample) => sample.submitted && sample.preparing && sample.source === "raf");
        return preparing.length >= 20 && preparing[preparing.length - 1]!.elapsed - preparing[0]!.elapsed >= 1500;
      },
    }).finally(async () => {
      evidence.recordJsonArtifact("Immediate sessionless RAF and mutation observations", await transition.samples());
    });
    await user.looks([
      "The 'What do you need done?' hero remains visible above the stationary empty composer showing 'Describe your task...', with a visible busy spinner in its send control.",
      "There is no submitted user-message bubble, Starting indicator, or Working indicator between the hero heading and the composer.",
    ]);
    expect(transition.read()).toMatchObject({ creation: 1, prompt: 0, held: 1, expired: false });
    const submissionIndex = samples.findIndex((sample) => sample.submitted);
    expect(submissionIndex).toBeGreaterThanOrEqual(0);
    const baseline = samples[submissionIndex]!;
    const heldSamples = samples.slice(submissionIndex);
    evidence.recordJsonArtifact("Trusted submission through held creation", { submissionIndex, submittedAt: baseline.submittedAt, samples: heldSamples });
    expect(baseline.source).toMatch(/^trusted-submit-(enter|click)$/);
    expect(baseline.submissionIndex).toBe(submissionIndex);
    expect(baseline.submittedAt).not.toBeNull();
    expect(baseline.width).toBeGreaterThan(0);
    expect(baseline.height).toBeGreaterThan(0);
    expect(heldSamples.filter((sample) => sample.source === "raf").length).toBeGreaterThanOrEqual(20);
    expect(heldSamples.some((sample) => sample.source === "mutation" && sample.preparing)).toBe(true);
    const firstPreparing = heldSamples.findIndex((sample) => sample.preparing);
    expect(firstPreparing).toBeGreaterThanOrEqual(0);
    expect(heldSamples.slice(firstPreparing).every((sample) => sample.preparing)).toBe(true);
    for (const [offset, sample] of heldSamples.entries()) {
      expect(sample.index).toBe(submissionIndex + offset);
      expect(sample.submitted).toBe(true);
      expect(sample.submissionIndex).toBe(submissionIndex);
      expect(sample.submittedAt).toBe(baseline.submittedAt);
      expect(sample.hero).toBe(true);
      expect(sample.starting).toBe(false);
      expect(sample.working).toBe(false);
      expect(sample.persisted).toEqual([]);
      expect(sample.users).toBe(0);
      expect(sample.totalUsers).toBe(0);
      expect(Math.abs(sample.top - baseline.top)).toBeLessThanOrEqual(1);
      expect(Math.abs(sample.left - baseline.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(sample.width - baseline.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(sample.height - baseline.height)).toBeLessThanOrEqual(1);
    }
    evidence.recordAssertionEvidence("Slow creation preserves hero layout without a temporary user bubble",
      `${heldSamples.length} contiguous observations from trusted submission preserve the visible hero and editor rect within one pixel with no user rows, persisted surfaces, Starting or Working; the busy creating spinner persists without gaps once shown for at least 1500ms; duplicate Enter admits one creation and no prompt before release.`, true);
  });
  await transition.release();
  const hash = await probe.eventually(() => world.route(), {
    within: 30_000,
    label: "navigation to the created session",
    until: (value) => value.startsWith(persistedPrefix) && value.slice(persistedPrefix.length).startsWith("ses_"),
  });
  const sessionId = hash.slice(persistedPrefix.length);
  expect(sessionId).toMatch(/^ses_[^/?#]+$/);

  await step(`the ${engine} first send clears the composer and reaches both thread and engine`, async () => {
    await user.see("composer", { text: "" });
    // Observe BOTH boundaries even on a regression: a missing visible message
    // must not short-circuit the native probe and hide the empty engine list.
    const path = world.messagesPath(sessionId);
    const [visible, native] = await Promise.allSettled([
      user.see({ text: prompt }, { timeoutMs: 20_000 }),
      probe.eventually(() => world.readNative(path), {
        within: 20_000,
        intervalMs: 1_000,
        label: `${engine} engine user message for ${sessionId}`,
        until: (response) => response.status === 200 && nativeMessages(response.body)
          .some((message) => message.role === "user" && message.text.includes(prompt)),
      }),
    ]);
    for (const [boundary, result] of [["thread", visible], ["engine", native]] satisfies [string, PromiseSettledResult<unknown>][]) {
      evidence.recordAssertionEvidence(
        `${engine} sessionless first prompt reaches the ${boundary}`,
        result.status === "fulfilled" ? `The ${boundary} retained the submitted prompt.` : String(result.reason),
        result.status === "fulfilled",
      );
    }
    expect(visible.status, "prompt visible outside the empty composer").toBe("fulfilled");
    if (native.status === "rejected") throw native.reason;
    const messages = nativeMessages(native.value.body);
    expect(messages.filter((message) => message.role === "user" && message.text.includes(prompt))).toHaveLength(1);
    const composer = await probe.composer();
    expect(await world.route()).toBe(`${persistedPrefix}${sessionId}`);
    expect(composer.draftText.trim()).toBe("");
    expect(composer.userMessageCount).toBe(1);
  });

  await step("exactly one session was created and the engine reply arrives in it", async () => {
    await user.see({ text: world.reply }, { timeoutMs: 120_000 });
    expect(await readSessions()).toEqual([...sessionsBefore, sessionId].sort());
    expect(await world.route()).toBe(`${persistedPrefix}${sessionId}`);
    expect((await probe.composer()).userMessageCount).toBe(1);
    expect(transition.read()).toMatchObject({ creation: 1, prompt: 1, expired: false });
    expect(await world.requests()).toHaveLength(1);
    const rows = await probe.eval(browserScript((id) => {
      const surface = document.querySelector<HTMLElement>('[data-session-surface-id="' + id + '"]');
      return [...(surface?.querySelectorAll<HTMLElement>('[data-message-role]') ?? [])]
        .filter((node) => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden")
        .map((node) => ({ role: node.getAttribute("data-message-role"), text: node.innerText }));
    }, [sessionId]));
    expect(rows.filter((row) => row.role === "user")).toHaveLength(1);
    expect(rows[0]?.role).toBe("user");
    expect(rows[0]?.text).toContain(prompt);
    expect(rows.slice(1).some((row) => row.role === "assistant" && row.text.includes(world.reply))).toBe(true);
    evidence.recordAssertionEvidence("The opening prompt stays before its response",
      "The created thread has exactly one user row, first in transcript order, followed by the engine reply; the prompt is neither duplicated nor rendered below its answer.", true);
    await user.looks([
      `The conversation transcript shows exactly one user-message bubble containing the prompt beginning 'Summarize this workspace in one sentence.' and an assistant reply reading '${world.reply}'.`,
      "An empty composer is visible below the transcript; the 'What do you need done?' hero and Starting indicator are absent.",
    ]);
    const handoff = await transition.samples();
    evidence.recordJsonArtifact("Hero to persisted session DOM ownership", handoff);
    const submissionIndex = handoff.findIndex((sample) => sample.submitted);
    expect(submissionIndex).toBeGreaterThanOrEqual(0);
    const takeoverIndex = handoff.findIndex((sample, index) => index >= submissionIndex && sample.persisted.length > 0);
    expect(takeoverIndex).toBeGreaterThan(submissionIndex);
    const baseline = handoff[submissionIndex]!;
    const takeover = handoff[takeoverIndex]!;
    const heroSamples = handoff.slice(submissionIndex, takeoverIndex);
    evidence.recordJsonArtifact("Trusted submission and first persisted takeover boundaries", {
      submissionIndex, submittedAt: baseline.submittedAt, takeoverIndex, takeoverAt: takeover.elapsed,
      submission: baseline, takeover, samples: heroSamples,
    });
    expect(baseline.source).toMatch(/^trusted-submit-(enter|click)$/);
    expect(baseline.submissionIndex).toBe(submissionIndex);
    expect(baseline.submittedAt).not.toBeNull();
    expect(heroSamples.length).toBeGreaterThan(20);
    expect(heroSamples.every((sample, offset) => sample.index === submissionIndex + offset
      && sample.submitted && sample.submissionIndex === submissionIndex && sample.submittedAt === baseline.submittedAt
      && sample.hero && sample.users === 0 && sample.totalUsers === 0 && sample.persisted.length === 0)).toBe(true);
    expect(heroSamples.every((sample) => !sample.starting && !sample.working)).toBe(true);
    const firstPreparing = heroSamples.findIndex((sample) => sample.preparing);
    expect(firstPreparing).toBeGreaterThanOrEqual(0);
    expect(heroSamples.slice(firstPreparing).every((sample) => sample.preparing)).toBe(true);
    expect(heroSamples.every((sample) => Math.abs(sample.top - baseline.top) <= 1
      && Math.abs(sample.left - baseline.left) <= 1 && Math.abs(sample.width - baseline.width) <= 1
      && Math.abs(sample.height - baseline.height) <= 1)).toBe(true);
    expect(takeover.hero).toBe(false);
    expect(takeover.persisted).toEqual([sessionId]);
    const persistedSamples = handoff.slice(takeoverIndex);
    expect(persistedSamples.every((sample) => !sample.hero && sample.persisted.length === 1 && sample.persisted[0] === sessionId)).toBe(true);
    expect(persistedSamples.some((sample) => sample.totalUsers === 1)).toBe(true);
    evidence.recordAssertionEvidence("DOM ownership stays with the unchanged hero until the persisted thread takes over",
      `${heroSamples.length} contiguous observations from trusted submission index ${submissionIndex} to first visible persisted surface index ${takeoverIndex} retain the hero, zero user rows, no persisted surfaces and a stable editor rectangle; Starting and Working remain absent and the busy creating spinner has no gaps once shown. The first takeover is exactly the created session, which then owns one visible user row.`, true);
    evidence.recordAssertionEvidence(
      `${engine} creates exactly one session without replaying the first send`,
      "After the real engine reply, the session inventory is the original inventory plus exactly the routed session; one user row remains and the composer is empty.",
      true,
    );
  });
});
