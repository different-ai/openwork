import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import {
  cloudHealthExpression,
  isRecord,
  mcpCallBody,
  preseededConnect,
  records,
  rpcResult,
  toolJson,
} from "../worlds/library.ts";

const test = spec.world(preseededConnect, { timeout: 360_000 });

test("bundled engine connects to preseeded organization skills and connections", async ({ world, user, seed, probe, step }) => {
  await user.click("Library");
  await user.see({ text: "Library" });
  const signedOut = await probe.connectState(world.app);
  expect(signedOut).toMatchObject({ status: "missing", connectEnabled: false });
  expect(signedOut).not.toMatchObject({ status: "available" });
  await user.looks(["The OpenWork desktop is visible", "No crash or error dialog is visible"]);

  await seed.signIn(world.app, world.member, "admin");
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
  const readiness = connectionStatus?.state === "needs_connection" && connectionStatus.actor === "member"
    ? "needs_signin"
    : connectionStatus?.actor === "organization_admin" ? "needs_admin_setup" : "ready";
  expect(["ready", "needs_signin", "needs_admin_setup"]).toContain(readiness);

  await user.click("Library");
  await user.see({ text: world.connectionName }, { timeoutMs: 60_000 });
  await user.looks([
    `A Library view lists an organization connection card named '${world.connectionName}'`,
    "No crash or error dialog is visible",
  ]);
});
