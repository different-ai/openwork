import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { v2ToolDiscovery } from "../worlds/v2-tool-discovery.ts";

const test = spec.world(v2ToolDiscovery, {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
  needs: { placement: "local", env: ["OPENWORK_EVAL_ENGINE"] },
});

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function executions(value: unknown): Record<string, unknown>[] {
  return record(value) && Array.isArray(value.data) ? value.data.filter(record)
    .flatMap(message => Array.isArray(message.content) ? message.content.filter(record) : [])
    .filter(part => part.type === "tool" && part.name === "execute" && record(part.state)).map(part => record(part.state) ? part.state : {}) : [];
}

test("a v2 conversation discovers and calls a connected tool without the unknown-search error", async ({ world, user, probe, step, evidence }) => {
  expect(world.engine).toBe("v2");
  const nonce = world.nonce;
  let workspaceId = "";
  let sessionId = "";
  const native = () => `/workspace/${workspaceId}/opencode2/api/session/${sessionId}/message`;
  await step("before: the conversation is ready to find a connected report", async () => {
    await probe.eventually(() => probe.composer(), { within: 60_000, label: "model ready",
      until: state => state.selectedModelLabel.includes("Big Pickle") && !state.modelUnavailable });
    await user.type("composer", world.prompt);
    await user.click("Run task");
    await user.see({ text: world.reply });
    await user.see("Run task");
    const route = await world.route();
    workspaceId = /\/workspace\/([^/]+)\/session/.exec(route)?.[1] ?? "";
    sessionId = route.split("/").at(-1) ?? "";
    expect(workspaceId).not.toBe("");
    expect((await world.request(`/workspace/${workspaceId}/mcp`, "POST", { name: "discovery-witness",
      config: { type: "remote", url: world.mcpUrl, oauth: false } })).status).toBe(200);
    evidence.recordAssertionEvidence("the real v2 engine has a connected report", `Native engine ${world.engineVersion}; the workspace accepted the MCP connection.`, true);
    await user.screenshot();
  });
  await step("after: the agent discovers the report and reads its fresh value", async () => {
    const prompt = `Find and read the current verification report. ${randomUUID()}`;
    const answer = `The report was read. ${randomUUID()}`;
    const code = 'const catalog = await tools.search({query:"discovery report", namespace:"discovery-witness", limit:20}); '
      + 'const same = await tools["search"]({query:"discovery report", namespace:"discovery-witness", limit:20}); '
      + 'return {catalog, same, literal:"tools.search({query: \'unchanged\'})", report:await tools["discovery-witness"].read_report({})};';
    await world.prepareTurn(prompt, answer, [{ tool: "execute", arguments: { code } }]);
    await user.type("composer", prompt);
    await user.click("Run task");
    await user.see({ text: answer }, { timeoutMs: 90_000 });
    const state = executions((await world.request(native())).body).at(-1);
    const output = JSON.stringify(state?.content);
    expect(output).toContain(nonce);
    expect(output).toContain("discovery-witness");
    expect(output).toContain("tools.search");
    expect(output).not.toContain("Unknown tool");
    expect(record(state?.metadata) ? state.metadata.error : undefined).not.toBe(true);
    evidence.recordAssertionEvidence("both discovery spellings return the live catalog and report", `The native execution returned ${nonce}; dotted and bracket discovery succeeded and the quoted tools.search text stayed unchanged.`, true);
    await user.screenshot();
  });
  await step("a removed connection remains unavailable", async () => {
    expect((await world.request(`/workspace/${workspaceId}/mcp/discovery-witness`, "DELETE")).status).toBe(200);
    const prompt = `Check the report again after its connection was removed. ${randomUUID()}`;
    const answer = `The report is unavailable. ${randomUUID()}`;
    await world.prepareTurn(prompt, answer, [{ tool: "execute", arguments: { code: 'return await tools["discovery-witness"].read_report({});' } }]);
    await user.type("composer", prompt);
    await user.click("Run task");
    await user.see({ text: answer }, { timeoutMs: 90_000 });
    const states = executions((await world.request(native())).body);
    expect(states).toHaveLength(2);
    const state = states.find(state => record(state.metadata) && state.metadata.error === true);
    expect(JSON.stringify(state?.content)).toContain("Unknown tool 'discovery-witness.read_report'");
    expect(record(state?.metadata) ? state.metadata.error : undefined).toBe(true);
    evidence.recordAssertionEvidence("compatibility does not revive a removed tool", "The removed report call returned the native Unknown tool error; only the discovery spelling is normalized.", true);
    await user.screenshot();
  });
});
