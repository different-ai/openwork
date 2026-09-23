import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { browserScript, spec, resolveEvalEngine, type SpecBodyContext } from "@openwork/testkit";
import { engineLiveDesktop } from "../worlds/engine-live-desktop.ts";
import { record } from "../worlds/engine-live-parity.ts";

const test = spec.world(engineLiveDesktop, { timeout: 900_000,
  resources: { surfaces: ["desktop"], services: ["den", "mock"], nativeReason: "Use real inference with native local providers, local processes and conversation controls. Only the external connector is a controlled witness." },
  needs: { placement: "local", env: ["OPENWORK_EVAL_ENGINE"] },
});

test(`LIVE-CONNECTORS ${resolveEvalEngine()}: the real model searches Den capabilities and executes the discovered connector`, async ctx => {
  const { world, step, evidence } = ctx;
  await ready(ctx);
  const initial = `READY-${randomUUID().slice(0, 8)}`;
  await turn(ctx, `Reply exactly ${initial}. Do not use tools.`, initial);
  const route = await world.route();
  const documentIdentity = await world.documentIdentity();
  const runtime = (await world.request("/experimental/engine-v2-preview/status")).body;
  const connector = await world.connectReports();
  await step("Discover the assigned report capability and execute its current ID", async () => {
    await turn(ctx, "Use the openwork-cloud connection: search_capabilities for current_amber_report, then execute_capability with the name returned by search. Report the exact report text. Do not guess its name or read files.", connector.proof);
    expect(await connector.toolCalls()).toMatchObject([{ name: "current_amber_report", args: {} }]);
  });
  await step("Return a connector failure honestly in the same conversation", async () => {
    await turn(ctx, "Use openwork-cloud search_capabilities for unavailable_violet_status, then execute_capability on that discovered capability. If the service fails, reply UNAVAILABLE. Do not invent a status.", "UNAVAILABLE");
    expect((await connector.toolCalls()).map(call => call.name)).toEqual(["current_amber_report", "unavailable_violet_status"]);
  });
  expect(await world.route()).toBe(route);
  expect(await world.documentIdentity()).toBe(documentIdentity);
  if (world.engine === "v2") {
    expect((await world.request("/experimental/engine-v2-preview/status")).body).toMatchObject({ pid: record(runtime) ? runtime.pid : undefined });
    expect(await world.reloadRequests()).toEqual([]);
  }
  evidence.recordAssertionEvidence("Real inference and real Den capability routing", "The model was real, as were Den search, capability IDs, execution and the engine. Only the external report service was controlled; it independently witnessed both calls and held the fresh result outside the model prompt.", true);
});
type Context = SpecBodyContext<Awaited<ReturnType<typeof engineLiveDesktop>>>;

async function openSavedConversation(ctx: Context, sessionId: string) {
  const row = await ctx.probe.eventually(() => ctx.probe.eval(browserScript(id => {
    const element = document.querySelector(`[data-session-tab-id="${id}"]`);
    const label = element?.getAttribute("aria-label");
    if (!element || !label) return null;
    const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(button => button.getAttribute("aria-label") === label);
    return { label, nth: buttons.indexOf(element) };
  }, [sessionId])), { within: 30_000, label: "saved conversation appears in the sidebar", until: row => row !== null && row.nth >= 0 });
  if (!row) throw new Error("Saved conversation has no sidebar entry");
  await ctx.user.click({ role: "button", ...row });
}

async function chooseNativeMenu(ctx: Context, label: string) {
  // macOS menus have no DOM/CDP target. Use the existing development bridge
  // to select an enabled entry from the real popup opened by a user gesture.
  const menu = await ctx.probe.eventually(() => ctx.probe.eval(browserScript(() => window.__OPENWORK_ELECTRON__.contextMenu.inspect(), []), { awaitPromise: true }), {
    within: 15_000, label: "native context menu opens", until: menu => record(menu) && menu.open === true,
  });
  const current = record(menu) && record(menu.current) ? menu.current : null;
  const item = current && Array.isArray(current.items) ? current.items.find(item => record(item) && item.label === label && item.enabled !== false) : null;
  if (!record(item) || typeof item.id !== "string") throw new Error(`The native menu has no enabled ${label} item`);
  expect(await ctx.probe.eval(browserScript(id => window.__OPENWORK_ELECTRON__.contextMenu.choose(id), [item.id]), { awaitPromise: true })).toBe(true);
}

