import { expect } from "vitest";
import { setViewport, typeText } from "@openwork/cdp";
import { readAvailableModels, selectModel } from "@openwork/behaviors";
import { observeTranscript, spec } from "@openwork/testkit";
import {
  cloudHealthExpression,
  isRecord,
  mcpCallBody,
  preseededConnect,
  records,
  rpcResult,
  toolJson,
} from "../worlds/library.ts";

const test = spec.world(preseededConnect, { timeout: 600_000 });

test("bundled engine connects to preseeded organization skills and connections", async ({ world, user, agent, seed, probe, step, evidence }) => {
  await user.click("Library");
  await user.see({ text: "Library" });
  const signedOut = await probe.connectState(world.app);
  expect(signedOut).toMatchObject({ status: "missing", connectEnabled: false });
  expect(signedOut).not.toMatchObject({ status: "available" });
  await user.screenshot();

  const handoff = await seed.api(world.member, "/v1/auth/desktop-handoff", {
    method: "POST",
    body: JSON.stringify({ desktopScheme: "openwork" }),
  });
  if (!handoff.response.ok || !isRecord(handoff.body) || typeof handoff.body.grant !== "string") throw new Error("Could not prepare the member sign-in link.");
  const signInLink = new URL("openwork://den-auth");
  signInLink.searchParams.set("grant", handoff.body.grant);
  signInLink.searchParams.set("denBaseUrl", world.den.ref.webUrl);
  await user.click({ role: "button", label: "Back to app" });
  await user.click({ testId: "account-status-menu" });
  await user.click({ role: "button", label: "Paste sign-in code" });
  await user.click({ role: "textbox", label: "Sign-in link or one-time code" });
  // The sign-in field is unmasked; avoid recording its one-time grant in the user trace.
  await typeText(world.app, signInLink.toString());
  await user.click({ role: "button", label: "Finish sign-in" });
  await step("the invited member discovers only their shared capabilities", async () => {
    await user.see({ text: "Your team workspace" }, { timeoutMs: 90_000 });
    await user.see({ text: world.skillName });
    await user.see({ text: world.connectionName });
    await user.see({ text: "Connect your account" });
    await user.notSee({ text: world.privateSkillName });
    await user.notSee({ text: "Open OpenWork Cloud" });
    const welcome = await probe.text();
    expect(welcome).toContain("Skills");
    expect(welcome).toContain("Sign in with your own account in Library.");
    expect(welcome).not.toContain("Your account is connected");
    evidence.recordAssertionEvidence("Invited member sees assigned skills and personal connection setup without unassigned admin content", welcome, true);
    await user.screenshot();
    await user.looks(["The team workspace welcome has a compact heading, readable skill and tool rows, and a clear Continue to workspace action on a plain background"]);
    const viewport = await probe.eval("({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio })");
    if (!isRecord(viewport) || typeof viewport.width !== "number" || typeof viewport.height !== "number" || typeof viewport.deviceScaleFactor !== "number") throw new Error("Could not read viewport dimensions.");
    await setViewport(world.app, { width: 390, height: 844, deviceScaleFactor: 1 });
    await user.see({ text: "Your team workspace" });
    await user.looks(["The narrow team workspace welcome keeps skill and tool labels readable, wraps long names without horizontal overflow, and uses a plain background"]);
    await setViewport(world.app, { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.deviceScaleFactor });
    await user.click({ role: "button", label: "Continue to workspace" });
    await user.see("composer", { editable: true });
    await user.notSee({ text: "Your team workspace" });
    await user.reload();
    await user.see("composer", { editable: true });
    await user.notSee({ text: "Your team workspace" });
    evidence.recordAssertionEvidence("Completing team welcome stays completed after a reload", await probe.hash(), true);
  });
  const signedIn = await probe.eventually(
    () => probe.connectState(world.app),
    {
      within: 90_000,
      label: "signed-in available Connect state",
      until: (value) => isRecord(value) && value.status === "available" && value.connectEnabled === true,
    },
  );
  expect(signedIn).toMatchObject({ status: "available", connectEnabled: true });

  const health = await probe.eventually(
    // TODO(primitive): probe.cloudMcpHealth
    () => probe.eval(cloudHealthExpression, { args: [world.workspaceId] }),
    {
      within: 180_000,
      label: "openwork-cloud engine and agent-tool readiness",
      until: (value) => {
        if (!isRecord(value) || !isRecord(value.engine) || !isRecord(value.tools)) return false;
        return value.phase === "ready"
          && value.usable === true
          && value.engine.status === "connected"
          && Array.isArray(value.tools.present)
          && value.tools.present.includes("openwork-cloud_search_capabilities")
          && value.tools.present.includes("openwork-cloud_execute_capability")
          && isRecord(value.tools.direct)
          && Array.isArray(value.tools.direct.present)
          && value.tools.direct.present.includes("search_capabilities")
          && value.tools.direct.present.includes("execute_capability");
      },
    },
  );
  expect(health).toMatchObject({ phase: "ready", usable: true, engine: { status: "connected" } });
  if (!isRecord(health) || !isRecord(health.engine) || !isRecord(health.tools)) throw new Error("Connect health was malformed.");
  expect(health.engine.status).not.toBe("needs_auth");
  expect(health.engine.status).not.toBe("failed");
  expect(health.engine.status).not.toBe("needs_client_registration");
  expect(health.tools.present).toEqual(expect.arrayContaining([
    "openwork-cloud_search_capabilities",
    "openwork-cloud_execute_capability",
  ]));

  await step("the preseeded skill is discovered and executed", async () => {
    const search = await seed.api(world.mcpSession, "/mcp/agent", {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: mcpCallBody(1, "search_capabilities", { query: world.skillName, limit: 20, type: "skills" }),
    });
    const payload = toolJson(search);
    const matches = isRecord(payload) ? records(payload.matches) : [];
    const match = matches.find((entry) => entry.kind === "skill" && typeof entry.name === "string" && entry.name.startsWith(`plugin:${world.pluginId}:`));
    if (!match || typeof match.name !== "string") throw new Error("The exact preseeded skill was not discovered.");
    const execution = await seed.api(world.mcpSession, "/mcp/agent", {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: mcpCallBody(2, "execute_capability", { name: match.name }),
    });
    const executed = toolJson(execution);
    expect(rpcResult(execution).isError).not.toBe(true);
    expect(executed).toMatchObject({ kind: "skill", content: world.rawSourceText });
  });

  const nonsense = await seed.api(world.mcpSession, "/mcp/agent", {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: mcpCallBody(3, "search_capabilities", { query: world.nonsenseName, limit: 20, type: "skills" }),
  });
  const nonsensePayload = toolJson(nonsense);
  const nonsenseMatches = isRecord(nonsensePayload) ? records(nonsensePayload.matches) : [];
  expect(nonsenseMatches.filter((entry) => entry.kind === "skill" && JSON.stringify(entry).includes(world.nonsenseName))).toEqual([]);

  const connectionSearch = await seed.api(world.mcpSession, "/mcp/agent", {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: mcpCallBody(4, "search_capabilities", { query: world.connectionName, limit: 20, type: "mcp" }),
  });
  const connectionPayload = toolJson(connectionSearch);
  const connectionMatches = isRecord(connectionPayload) ? records(connectionPayload.matches) : [];
  const connectionMatch = connectionMatches.find((match) => {
    const status = isRecord(match.connectionStatus) ? match.connectionStatus : null;
    return status?.connectionName === world.connectionName || JSON.stringify(match).includes(world.connectionName);
  });
  if (!connectionMatch) throw new Error(`Connect did not discover ${world.connectionName}.`);
  const connectionStatus = isRecord(connectionMatch.connectionStatus) ? connectionMatch.connectionStatus : null;
  expect(connectionStatus).toMatchObject({
    state: "needs_connection", actor: "member", credentialMode: "per_member",
    connectionId: world.connection.id, connectionName: world.connectionName,
    action: { type: "connect", surface: "openwork_your_connections" },
  });
  evidence.recordAssertionEvidence("An unconnected member-owned connection requires member sign-in",
    JSON.stringify(connectionStatus), true);

  await user.click("Library");
  await user.see({ text: world.connectionName }, { timeoutMs: 60_000 });
  await user.screenshot();

  await step("the signed-in desktop agent discovers and reads the skill", async () => {
    expect(world.prompt).not.toContain(world.pluginId);
    expect(world.prompt).not.toContain(world.proofPhrase);
    await agent.createSession();
    await probe.eventually(() => readAvailableModels(world.app), {
      within: 120_000, label: "the published model reaches the signed-in desktop",
      until: models => models.some(model => model.name === world.modelId && model.selectable),
    });
    await selectModel(world.app, world.modelId, { provider: world.providerName });
    await using transcript = await observeTranscript(probe, [{ role: "assistant", text: world.proofPhrase }]);
    await agent.send(world.prompt);
    await user.see({ text: new RegExp(world.proofPhrase) }, { timeoutMs: 120_000 });
    await user.see("Run task", { timeoutMs: 60_000 });
    expect(await transcript.finish()).toMatchObject({ seen: [true], stopped: false });
    const calls = await world.den.mocks.connector.agentRequests({ promptMarker: world.prompt });
    const tools = calls.filter(call => call.kind === "tool");
    expect(tools).toHaveLength(2);
    expect(tools[0]?.toolName).toMatch(/search_capabilities$/);
    expect(tools[1]?.toolName).toMatch(/execute_capability$/);
    expect(tools[1]?.arguments.name).toMatch(new RegExp(`^plugin:${world.pluginId}:`));
    expect(calls.some(call => call.kind === "final" && call.completedTools === 2)).toBe(true);
    evidence.recordAssertionEvidence("The desktop agent uses the assigned organization skill",
      "The model was offered search and execute, resolved the capability from its search result, and displayed the unique phrase returned by skill execution.", true);
    await user.screenshot();
  });
});
