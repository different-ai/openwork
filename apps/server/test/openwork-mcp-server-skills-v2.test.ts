import { afterEach, describe, expect, test } from "bun:test";
import { nativeMcpServerSkills, registerMcpServerSkills } from "../src/opencode-plugins/openwork-mcp-server-skills-v2.js";

const triage = { id: "mcp-server-tracker-triage", server: "tracker", name: "triage", description: "Triage new issues.", digest: "sha256:one" };
const notes = { id: "mcp-server-tracker-release-notes", server: "tracker", name: "release-notes", description: "Write release notes." };

describe("skills from MCP servers in the engine", () => {
  let stop: (() => Promise<void>) | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  afterEach(async () => { await stop?.(); server?.stop(true); });

  /** A plugin host whose refresh timer the test drives, and a bridge that serves `served` and records body reads. */
  async function start(served: () => { skills: Array<typeof triage | typeof notes> }, body: (id: string) => string | null) {
    const reads: string[] = [];
    server = Bun.serve({ port: 0, async fetch(request) {
      const call: { name: string; input: { id: string } } = await request.json();
      if (call.name === "openwork_mcp_skills") return Response.json({ ok: true, ...served() });
      reads.push(call.input.id);
      const content = body(call.input.id);
      return Response.json(content === null ? { ok: false, reason: "unavailable" } : { ok: true, content });
    } });
    const registry = new Map<string, string>();
    let toolHook: ((event: { tool: string; input: unknown }) => void | Promise<void>) | undefined;
    let tick: (() => void) | undefined;
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = ((callback: () => void) => {
      tick = callback;
      return { unref() {} };
    }) as unknown as typeof setInterval;
    let transforms: Array<(editor: { get(id: string): unknown; add(skill: { id: string; content: string }): void }) => void> = [];
    const apply = () => {
      registry.clear();
      for (const transform of transforms) transform({ get: id => registry.get(id), add: skill => { registry.set(skill.id, skill.content); } });
    };
    try {
      stop = await registerMcpServerSkills({
        options: { url: `http://127.0.0.1:${server.port}/read`, token: "t" },
        skill: {
          async transform(callback) {
            transforms.push(callback);
            apply();
            return { dispose: async () => { transforms = transforms.filter(entry => entry !== callback); apply(); } };
          },
          async reload() { apply(); },
        },
        session: { async hook() { return { dispose: async () => {} }; } },
        tool: { async hook(_name, callback) { toolHook = callback; return { dispose: async () => {} }; } },
      });
    } finally {
      globalThis.setInterval = realSetInterval;
    }
    for (let attempt = 0; attempt < 100 && registry.size === 0; attempt++) await Bun.sleep(10);
    const refresh = async () => {
      const before = JSON.stringify([...registry]);
      tick?.();
      for (let attempt = 0; attempt < 20 && JSON.stringify([...registry]) === before; attempt++) await Bun.sleep(10);
    };
    return { reads, registry, refresh, callTool: async (id: string) => { await toolHook?.({ tool: "skill", input: { id } }); } };
  }

  test("lists each skill with its server, and names the server when a body is not loaded", () => {
    const [first, second] = nativeMcpServerSkills([triage, notes], new Map([[triage.id, "Label, then assign."]]));
    expect(first?.id).toBe(notes.id);
    expect(first?.description).toBe("Write release notes. (from the MCP server tracker)");
    expect(first?.content).toContain("could not be loaded");
    expect(second?.content).toEndWith("\n\nLabel, then assign.");
    expect(second?.content).toStartWith('This skill comes from the MCP server "tracker"');
  });

  test("loads a skill's instructions from its server when the agent uses it, and once per listed version", async () => {
    let listed = [triage, notes];
    let version = "one";
    const host = await start(() => ({ skills: listed.map(skill => skill.id === triage.id ? { ...triage, digest: `sha256:${version}` } : skill) }), id => id === triage.id ? `Triage v${version}` : null);
    expect([...host.registry.keys()].sort()).toEqual([notes.id, triage.id]);
    expect(host.reads).toEqual([]);

    await host.callTool(triage.id);
    await host.callTool(triage.id);
    await host.callTool("openwork-cloud-release");
    expect(host.reads).toEqual([triage.id]);
    expect(host.registry.get(triage.id)).toEndWith("Triage vone");

    await host.callTool(notes.id);
    expect(host.registry.get(notes.id)).toContain("could not be loaded");

    version = "two";
    await host.refresh();
    expect(host.registry.get(triage.id)).toContain("could not be loaded");
    await host.callTool(triage.id);
    expect(host.registry.get(triage.id)).toEndWith("Triage vtwo");

    listed = [];
    await host.refresh();
    expect(host.registry.size).toBe(0);
  });
});
