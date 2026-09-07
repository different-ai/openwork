import { screenshot } from "@openwork/test-evidence";
import { browserScript } from "@openwork/testkit";
import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { computerUseWorld, toolState } from "../worlds/computer-use.ts";
import { createAndSelectWorkspace, evalIn, waitFor } from "@openwork/behaviors";

// New journey: a person grants one native window and can revoke it. The helper
// is a real stdio process; the fixture app has two independent, disposable windows.
const test = spec.world(computerUseWorld, { timeout: 180_000 });

test("Computer Use respects window consent, fresh observations and the person's Stop control", async ({ world, step }) => {
  await step("Discovery exposes identities without window content or input access", async () => {
    const discovery = toolState(await world.call("computer_discover"));
    expect(discovery.protocol).toBe("openwork.computer-use/1");
    expect(discovery.apps).toEqual(expect.arrayContaining([expect.objectContaining({ app_id: world.appId })]));
    expect(JSON.stringify(discovery)).not.toContain("Initial draft");
    const unapproved = await world.call("computer_observe", { session_id: "invented" });
    expect(unapproved).toMatchObject({ isError: true });
    expect(toolState(unapproved).code).toBe("session_unavailable");
    expect(await world.state()).toEqual({ count: 0, otherCount: 0, draft: "Initial draft" });
  });

  await step("Setup launched alongside the runtime reports the same granted permissions", async () => {
    const panel = JSON.stringify(await world.setupPanel());
    expect(panel).toContain("Accessibility · Allowed");
    expect(panel).toContain("Screen Recording · Allowed");
    expect(panel).not.toContain("Needed to read");
    expect(toolState(await world.call("computer_discover")).permissions).toMatchObject({ accessibility: true, screenRecording: true });
  });

  const session = await step("The person chooses a window and grants app controls", async () => {
    const pending = world.call("computer_open_session", { app_id: world.appId, pid: world.appPid, mode: "assist", purpose: "Edit the disposable fixture draft and increment its counter." });
    // A trusted person-input fixture presses the real native approval button.
    await Promise.race([
      (async () => {
        expect(await world.selectWindow()).toMatchObject({ previous: "Other window", selected: "Workspace window" });
        await world.pressControl("Allow this session");
      })(),
      pending.then((reply) => {
        const state = toolState(reply);
        if (state.ok !== true) throw new Error(`Session did not request consent: ${JSON.stringify(state)}`);
        return new Promise<never>(() => {});
      }),
    ]);
    const result = toolState(await pending);
    expect(result).toMatchObject({ ok: true, mode: "assist", window_title: "Workspace window" });
    expect(typeof result.session_id).toBe("string");
    return result.session_id;
  });

  await step("The floating controls show the task, selected window and remaining access", async () => {
    const panel = JSON.stringify(await world.panel());
    expect(panel).toContain("Edit the disposable fixture draft and increment its counter.");
    expect(panel).toContain("Workspace window");
    expect(panel).toContain("Access ends in");
    expect(panel).toContain("Take over");
    expect(panel).toContain("Stop");
    expect(panel).not.toContain("Other window");
  });

  await step("Hiding the task panel preserves the grant and the menu bar restores its controls", async () => {
    await world.pressControl("Hide panel");
    expect(await world.panel()).toMatchObject({ restore_help: "Show Computer Use controls" });
    expect(JSON.stringify(await world.panel())).not.toContain("Edit the disposable fixture draft");
    expect(toolState(await world.call("computer_session_status", { session_id: session }))).toMatchObject({
      state: "active", panel_visible: false, purpose: "Edit the disposable fixture draft and increment its counter.", window_title: "Workspace window",
    });
    expect(toolState(await world.peerCall("computer_session_status", { session_id: session })).code).toBe("session_unavailable");
    await world.pressControl("Show Computer Use task");
    expect(toolState(await world.call("computer_session_status", { session_id: session })).panel_visible).toBe(true);
    expect(JSON.stringify(await world.panel())).toContain("Stop");
    expect(await world.state()).toEqual({ count: 0, otherCount: 0, draft: "Initial draft" });
  });

  await step("A different connection cannot read or act through the grant", async () => {
    const other = await world.peerCall("computer_observe", { session_id: session });
    expect(other).toMatchObject({ isError: true });
    expect(toolState(other).code).toBe("session_unavailable");
    const busy = toolState(await world.peerCall("computer_open_session", { app_id: world.appId, pid: world.appPid, mode: "assist", purpose: "Try a second session." }));
    expect(busy.code).toBe("computer_busy");
  });

  const observe = async () => toolState(await world.call("computer_observe", { session_id: session }));
  const refFor = (state: Record<string, unknown>, text: string) => {
    if (!Array.isArray(state.elements)) throw new Error("No accessible elements");
    const match = state.elements.find((value: unknown) => typeof value === "object" && value !== null && "label" in value && value.label === text);
    if (typeof match !== "object" || match === null || !("ref" in match)) throw new Error(`Missing accessible control: ${text}`);
    return match.ref;
  };
  const action = (observation: Record<string, unknown>, request: string, input: Record<string, unknown>) =>
    world.call("computer_act", { session_id: session, observation_id: observation.observation_id, request_id: request, action: input });

  await step("Only the approved window is read and its protected field is omitted", async () => {
    await world.front();
    const observed = await observe();
    expect(observed).toMatchObject({ ok: true });
    expect(JSON.stringify(observed)).not.toContain("Other increment");
    expect(JSON.stringify(observed)).not.toContain("private-fixture-value");
    expect(observed.protected_fields).toBe(1);
    const denied = toolState(await action(observed, "visual-denied", { type: "click", x: 20, y: 20 }));
    expect(denied.code).toBe("scope_denied");
    expect(await world.state()).toEqual({ count: 0, otherCount: 0, draft: "Initial draft" });
  });

  await step("Read-only refresh recovers from settling content and stops on continuous changes", async () => {
    await world.refreshChanges(false);
    const settled = toolState(await world.call("computer_observe", { session_id: session, include_image: false }));
    expect(settled.ok).toBe(true);
    expect(JSON.stringify(settled)).toContain("Ready after refresh");
    expect(await world.refreshState()).toMatchObject({ reads: 4, text: "Ready after refresh" });
    await world.refreshChanges(true);
    const changing = toolState(await world.call("computer_observe", { session_id: session, include_image: false }));
    expect(changing).toMatchObject({ code: "stale_observation", next: "observe" });
    expect(await world.refreshState()).toMatchObject({ reads: 6 });
    expect(toolState(await action(settled, "after-failed-refresh", { type: "press", ref: refFor(settled, "Increment") })).code).toBe("observation_required");
    expect(await world.state()).toEqual({ count: 0, otherCount: 0, draft: "Initial draft" });
    await world.refreshStable();
    expect(await observe()).toMatchObject({ ok: true });
  });

  await step("Accessible actions update the selected window once and leave the other window alone", async () => {
    const observed = await observe();
    const press = { type: "press", ref: refFor(observed, "Increment") };
    const receipt = toolState(await action(observed, "increment-once", press));
    expect(receipt).toMatchObject({ ok: true, status: "dispatched", outcome_verified: false });
    expect(toolState(await action(observed, "increment-once", press))).toEqual(receipt);
    expect(toolState(await action(observed, "different-request", press)).code).toBe("observation_required");
    expect(await world.state()).toEqual({ count: 1, otherCount: 0, draft: "Initial draft" });
    const next = await observe();
    expect(toolState(await action(next, "write-draft", { type: "set_value", ref: refFor(next, "Draft text"), text: "Reviewed 👋🏽" })).ok).toBe(true);
    expect(await world.state()).toEqual({ count: 1, otherCount: 0, draft: "Reviewed 👋🏽" });
  });

  await step("A resized window and a paused session reject old observations", async () => {
    const observed = await observe();
    await world.resize();
    expect(toolState(await action(observed, "stale-layout", { type: "press", ref: refFor(observed, "Increment") })).code).toBe("stale_observation");
    await world.pressControl("Take over");
    expect(toolState(await world.call("computer_observe", { session_id: session })).code).toBe("session_paused");
    expect(toolState(await world.call("computer_session_status", { session_id: session }))).toMatchObject({ state: "paused", pause_reason: "You have control. Click Continue when you are ready.", next: "human_takeover" });
    await world.pressControl("Continue");
    await expect.poll(async () => toolState(await world.call("computer_session_status", { session_id: session })).state).toBe("active");
    const resumed = toolState(await world.call("computer_session_status", { session_id: session }));
    expect(resumed).toMatchObject({ state: "active", phase: "refreshing", next: "observe" });
    expect(JSON.stringify(await world.panel())).toContain("Refreshing the approved window");
    expect(resumed).not.toHaveProperty("pause_reason");
    expect(toolState(await action(observed, "pre-pause-observation", { type: "press", ref: refFor(observed, "Increment") })).code).toBe("observation_required");
    expect(await observe()).toMatchObject({ ok: true });
    expect(await world.state()).toEqual({ count: 1, otherCount: 0, draft: "Reviewed 👋🏽" });
  });

  await step("A person's typing pauses control until they explicitly resume with a fresh view", async () => {
    const before = await observe();
    expect(await world.humanEdit()).toEqual({ ok: true });
    expect(toolState(await world.call("computer_session_status", { session_id: session })).phase).toBe("person_interacting");
    expect(await world.panel()).toMatchObject({ continue_enabled: false });
    await expect.poll(async () => toolState(await world.call("computer_session_status", { session_id: session })).state).toBe("paused");
    await expect.poll(() => world.state()).toEqual({ count: 1, otherCount: 0, draft: "Edited by person" });
    await expect.poll(async () => toolState(await world.call("computer_session_status", { session_id: session })).phase).toBe("ready_to_continue");
    expect(toolState(await world.call("computer_session_status", { session_id: session })).state).toBe("paused");
    expect(await world.panel()).toMatchObject({ continue_enabled: true });
    await world.hover();
    expect(toolState(await world.call("computer_session_status", { session_id: session })).phase).toBe("ready_to_continue");
    expect(await world.panel()).toMatchObject({ continue_enabled: true });
    expect(toolState(await action(before, "after-human-edit", { type: "press", ref: refFor(before, "Increment") })).code).toBe("session_paused");
    await world.pressControl("Continue");
    await expect.poll(async () => toolState(await world.call("computer_session_status", { session_id: session })).state).toBe("active");
    expect(toolState(await action(before, "after-human-resume", { type: "press", ref: refFor(before, "Increment") })).code).toBe("observation_required");
    expect(toolState(await world.call("computer_session_status", { session_id: session })).phase).toBe("refreshing");
    expect(JSON.stringify(await observe())).toContain("Edited by person");
    expect(toolState(await world.call("computer_session_status", { session_id: session })).phase).toBe("working");
  });

  await step("Stop revokes the session immediately and leaves both windows intact", async () => {
    await world.pressControl("Stop");
    expect(toolState(await world.call("computer_observe", { session_id: session })).code).toBe("session_unavailable");
    expect(await world.state()).toEqual({ count: 1, otherCount: 0, draft: "Edited by person" });
    expect(toolState(await world.call("cua_screenshot")).code).toBe("unknown_tool");
    expect(await world.panel()).toMatchObject({ restore_available: false });
  });

  await step("Pausing an in-flight drag releases the pointer and never resumes the old path", async () => {
    // Remove the text caret before verifying a static drag surface.
    await world.prepareDrag();
    const pending = world.call("computer_open_session", { app_id: world.appId, pid: world.appPid, mode: "control", purpose: "Drag inside the disposable fixture, then hand control back." });
    await world.selectWindow();
    await world.pressControl("Allow and start");
    const opened = toolState(await pending);
    expect(opened).toMatchObject({ ok: true, state: "active", window_title: "Workspace window" });
    const id = opened.session_id;
    await expect.poll(() => world.foregroundWindow()).toEqual({ title: "Workspace window" });
    await expect.poll(async () => toolState(await world.call("computer_session_status", { session_id: id })).state).toBe("active");
    const observed = toolState(await world.call("computer_observe", { session_id: id }));
    expect(observed, JSON.stringify(observed)).toMatchObject({ ok: true });
    const elements = observed.elements;
    if (!Array.isArray(elements)) throw new Error("No controls in drag observation");
    const surface = elements.find((element: unknown) => typeof element === "object" && element !== null && "label" in element && element.label === "Drag surface");
    if (typeof surface !== "object" || surface === null || !("bounds" in surface)) throw new Error("Drag surface is missing");
    const bounds: unknown = surface.bounds;
    if (typeof bounds !== "object" || bounds === null || !("x" in bounds) || !("y" in bounds) || typeof bounds.x !== "number" || typeof bounds.y !== "number") throw new Error("Drag surface bounds are missing");
    const x = bounds.x + 10;
    const y = bounds.y + 10;
    const path = Array.from({ length: 32 }, (_, index) => ({ x: x + index, y }));
    const drag = world.call("computer_act", { session_id: id, observation_id: observed.observation_id, request_id: "interrupt-drag", action: { type: "drag", path } });
    await Promise.race([
      expect.poll(() => world.dragState(), { timeout: 10_000, interval: 20 }).toMatchObject({ downs: 1 }),
      drag.then(async (reply) => { throw new Error(`Drag finished before takeover: ${JSON.stringify(toolState(reply))}; ${JSON.stringify(await world.dragState())}; surface ${JSON.stringify(bounds)}`); }),
    ]);
    await world.pressControl("Take over");
    const interrupted = toolState(await drag);
    expect(interrupted).toMatchObject({ ok: false, may_have_acted: true, next: "human_takeover" });
    await expect.poll(() => world.dragState()).toMatchObject({ downs: 1, ups: 1 });
    const stopped = await world.dragState();
    await world.pressControl("Continue");
    await expect.poll(async () => toolState(await world.call("computer_session_status", { session_id: id })).state).toBe("active");
    expect(await world.dragState()).toEqual(stopped);
    expect(toolState(await world.call("computer_act", { session_id: id, observation_id: observed.observation_id, request_id: "old-drag", action: { type: "drag", path } })).code).toBe("observation_required");
    await world.pressControl("Take over");
    await world.minimize();
    await expect.poll(() => world.minimized()).toEqual({ minimized: true });
    await world.pressControl("Continue");
    await expect.poll(async () => toolState(await world.call("computer_session_status", { session_id: id }))).toMatchObject({ state: "paused", pause_reason: "The approved window is closed, minimized, or no longer on this desktop.", next: "human_takeover" });
    expect(await world.dragState()).toEqual(stopped);
    await world.restore();
    await expect.poll(() => world.minimized()).toEqual({ minimized: false });
    await world.pressControl("Continue");
    await expect.poll(async () => toolState(await world.call("computer_session_status", { session_id: id })).state).toBe("active");
    expect(await world.dragState()).toEqual(stopped);
    await world.pressControl("Stop");
    expect(toolState(await world.call("computer_session_status", { session_id: id })).code).toBe("session_unavailable");
    expect(await world.state()).toEqual({ count: 1, otherCount: 0, draft: "Edited by person" });
  });

});