async function ready({ world, user, probe, step }: Context) {
  await user.see("composer", { editable: true, timeoutMs: 90_000 });
  await probe.eventually(() => probe.composer(), { within: 90_000, label: "initial boot settled with a model", until: state => !state.modelUnavailable });
  const gateway = await world.stageGateway();
  const provider = gateway?.name ?? process.env.OPENWORK_LIVE_PROVIDER;
  if (provider) await step("Connect the real provider using the app's masked API-key form", async () => {
    const keyName = process.env.OPENWORK_LIVE_KEY_ENV;
    const key = gateway?.key ?? (keyName ? process.env[keyName]?.trim() : undefined);
    if (!key) throw new Error("Live provider requested without a credential; no mock fallback is allowed");
    await user.click({ role: "button", label: "Change model" });
    await user.click({ role: "button", label: /^Model\s/ });
    await user.click({ role: "button", label: "Connect more providers" });
    const settings = await probe.eventually(() => probe.eval(browserScript(() => {
      if (document.querySelector('input[placeholder="Filter providers by name or ID"]')) return "modal";
      if ([...document.querySelectorAll("button")].some(button => button.textContent?.trim() === "Connect provider")) return "settings";
      return "loading";
    }, [])), { within: 30_000, label: "provider connection entry", until: entry => entry !== "loading" });
    if (settings === "settings") await user.click({ role: "button", label: "Connect provider" });
    await user.type({ placeholder: "Filter providers by name or ID" }, provider);
    await user.click({ role: "button", label: new RegExp(`^${provider}`) });
    if (provider === "OpenAI") await user.click({ role: "button", label: /^Manually enter API Key/ });
    await user.type({ placeholder: "sk-..." }, key, { sensitive: true });
    await user.click({ role: "button", label: "Save key" });
    if (settings === "settings") await user.click({ role: "button", label: "Back to app" });
    else await user.press("Escape");
    const model = gateway?.modelId ?? process.env.OPENWORK_LIVE_MODEL;
    if (!model) throw new Error("Specify OPENWORK_LIVE_MODEL for the connected provider");
    await world.selectModel(model);
  });
  await probe.eventually(() => probe.composer(), { within: 90_000, label: "real model available", until: state => !state.modelUnavailable });
  return gateway ? { modelId: gateway.modelId, secondModelId: gateway.secondModelId } : null;
}

