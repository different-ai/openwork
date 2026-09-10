import { browserScript } from "@openwork/testkit";
import { expect } from "vitest";
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

test("bundled engine recovers from a startup outage and uses preseeded organization skills and connections", async ({ world, user, agent, seed, probe, step, evidence }) => {
  await user.see("composer", { editable: true });
  const taskRoute = await probe.hash();
  expect(taskRoute).toBe(`#/workspace/${world.workspaceId}/session`);
  const signedOut = await probe.connectState(world.app);
  expect(signedOut).toMatchObject({ status: "missing", connectEnabled: false });
  expect(signedOut).not.toMatchObject({ status: "available" });
  await user.screenshot();

  const tokenRequests = async () => (await world.proxy.requestLog())
    .filter((request) => request.method === "POST" && request.path === world.tokenPath);
  const firstFailure = await step("desktop startup maintenance encounters a sustained token-mint outage", async () => {
    await seed.signIn(world.app, world.member, "admin");
    const first = await probe.eventually(async () => (await tokenRequests())
      .find((request) => request.faulted && request.status === 503), {
      within: 60_000,
      label: "the desktop reaches the startup token-mint fault",
    });
    if (!first) throw new Error("Desktop startup did not encounter the token-mint fault.");

    // Measure from an observed desktop failure, not world boot: slow startup
    // must not consume the outage before maintenance ever reaches it.
    const observedAt = Date.now();
    const outage = await probe.eventually(async () => ({
      requests: await tokenRequests(),
      heldForMs: Date.now() - observedAt,
    }), {
      within: 60_000,
      label: "startup remains unavailable beyond the initial 1s/3s retry burst",
      until: (value) => value.heldForMs >= 10_000 && value.requests.length >= 3,
    });
    expect(outage.requests.every((request) => request.faulted && request.status === 503)).toBe(true);
    expect(await probe.desktopApi(`/workspace/${world.workspaceId}/mcp/openwork-cloud/health`))
      .toMatchObject({ status: 200, body: { usable: false } });
    expect(await probe.hash()).toBe(taskRoute);
    return first;
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

  await step("restore connectivity without navigation, reload, focus, online, or manual retry", async () => {
    await world.proxy.faults.clear();
    await world.proxy.faults.status("/api/runtime-config", 200, { times: 1000, body: world.runtimeConfig });
  });

  // Observe UI convergence before asking the server to probe health: the test
  // must not supply the recovery trigger it is asserting happens automatically.
  await probe.eventually(() => probe.dom('[data-testid="account-status-menu"][data-connect-state="ready"]'), {
    within: 120_000,
    label: "the task screen reports Connect ready after background recovery",
    until: (value) => value.elements.length === 1,
  });

  const health = await probe.eventually(
    // TODO(primitive): probe.cloudMcpHealth
    () => probe.eval(browserScript(cloudHealthExpression, [world.workspaceId])),
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
  const recoveredMint = (await tokenRequests()).find((request) => !request.faulted && request.status === 200);
  if (!recoveredMint) throw new Error("Connect became ready without a successful desktop token mint through the restored connection.");
  // Exclude the five-minute maintenance interval as the recovery mechanism.
  expect(recoveredMint.at - firstFailure.at).toBeLessThan(120_000);
  expect(await probe.hash()).toBe(taskRoute);
  await user.see("composer", { editable: true });
  evidence.recordAssertionEvidence("Connect recovers from a startup outage without a UI recovery action",
    "The desktop encountered at least three HTTP 503 token-mint failures over a fault held for at least ten seconds after an observed failure. A later background mint succeeded within two minutes of the first failure; the unchanged task route reported Ready with both engine and direct Cloud tools present before any navigation or agent send.", true);

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