test("Computer Use enables workspace tools from the desktop setup page", async ({ world, step }) => {
  await using app = await world.desktop();
  const { workspaceId } = await createAndSelectWorkspace(app, { path: world.workspacePath });
  await step("Granted macOS access still requires explicit workspace enablement", async () => {
    await evalIn(app, browserScript((value) => (location.hash = value), [`#/workspace/${workspaceId}/extensions/computer-use`]));
    await waitFor(app, () => (document.body.innerText.includes("Permissions are ready. Enable Computer Use for this workspace.")), { timeoutMs: 60_000 });
    expect(await evalIn(app, () => ([...document.querySelectorAll("button")].some(b => b.textContent.trim() === "Enable Computer Use" && !b.disabled)))).toBe(true);
  });
  await step("Enable resolves the bundled helper and reaches Ready", async () => {
    await evalIn(app, () => ([...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Enable Computer Use")?.click()));
    await waitFor(app, () => (document.body.innerText.includes("Ready · app access is approved when a session starts")), { timeoutMs: 60_000 }).catch(async (error) => {
      throw new Error(`${String(error)}; setup: ${await evalIn(app, () => document.body.innerText)}`);
    });
    expect(await evalIn(app, () => ([...document.querySelectorAll("button")].some(b => /^(Enable|Reconnect) Computer Use$/.test(b.textContent.trim()))))).toBe(false);
  });
  const workspaceMcp = (body?: unknown) => evalIn(app, browserScript(async (id, body) => {
    const response = await fetch(`http://127.0.0.1:${localStorage.getItem("openwork.server.port")}/workspace/${id}/mcp`, {
      method: body === null ? "GET" : "POST",
      headers: { Authorization: `Bearer ${localStorage.getItem("openwork.server.token")}`, "Content-Type": "application/json" },
      body, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Workspace MCP request failed: ${response.status}`);
    return response.json();
  }, [workspaceId, body === undefined ? null : JSON.stringify(body)]), { awaitPromise: true });
  const configuredCommand = async () => {
    const value = await workspaceMcp();
    if (typeof value !== "object" || value === null || !("items" in value) || !Array.isArray(value.items)) throw new Error("Missing workspace MCP configuration");
    const computer = value.items.find((entry: unknown) => typeof entry === "object" && entry !== null && "name" in entry && entry.name === "computer-use");
    if (typeof computer !== "object" || computer === null || !("config" in computer) || typeof computer.config !== "object" || computer.config === null || !("command" in computer.config)) throw new Error("Missing Computer Use command");
    return computer.config.command;
  };
  const command = await configuredCommand();
  expect(command).toEqual(await evalIn(app, () => window.__OPENWORK_ELECTRON__.invokeDesktop("getComputerUseMcpCommand")));
  await using computer = await world.hostedClient(command);
  const observeWhenQuiet = async (sessionId: unknown) => {
    const deadline = Date.now() + 5_000;
    while (true) {
      const state = toolState(await computer.call("computer_observe", { session_id: sessionId }));
      // A local Mac can receive person input during setup. Follow the tool's
      // wait/requery contract, but never retry input or mask other errors.
      if (state.code !== "user_interacting" || Date.now() >= deadline) return state;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  const session = await step("Main-app approval starts the selected window without a second Continue", async () => {
    const pending = computer.call("computer_open_session", { app_id: world.appId, pid: world.appPid, mode: "control", purpose: "Use the disposable workspace from OpenWork." });
    await Promise.race([
      waitFor(app, () => Boolean(document.querySelector('select[aria-label="Window to allow"]')), { timeoutMs: 15_000 }).catch(async (error) => {
        throw new Error(`${String(error)}; host state: ${JSON.stringify(await evalIn(app, () => window.__OPENWORK_ELECTRON__.invokeDesktop("getComputerUseState")))}`);
      }),
      pending.then((reply) => { throw new Error(`Session ended before approval: ${JSON.stringify(toolState(reply))}`); }),
    ]);
    await expect(computer.request("openwork/ui", { action: "approve" })).rejects.toThrow("Method not available to the agent");
    expect(await evalIn(app, () => document.body.innerText.includes("Allow and start"))).toBe(true);
    await screenshot(app);
    await evalIn(app, () => {
      const picker = document.querySelector('select[aria-label="Window to allow"]');
      if (!(picker instanceof HTMLSelectElement)) throw new Error("No window picker");
      const option = [...picker.options].find((item) => item.text === "Workspace window");
      if (!option) throw new Error("Missing fixture window");
      picker.value = option.value; picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await evalIn(app, () => [...document.querySelectorAll("button")].find((button) => button.textContent.trim() === "Allow and start")?.click());
    const opened = toolState(await pending);
    expect(opened).toMatchObject({ ok: true, state: "active", window_title: "Workspace window" });
    expect(await world.foregroundWindow()).toEqual({ title: "Workspace window" });
    return opened.session_id;
  });
  const host = await evalIn(app, () => window.__OPENWORK_ELECTRON__.invokeDesktop("getComputerUseState"));
  if (!Array.isArray(host) || typeof host[0] !== "object" || host[0] === null || !("helperPid" in host[0])) throw new Error("Missing native preview owner");
  const previewPid = host[0].helperPid;
  await step("Normal work has a native preview and no persistent control dashboard", async () => {
    const observed = await observeWhenQuiet(session);
    expect(observed).toMatchObject({ ok: true });
    expect(JSON.stringify(observed)).not.toContain("Other increment");
    const preview = JSON.stringify(await world.hostedPanel(previewPid));
    expect(preview).toContain("Latest approved window observation");
    expect(preview).toContain("Stop");
    expect(preview).not.toContain("Take over");
    await waitFor(app, () => ![...document.querySelectorAll('[aria-label="Computer Use controls"] button')].some((b) => /Continue|Take over|Stop/.test(b.textContent)));
    await screenshot(app);
    await world.hostedControl(previewPid, "Hide");
    expect(toolState(await computer.call("computer_session_status", { session_id: session }))).toMatchObject({ state: "active", panel_visible: false });
    await waitFor(app, () => [...document.querySelectorAll("button")].some((b) => /^Show .+ preview$/.test(b.textContent.trim())));
    await evalIn(app, () => [...document.querySelectorAll("button")].find((b) => /^Show .+ preview$/.test(b.textContent.trim()))?.click());
    await expect.poll(async () => toolState(await computer.call("computer_session_status", { session_id: session })).panel_visible).toBe(true);
  });
  await step("Person input requires a quiet period and fresh state, without a Continue click", async () => {
    const before = await observeWhenQuiet(session);
    expect(before, JSON.stringify(before)).toMatchObject({ ok: true });
    await world.humanEdit();
    await expect.poll(async () => toolState(await computer.call("computer_session_status", { session_id: session })).phase).toBe("person_interacting");
    expect(toolState(await computer.call("computer_observe", { session_id: session }))).toMatchObject({ code: "user_interacting", next: "wait_then_observe" });
    expect(toolState(await computer.call("computer_act", { session_id: session, observation_id: before.observation_id, request_id: "interrupted-input", action: { type: "click", x: 20, y: 20 } })).code).toBe("user_interacting");
    await expect.poll(async () => toolState(await computer.call("computer_session_status", { session_id: session })).phase, { timeout: 5_000 }).toBe("requery_required");
    // Time passing alone must not resume or reuse the old observation.
    expect(toolState(await computer.call("computer_session_status", { session_id: session })).state).toBe("paused");
    expect(toolState(await computer.call("computer_act", { session_id: session, observation_id: before.observation_id, request_id: "after-quiet-input", action: { type: "click", x: 20, y: 20 } })).code).toBe("requery_required");
    const refreshed = toolState(await computer.call("computer_observe", { session_id: session }));
    expect(refreshed).toMatchObject({ ok: true });
    expect(JSON.stringify(refreshed)).toContain("Edited by person");
    expect(refreshed.observation_id).not.toBe(before.observation_id);
    expect(toolState(await computer.call("computer_session_status", { session_id: session }))).toMatchObject({ state: "active", phase: "working" });
    expect(await world.state()).toEqual({ count: 0, otherCount: 0, draft: "Edited by person" });
  });
  await step("New person input during the state requery interrupts recovery again", async () => {
    await world.humanEdit();
    await expect.poll(async () => toolState(await computer.call("computer_session_status", { session_id: session })).phase, { timeout: 5_000 }).toBe("requery_required");
    await world.interruptNextRead();
    expect(toolState(await computer.call("computer_observe", { session_id: session })).code).toBe("user_interacting");
    expect(toolState(await computer.call("computer_session_status", { session_id: session })).state).toBe("paused");
    await expect.poll(async () => toolState(await computer.call("computer_session_status", { session_id: session })).phase, { timeout: 5_000 }).toBe("requery_required");
    expect(toolState(await computer.call("computer_observe", { session_id: session })).ok).toBe(true);
    expect(await world.state()).toEqual({ count: 0, otherCount: 0, draft: "Edited by person" });
  });
  await step("Unavailable-window recovery requires a person and cannot be cleared by more input", async () => {
    await world.humanEdit();
    await expect.poll(async () => toolState(await computer.call("computer_session_status", { session_id: session })).phase, { timeout: 5_000 }).toBe("requery_required");
    await world.minimize();
    await expect.poll(() => world.minimized()).toEqual({ minimized: true });
    expect(toolState(await computer.call("computer_observe", { session_id: session })).code).toBe("session_paused");
    await waitFor(app, () => [...document.querySelectorAll('[aria-label="Computer Use controls"] button')].some((b) => b.textContent.trim() === "Continue"));
    await world.restore();
    await world.humanEdit();
    expect(toolState(await computer.call("computer_observe", { session_id: session })).code).toBe("session_paused");
    await evalIn(app, () => [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Computer Use controls"] button')].find((b) => b.textContent.trim() === "Continue")?.click());
    await expect.poll(async () => toolState(await computer.call("computer_session_status", { session_id: session })).state).toBe("active");
    expect(await observeWhenQuiet(session)).toMatchObject({ ok: true });
    expect(await world.state()).toEqual({ count: 0, otherCount: 0, draft: "Edited by person" });
  });
  await step("Explicit Stop ends access; observing cannot restart the stopped session", async () => {
    await world.hostedControl(previewPid, "Stop");
    await expect.poll(async () => toolState(await computer.call("computer_session_status", { session_id: session })).code).toBe("session_unavailable");
    expect(toolState(await computer.call("computer_observe", { session_id: session })).code).toBe("session_unavailable");
    await waitFor(app, () => !document.querySelector('[aria-label="Computer Use controls"]'));
    expect(await world.state()).toEqual({ count: 0, otherCount: 0, draft: "Edited by person" });
  });
  await step("Cancelling pending approval clears the request without granting access", async () => {
    const pending = computer.call("computer_open_session", { app_id: world.appId, pid: world.appPid, mode: "observe", purpose: "Cancel this disposable approval request." });
    await waitFor(app, () => Boolean(document.querySelector('select[aria-label="Window to allow"]')));
    computer.cancelPending();
    expect(toolState(await pending).ok).toBe(false);
    await waitFor(app, () => !document.querySelector('[aria-label="Computer Use controls"]'));
    expect(await world.state()).toEqual({ count: 0, otherCount: 0, draft: "Edited by person" });
  });
  await step("Disconnecting the owning client removes its preview and releases the grant", async () => {
    const pending = computer.call("computer_open_session", { app_id: world.appId, pid: world.appPid, mode: "observe", purpose: "Close the disposable client after approval." });
    await waitFor(app, () => Boolean(document.querySelector('select[aria-label="Window to allow"]')));
    await evalIn(app, () => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Allow and start")?.click());
    expect(toolState(await pending).ok).toBe(true);
    await computer.close();
    await waitFor(app, () => !document.querySelector('[aria-label="Computer Use controls"]'));
    // A new request reaching consent proves the global lease was released.
    await using next = await world.hostedClient(command);
    const approval = next.call("computer_open_session", { app_id: world.appId, pid: world.appPid, mode: "observe", purpose: "Check released control without granting access." });
    await waitFor(app, () => Boolean(document.querySelector('select[aria-label="Window to allow"]')));
    next.cancelPending();
    expect(toolState(await approval).ok).toBe(false);
    await waitFor(app, () => !document.querySelector('[aria-label="Computer Use controls"]'));
    expect(await world.state()).toEqual({ count: 0, otherCount: 0, draft: "Edited by person" });
  });
  await step("Reopening a workspace upgrades its enabled bundled connection to main-app controls", async () => {
    if (!Array.isArray(command) || typeof command[0] !== "string") throw new Error("Missing bundled executable");
    await workspaceMcp({ name: "computer-use", config: { type: "local", command: [command[0], "mcp"], enabled: true } });
    expect(await configuredCommand()).toEqual([command[0], "mcp"]);
    await evalIn(app, () => location.reload());
    await expect.poll(configuredCommand, { timeout: 30_000 }).toEqual(command);
    await waitFor(app, () => document.body.innerText.includes("Ready · app access is approved when a session starts"), { timeoutMs: 15_000 });
  });
  await step("Reload preserves disabled bundled commands and enabled custom commands", async () => {
    if (!Array.isArray(command) || typeof command[0] !== "string") throw new Error("Missing bundled executable");
    const disabled = { type: "local", command: [command[0], "mcp"], enabled: false };
    await workspaceMcp({ name: "computer-use", config: disabled });
    await evalIn(app, () => location.reload());
    await waitFor(app, () => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Enable Computer Use"));
    expect(await evalIn(app, () => [...document.querySelectorAll("span")].some((s) => s.textContent.trim() === "Ready"))).toBe(false);
    expect(await workspaceMcp()).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ name: "computer-use", config: disabled })]) });
    const custom = { type: "local", command: [command[0], "mcp", "custom-fixture-argument"], enabled: true };
    await workspaceMcp({ name: "computer-use", config: custom });
    await evalIn(app, () => location.reload());
    await waitFor(app, () => document.body.innerText.includes("Ready · app access is approved when a session starts"), { timeoutMs: 15_000 });
    expect(await evalIn(app, () => [...document.querySelectorAll("button")].some((b) => /^(Enable|Reconnect) Computer Use$/.test(b.textContent.trim())))).toBe(false);
    expect(await workspaceMcp()).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ name: "computer-use", config: custom })]) });
  });
});

test("Computer Use prepares an Electron accessibility tree before window consent", async ({ world, step }) => {
  await using electron = await world.electronFixture();
  await step("A fresh Electron app starts with its accessibility tree disabled", async () => {
    expect(await electron.state()).toEqual({ accessibility: false });
  });
  const session = await step("Opening a session enables the tree and still requires window approval", async () => {
    const pending = world.call("computer_open_session", { app_id: electron.appId, pid: electron.pid, mode: "observe", purpose: "Read the disposable Electron fixture." });
    await Promise.race([
      world.pressControl("Allow this session"),
      pending.then((reply) => {
        const state = toolState(reply);
        if (state.ok !== true) throw new Error(`Electron session did not request consent: ${JSON.stringify(state)}`);
        return new Promise<never>(() => {});
      }),
    ]);
    const result = toolState(await pending);
    expect(result).toMatchObject({ ok: true, mode: "observe", window_title: "Electron Fixture" });
    return result.session_id;
  });
  await step("The approved Electron window exposes its rendered controls", async () => {
    // Chromium's accessibility flag can precede its rendered subtree.
    await expect.poll(async () => JSON.stringify(toolState(await world.call("computer_observe", { session_id: session, include_image: false })))).toContain("Fixture action");
    const observation = toolState(await world.call("computer_observe", { session_id: session }));
    expect(observation.ok).toBe(true);
    expect(JSON.stringify(observation)).toContain("Fixture action");
    expect(JSON.stringify(observation)).toContain("Fixture draft value");
    expect(toolState(await world.call("computer_close_session", { session_id: session }))).toMatchObject({ ok: true });
  });
  await step("An installed but closed app launches before requesting window consent", async () => {
    await using launchable = await world.launchableFixture();
    const before = toolState(await world.call("computer_discover"));
    expect(before.apps).not.toEqual(expect.arrayContaining([expect.objectContaining({ app_id: launchable.appId })]));
    const pending = world.call("computer_open_session", { app_id: launchable.appId, mode: "observe", purpose: "Open and read the disposable launch fixture." });
    await Promise.race([
      world.pressControl("Allow this session"),
      pending.then((reply) => { if (toolState(reply).ok !== true) throw new Error(`App launch failed: ${JSON.stringify(toolState(reply))}`); return new Promise<never>(() => {}); }),
    ]);
    const reply = await pending;
    const opened = toolState(reply);
    expect(opened).toMatchObject({ ok: true, app_id: launchable.appId, mode: "observe" });
    expect(toolState(await world.call("computer_discover")).apps).toEqual(expect.arrayContaining([expect.objectContaining({ app_id: launchable.appId, pid: opened.pid })]));
    expect(toolState(await world.call("computer_observe", { session_id: opened.session_id })).ok).toBe(true);
    expect(toolState(await world.call("computer_close_session", { session_id: opened.session_id })).ok).toBe(true);
    expect(toolState(await world.call("computer_open_session", { app_id: "com.apple.Terminal", mode: "observe", purpose: "Reject a protected app." })).code).toBe("protected_app");
  });
});