async function turn(ctx: Context, prompt: string, expected: string, pane: "primary" | "secondary" = "primary") {
  const { world, user, probe, evidence } = ctx;
  const sessionId = await probe.eval(browserScript((pane) => document.querySelector(`[data-workbench-pane="${pane}"] [data-session-surface-id]`)?.getAttribute("data-session-surface-id") ?? undefined, [pane]));
  const before = new Set((sessionId ? await world.messages(sessionId) : []).filter(record).map(message => record(message.info) ? message.info.id : message.id));
  await user.type({ placeholder: "Describe your task...", nth: pane === "primary" ? 0 : 1 }, prompt, { replace: true });
  await user.press("Enter");
  const started = Date.now();
  let answer = "";
  while (Date.now() - started < 120_000) {
    const currentSessionId = sessionId ?? await probe.eval(browserScript((pane) => document.querySelector(`[data-workbench-pane="${pane}"] [data-session-surface-id]`)?.getAttribute("data-session-surface-id") ?? undefined, [pane]));
    if (!currentSessionId) { await new Promise(resolve => setTimeout(resolve, 100)); continue; }
    const messages = (await world.messages(currentSessionId)).filter(record).filter(message => !before.has(record(message.info) ? message.info.id : message.id));
    for (const message of messages) {
      const info = record(message.info) ? message.info : message;
      if (info.error) throw new Error(`Real inference failed: ${JSON.stringify(info.error)}`);
    }
    answer = await probe.eval(browserScript((pane) => {
      const root = document.querySelector(`[data-workbench-pane="${pane}"]`) ?? document;
      return [...root.querySelectorAll<HTMLElement>('[data-message-role="assistant"]')].at(-1)?.innerText ?? "";
    }, [pane]));
    const complete = messages.some(message => {
      const info = record(message.info) ? message.info : message;
      return (info.role === "assistant" || info.type === "assistant") && record(info.time) && typeof info.time.completed === "number" && info.finish === "stop";
    });
    if (complete && answer.includes(expected)) {
      evidence.recordJsonArtifact("Completed real model turn", { engine: world.engine, pane, elapsedMs: Date.now() - started,
        answer, generated: messages.map(message => { const info = record(message.info) ? message.info : message; return { role: info.role ?? info.type, model: info.model ?? info.modelID, tokens: info.tokens, finish: info.finish }; }) });
      await user.screenshot();
      return answer;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  evidence.recordJsonArtifact("Incomplete real model turn", { expected, answer, messages: await world.messages(sessionId) });
  throw new Error(`Real model did not complete the expected answer; received ${answer.slice(0, 400)}`);
}

test(`LIVE-CHAT ${resolveEvalEngine()}: revert, restore and edit a real conversation`, async ctx => {
  const { world, user, probe, step } = ctx;
  await ready(ctx);
  const first = `FIRST-${randomUUID().slice(0, 8)}`;
  await step("Start a real conversation", () => turn(ctx, `Reply exactly ${first}. Do not use tools.`, first));
  const route = await world.route();
  const documentIdentity = await world.documentIdentity();
  const second = `SECOND-${randomUUID().slice(0, 8)}`;
  await step("A second turn receives a fresh answer", () => turn(ctx, `Reply exactly ${second}. Do not use tools.`, second));
  await step("Revert hides the last turn and Restore brings its history back", async () => {
    await probe.eval(browserScript(() => {
      const warn = console.warn;
      console.warn = (...args) => { if (String(args[0]).includes("revert")) sessionStorage.setItem("live-revert-error", JSON.stringify(args)); warn(...args); };
    }, []));
    // The bubble's own wrapper receives pointer events over the text node.
    await user.rightClick({ text: `Reply exactly ${second}. Do not use tools.` }, { hitTest: false });
    await chooseNativeMenu(ctx, "Revert");
    try { await user.see({ testId: "reverted-messages-banner" }); }
    catch (error) { ctx.evidence.recordJsonArtifact("Conversation mutation diagnostics", { ...(await world.conversationDiagnostics()), warning: await probe.eval(browserScript(() => sessionStorage.getItem("live-revert-error"), [])) }); throw error; }
    await user.notSee({ text: second });
    await user.click({ role: "button", label: "Restore" });
    await user.see({ text: second });
    expect(await world.route()).toBe(route);
  });
  await step("Edit and resend replaces the old answer without losing the first turn", async () => {
    await user.rightClick({ text: `Reply exactly ${second}. Do not use tools.` }, { hitTest: false });
    await chooseNativeMenu(ctx, "Edit message");
    const edited = `EDITED-${randomUUID().slice(0, 8)}`;
    await turn(ctx, `Reply exactly ${edited}. Do not use tools.`, edited);
    await user.notSee({ text: second });
    await user.see({ text: first });
    expect(await world.route()).toBe(route);
  });
  expect(await world.documentIdentity()).toBe(documentIdentity);
  if (world.engine === "v2") expect(await world.reloadRequests()).toEqual([]);
});

test(`LIVE-FORK ${resolveEvalEngine()}: branch at a chosen answer and preserve the original conversation`, async ctx => {
  const { world, user, probe, step } = ctx;
  await ready(ctx);
  const first = `FIRST-${randomUUID().slice(0, 8)}`;
  const second = `SECOND-${randomUUID().slice(0, 8)}`;
  await turn(ctx, `Reply exactly ${first}. Do not use tools.`, first);
  await turn(ctx, `Reply exactly ${second}. Do not use tools.`, second);
  const route = await world.route();
  const documentIdentity = await world.documentIdentity();
  await step("Fork creates a new conversation and leaves the original intact", async () => {
    const branchIndex = await probe.eval(browserScript(marker => {
      const groups = [...document.querySelectorAll('[class~="group/message-group"]')];
      const group = groups.find(group => [...group.querySelectorAll<HTMLElement>('[data-message-role="assistant"]')].some(message => message.innerText.includes(marker)));
      const button = group?.querySelector('button[aria-label="Branch in new chat"]');
      return button ? [...document.querySelectorAll('button[aria-label="Branch in new chat"]')].indexOf(button) : -1;
    }, [first]));
    expect(branchIndex).toBeGreaterThanOrEqual(0);
    await user.hover({ text: new RegExp(`^${first}$`) });
    await user.click({ role: "button", label: "Branch in new chat", nth: branchIndex });
    await probe.eventually(() => world.route(), { within: 30_000, label: "fork gets a distinct session", until: current => current !== route && /\/session\//.test(current) });
    await user.see({ text: first });
    const fork = `FORK-${randomUUID().slice(0, 8)}`;
    await turn(ctx, `Reply exactly ${fork}. Do not use tools.`, fork);
    const sourceId = /\/session\/([^/?#]+)/.exec(route)?.[1];
    expect(JSON.stringify(await world.messages(sourceId))).toContain(second);
    expect(JSON.stringify(await world.messages(sourceId))).not.toContain(fork);
    await user.notSee({ text: second });
  });
  expect(await world.documentIdentity()).toBe(documentIdentity);
  if (world.engine === "v2") expect(await world.reloadRequests()).toEqual([]);
});

test(`LIVE-SIDE ${resolveEvalEngine()}: answer independently in a side chat and reopen its history`, async ctx => {
  const { world, user, probe, step } = ctx;
  await ready(ctx);
  const initial = `MAIN-${randomUUID().slice(0, 8)}`;
  await turn(ctx, `Reply exactly ${initial}. Do not use tools.`, initial);
  const documentIdentity = await world.documentIdentity();
  await step("A side chat answers independently while the main conversation stays open", async () => {
    const main = await world.route();
    await user.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
    await user.type({ placeholder: "Search actions and settings…" }, "new split");
    await user.click({ role: "option", label: /^Open side chat/ });
    await user.see({ placeholder: "Describe your task...", nth: 1 }, { editable: true });
    const side = `SIDE-${randomUUID().slice(0, 8)}`;
    await turn(ctx, `Reply exactly ${side}. Do not use tools.`, side, "secondary");
    expect(await world.route()).toBe(main);
    const sideId = await probe.eval(browserScript(() => document.querySelector('[data-workbench-pane="secondary"] [data-session-surface-id]')?.getAttribute("data-session-surface-id"), []));
    expect(sideId).toBeTruthy();
    await user.click({ role: "button", label: "Close side chat" });
    await probe.eventually(() => probe.dom('[data-workbench-pane="secondary"]'), {
      within: 10_000, label: "the side pane closes", until: state => state.elements.length === 0,
    });
    expect(await probe.eval(browserScript(() => [...document.querySelectorAll<HTMLElement>('[data-workbench-pane="primary"] [data-message-role="assistant"]')].map(message => message.innerText).join("\n"), []))).not.toContain(side);
    if (!sideId) throw new Error("Missing saved side conversation ID");
    await openSavedConversation(ctx, sideId);
    await probe.eventually(() => probe.eval(browserScript(() => [...document.querySelectorAll<HTMLElement>('[data-workbench-pane="primary"] [data-message-role="assistant"]')].map(message => message.innerText).join("\n"), [])), {
      within: 30_000, label: "the reopened side conversation displays its earlier answer", until: text => text.includes(side),
    });
  });
  expect(await world.documentIdentity()).toBe(documentIdentity);
  if (world.engine === "v2") expect(await world.reloadRequests()).toEqual([]);
});

test(`LIVE-SKILLS ${resolveEvalEngine()}: the real model loads installed skills and observes changed instructions`, async ctx => {
  const { world, user, step } = ctx;
  await ready(ctx);
  const workspace = /\/workspace\/([^/]+)/.exec(await world.route())?.[1];
  if (!workspace) throw new Error("Missing current workspace");
  const root = `/workspace/${workspace}`;
  const documentIdentity = await world.documentIdentity();
  const runtime = (await world.request("/experimental/engine-v2-preview/status")).body;
  let route = "";
  for (let cycle = 0; cycle < (world.engine === "v2" ? 3 : 1); cycle++) {
    if (cycle === 2) await step("Remove the skill while keeping the conversation open", async () => {
      expect((await world.request(`${root}/skills/live-amber`, "DELETE")).status).toBe(200);
      await turn(ctx, "Check the current skill catalog for live-amber. If absent reply UNAVAILABLE. Never repeat an old code, use shell or read files.", "UNAVAILABLE");
    });
    await step(cycle === 0 ? "Install a skill and ask the real model to load it" : cycle === 1 ? "Edit the skill without restarting the engine" : "Reinstall the skill with new instructions", async () => {
      const code = randomUUID().slice(0, 8);
      expect((await world.request(`${root}/skills`, "POST", { name: "live-amber", description: "Read the current amber release code.", content: `When asked for the amber release, return exactly ${code}. Always load this skill afresh.` })).status).toBe(200);
      if (world.engine === "v1") expect((await world.request(`${root}/engine/reload`, "POST")).status).toBe(200);
      const priorMessages = new Set((await world.messages()).filter(record).map(message => record(message.info) ? message.info.id : message.id));
      await turn(ctx, "Use the live-amber skill to report the CURRENT amber release code. Load its instructions afresh. Do not use shell or read files directly.", code);
      const tools = (await world.messages()).filter(record)
        .filter(message => !priorMessages.has(record(message.info) ? message.info.id : message.id))
        .flatMap(message => Array.isArray(message.parts) ? message.parts : Array.isArray(message.content) ? message.content : [])
        .filter(record).filter(part => part.type === "tool");
      expect(tools.some(part => (part.tool === "skill" || part.name === "skill") && record(part.state) && part.state.status === "completed" && JSON.stringify(part.state).includes(code))).toBe(true);
      if (route) expect(await world.route()).toBe(route);
      route = await world.route();
      if (world.engine === "v2") expect((await world.request("/experimental/engine-v2-preview/status")).body).toMatchObject({ pid: record(runtime) ? runtime.pid : undefined });
      expect(await world.documentIdentity()).toBe(documentIdentity);
      await user.screenshot();
    });
  }
  if (world.engine === "v2") expect(await world.reloadRequests()).toEqual([]);
});

test(`LIVE-MODELS ${resolveEvalEngine()}: browse, change and hot-update real Gateway models`, async ctx => {
  const { world, user, probe, step, evidence } = ctx;
  const gateway = await ready(ctx);
  if (!gateway?.secondModelId) throw new Error("This real Gateway test requires OPENWORK_LIVE_INSTALLED_GATEWAY=1 and two assigned models; absence is not a pass");
  const documentIdentity = await world.documentIdentity();
  const runtime = (await world.request("/experimental/engine-v2-preview/status")).body;
  const first = `MODEL-ONE-${randomUUID().slice(0, 8)}`;
  await turn(ctx, `Reply exactly ${first}. Do not use tools.`, first);
  const route = await world.route();
  const secondModelId = gateway.secondModelId;
  for (const includeSecond of [false, true]) await step(includeSecond ? "A newly enabled model appears without restarting v2" : "A removed model disappears from the picker", async () => {
    await world.stageGateway(includeSecond);
    if (world.engine === "v1") {
      const workspace = /\/workspace\/([^/]+)/.exec(route)?.[1];
      expect((await world.request(`/workspace/${workspace}/engine/reload`, "POST")).status).toBe(200);
      await user.reload();
    }
    const models = await probe.eventually(() => world.readModels(), { within: 45_000, label: "visible picker reflects model update", until: rows => rows.some(row => row.id === secondModelId) === includeSecond });
    evidence.recordJsonArtifact("Visible live Gateway model choices", models);
    await user.screenshot();
    await user.press("Escape");
    await probe.eventually(() => probe.dom('input[placeholder="Search providers and models..."]'), {
      within: 10_000, label: "model picker closes before opening it again", until: state => state.elements.length === 0,
    });
  });
  await step("Select the second model and send in the existing conversation", async () => {
    await world.selectModel(secondModelId);
    const second = `MODEL-TWO-${randomUUID().slice(0, 8)}`;
    await turn(ctx, `Reply exactly ${second}. Do not use tools.`, second);
    expect(await world.route()).toBe(route);
    const native = (await world.messages()).filter(record).map(message => record(message.info) ? message.info : message);
    expect(native.some(message => message.modelID === secondModelId || record(message.model) && message.model.id === secondModelId)).toBe(true);
  });
  if (world.engine === "v2") {
    expect(await world.documentIdentity()).toBe(documentIdentity);
    expect((await world.request("/experimental/engine-v2-preview/status")).body).toMatchObject({ pid: record(runtime) ? runtime.pid : undefined });
    expect(await world.reloadRequests()).toEqual([]);
  }
});

test(`LIVE-MCP ${resolveEvalEngine()}: add a local process in Library and let the real model discover and execute it`, async ctx => {
  const { world, user, probe, step, evidence } = ctx;
  await ready(ctx);
  const initial = `READY-${randomUUID().slice(0, 8)}`;
  await turn(ctx, `Reply exactly ${initial}. Do not use tools.`, initial);
  const route = await world.route();
  const documentIdentity = await world.documentIdentity();
  const runtime = (await world.request("/experimental/engine-v2-preview/status")).body;
  await step("Add the local stdio MCP through the Library form", async () => {
    const sessionId = /\/session\/([^/?#]+)/.exec(route)?.[1];
    if (!sessionId) throw new Error("Missing current conversation ID");
    await user.click({ role: "button", label: "Library" });
    await user.click({ role: "button", label: "MCPs" });
    await user.click({ role: "button", label: /^Advanced\b/ });
    await user.click({ role: "button", label: "Add workspace MCP" });
    await user.type({ placeholder: "github-copilot" }, "live-report");
    await user.click({ role: "button", label: "Local process (command)" });
    await user.type({ placeholder: "npx -y @modelcontextprotocol/server-sequential-thinking" }, world.mcpCommand);
    await user.click({ role: "button", label: "Add App" });
    await probe.eventually(() => probe.dom('[role="dialog"]'), { within: 30_000, label: "local MCP form saves", until: value => !value.elements.length });
    if (world.engine === "v1") {
      const workspace = /\/workspace\/([^/]+)/.exec(route)?.[1];
      const status = await probe.eventually(() => world.request(`/workspace/${workspace}/opencode/mcp`), {
        within: 45_000, label: "legacy reload finishes and the local process completes its MCP handshake",
        until: result => result.status === 200 && record(result.body) && record(result.body["live-report"]) && result.body["live-report"].status === "connected",
      });
      evidence.recordJsonArtifact("Legacy engine reports the new local MCP connected", status.body);
    }
    await user.screenshot();
    await openSavedConversation(ctx, sessionId);
  });
  for (let cycle = 0; cycle < 2; cycle++) await step(`Read fresh report ${cycle + 1} through the actual local process`, async () => {
    const code = await world.changeReport();
    const before = (await world.toolCalls()).length;
    await turn(ctx, "Discover the connected live-report MCP and call current_report to fetch its CURRENT amber report. Return its code exactly. Always fetch fresh data; never reuse earlier results. Do not use shell or read files.", code);
    const calls = (await world.toolCalls()).slice(before);
    expect(calls).toEqual(expect.arrayContaining([expect.objectContaining({ proof: code, tool: "current_report" })]));
    evidence.recordJsonArtifact("Local process witnessed the real model's tool call", calls);
  });
  expect(await world.route()).toBe(route);
  expect(await world.documentIdentity()).toBe(documentIdentity);
  if (world.engine === "v2") expect((await world.request("/experimental/engine-v2-preview/status")).body).toMatchObject({ pid: record(runtime) ? runtime.pid : undefined });
  if (world.engine === "v2") expect(await world.reloadRequests()).toEqual([]);
});
