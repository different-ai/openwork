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
  // One agent turn that runs `code` in Code Mode. The native list has no
  // guaranteed order, so the turn's execution is the one it added.
  async function runScript(request: string, reply: string, code: string) {
    const seen = new Set(executions((await world.request(native())).body).map(state => JSON.stringify(state)));
    const prompt = `${request} ${randomUUID()}`;
    const answer = `${reply} ${randomUUID()}`;
    await world.prepareTurn(prompt, answer, [{ tool: "execute", arguments: { code } }]);
    await user.type("composer", prompt);
    await user.click("Run task");
    await user.see({ text: answer }, { timeoutMs: 90_000 });
    const all = executions((await world.request(native())).body);
    const added = all.filter(state => !seen.has(JSON.stringify(state)));
    expect(added).toHaveLength(1);
    return { state: added[0], all };
  }
  await step("after: the agent discovers the report and reads its fresh value", async () => {
    // The reported script shape: search, then map the returned paths.
    const { state } = await runScript("Find and read the current verification report.", "The report was read.",
      'const r = await tools.search({query:"discovery report", limit:20}); '
      + 'const same = await tools["search"]({query:"discovery report", limit:20}); '
      + 'return {paths:r.items.map(i=>i.path), same:same.items.length, literal:"tools.search({query: \'unchanged\'})", report:await tools["discovery-witness"].read_report({})};');
    const output = JSON.stringify(state?.content);
    expect(output).toContain(nonce);
    expect(output).toContain("read_report");
    expect(output).toContain("tools.search");
    expect(output).not.toContain("Unknown tool");
    expect(record(state?.metadata) ? state.metadata.error : undefined).not.toBe(true);
    evidence.recordAssertionEvidence("both discovery spellings return the live catalog and report", `The native execution listed the report's path and returned ${nonce}; dotted and bracket discovery succeeded and the quoted tools.search text stayed unchanged.`, true);
    await user.screenshot();
  });
  await step("a discovery script with TypeScript types finds the report too", async () => {
    // The engine runs scripts as TypeScript, so agents often annotate them.
    const { state } = await runScript("Find the verification report again, typed this time.", "The typed report was read.",
      'type Hit = { path: string }; '
      + 'const r: { items: Hit[] } = await tools.search({query:"discovery report", limit:20}); '
      + 'return {paths:r.items.map((i: Hit) => i.path as string), report:(await tools["discovery-witness"].read_report({})) as string};');
    const output = JSON.stringify(state?.content);
    expect(output).toContain(nonce);
    expect(output).toContain("read_report");
    expect(output).not.toContain("Unknown tool");
    expect(record(state?.metadata) ? state.metadata.error : undefined).not.toBe(true);
    evidence.recordAssertionEvidence("a type-annotated discovery script returns the catalog and report", `The script used a type alias, annotations and an as-cast; it listed the report's path and returned ${nonce} without an Unknown tool error.`, true);
    await user.screenshot();
  });
  await step("a removed connection remains unavailable", async () => {
    expect((await world.request(`/workspace/${workspaceId}/mcp/discovery-witness`, "DELETE")).status).toBe(200);
    const { state, all } = await runScript("Check the report again after its connection was removed.", "The report is unavailable.",
      'return await tools["discovery-witness"].read_report({});');
    expect(all).toHaveLength(3);
    expect(JSON.stringify(state?.content)).toContain("Unknown tool 'discovery-witness.read_report'");
    expect(record(state?.metadata) ? state.metadata.error : undefined).toBe(true);
    evidence.recordAssertionEvidence("compatibility does not revive a removed tool", "The removed report call returned the native Unknown tool error; only the discovery spelling is normalized.", true);
    await user.screenshot();
  });
});
