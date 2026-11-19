import { afterEach, describe, expect, test } from "bun:test";
import {
  mentionedSkillIds,
  nativeSkills,
  registerCloudSkillDiscovery,
  sha256Digest,
  type CloudSkillContext,
} from "../src/opencode-plugins/openwork-cloud-skills-v2.js";

const longDescription = `Sync the CRM with the latest pipeline updates. ${"Triggers when the user mentions: update the CRM, sync the CRM, refresh the pipeline. ".repeat(4)}`;
const crmBody = "---\nname: crm-pipeline-sync-7y86nr3j\n---\n\nRead Gmail, then update Notion.";
const catalog = {
  skills: [
    { name: "crm-pipeline-sync-7y86nr3j", title: "crm-pipeline-sync", description: longDescription, url: "skill://crm-pipeline-sync-7y86nr3j/SKILL.md",
      capability: "plugin:plg_1:cob_1", digest: sha256Digest(crmBody) },
    { name: "salesforce-notes-ab12cd34", title: "Salesforce notes", description: "Log call notes.", url: "skill://salesforce-notes-ab12cd34/SKILL.md",
      capability: "plugin:plg_2:cob_2", setup: { status: "needs_connection", message: "Connect Salesforce from Your Connections." } },
    { name: "release", title: "Release", description: "Cut a release.", url: "skill://release/SKILL.md",
      capability: "skill:release", digest: sha256Digest("tampered") },
  ],
};

describe("native mode", () => {
  test("lists full descriptions and loads verified bodies, setup notes, or the discovery note", () => {
    const skills = nativeSkills(catalog, new Map([[sha256Digest(crmBody), crmBody]]));
    const byId = new Map(skills.map(skill => [skill.id, skill]));
    const crm = byId.get("openwork-cloud-crm-pipeline-sync-7y86nr3j");
    expect(crm?.description).toBe(longDescription.replace(/\s+/g, " ").trim());
    expect(crm?.content).toBe(crmBody);
    expect(byId.get("openwork-cloud-salesforce-notes-ab12cd34")?.content).toContain("Connect Salesforce from Your Connections.");
    expect(byId.get("openwork-cloud-release")?.content).toContain("discovery metadata");
  });

  test("a message that names a multi-word skill loads it; everyday single words do not", () => {
    const skills = nativeSkills(catalog, new Map());
    expect(mentionedSkillIds("please run crm-pipeline-sync for this week", skills)).toEqual(["openwork-cloud-crm-pipeline-sync-7y86nr3j"]);
    expect(mentionedSkillIds("Add these Salesforce notes to the account", skills)).toEqual(["openwork-cloud-salesforce-notes-ab12cd34"]);
    expect(mentionedSkillIds("we should release on friday", skills)).toEqual([]);
    expect(mentionedSkillIds("/release v1.2", skills)).toEqual(["openwork-cloud-release"]);
    expect(mentionedSkillIds("the crm-pipeline-syncing job", skills)).toEqual([]);
  });
});

describe("registerCloudSkillDiscovery", () => {
  let stop: (() => Promise<void>) | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  afterEach(async () => { await stop?.(); server?.stop(true); });

  type Read = { urls: string[]; use?: boolean };
  type Prompt = { prompt: { text: string; skills?: Array<{ id: string }> } };

  /** A plugin host whose refresh timer the test drives, and a bridge that serves `served` and records body reads. */
  async function start(served: () => typeof catalog, body: (url: string) => string) {
    const reads: Read[] = [];
    server = Bun.serve({ port: 0, async fetch(request) {
      const call: { name: string; input: Read } = await request.json();
      if (call.name === "openwork_skills") return Response.json(served());
      reads.push(call.input);
      return Response.json({ ok: true, contents: Object.fromEntries(call.input.urls.map(url => [url, body(url)])) });
    } });
    const registry = new Map<string, string>();
    let promptHook: ((event: Prompt) => void | Promise<void>) | undefined;
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
      for (const transform of transforms) transform({ get: id => registry.get(id), add: skill => registry.set(skill.id, skill.content) });
    };
    try {
      stop = await registerCloudSkillDiscovery({
        options: { url: `http://127.0.0.1:${server.port}/read`, token: "t" },
        skill: {
          async transform(callback) {
            transforms.push(callback);
            apply();
            return { dispose: async () => { transforms = transforms.filter(entry => entry !== callback); } };
          },
          async reload() { apply(); },
        },
        session: { async hook(_name, callback) { promptHook = callback; return { dispose: async () => {} }; } },
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
    return {
      reads, registry, refresh,
      prompt: async (event: Prompt) => { await promptHook?.(event); return event; },
      callTool: async (tool: string, input: unknown) => { await toolHook?.({ tool, input }); },
    };
  }

  test("the model calling the native skill tool gets the verified body in that one call", async () => {
    const host = await start(() => catalog, url => url.startsWith("skill://crm") ? crmBody : "tampered body");
    expect(host.registry.get("openwork-cloud-crm-pipeline-sync-7y86nr3j")).toContain("discovery metadata");

    // Other tools and local skills never cost a read.
    await host.callTool("read", { id: "openwork-cloud-crm-pipeline-sync-7y86nr3j" });
    await host.callTool("skill", { id: "local-skill" });
    expect(host.reads).toEqual([]);

    await host.callTool("skill", { id: "openwork-cloud-crm-pipeline-sync-7y86nr3j" });
    // Read and published before the skill tool runs, counted as a use.
    expect(host.reads).toEqual([{ urls: ["skill://crm-pipeline-sync-7y86nr3j/SKILL.md"], use: true }]);
    expect(host.registry.get("openwork-cloud-crm-pipeline-sync-7y86nr3j")).toBe(crmBody);

    // A body that fails its digest keeps the discovery note.
    await host.callTool("skill", { id: "openwork-cloud-release" });
    expect(host.registry.get("openwork-cloud-release")).toContain("discovery metadata");
  });

  test("registers metadata only and loads a named skill's body when a message uses it", async () => {
    const host = await start(() => catalog, url => url.startsWith("skill://crm") ? crmBody : "tampered body");

    expect(host.registry.get("openwork-cloud-crm-pipeline-sync-7y86nr3j")).toContain("discovery metadata");
    expect(host.registry.get("openwork-cloud-salesforce-notes-ab12cd34")).toContain("Connect Salesforce from Your Connections.");
    // Discovery reads no bodies at all.
    expect(host.reads).toEqual([]);

    const event = await host.prompt({ prompt: { text: "run crm-pipeline-sync now", skills: [] } });
    expect(event.prompt.skills).toEqual([{ id: "openwork-cloud-crm-pipeline-sync-7y86nr3j" }]);
    // One read, for that skill only, counted as a use; the registry has its verified body before the model runs.
    expect(host.reads).toEqual([{ urls: ["skill://crm-pipeline-sync-7y86nr3j/SKILL.md"], use: true }]);
    expect(host.registry.get("openwork-cloud-crm-pipeline-sync-7y86nr3j")).toBe(crmBody);

    // A body that fails its digest is not used; the skill keeps the discovery note.
    await host.prompt({ prompt: { text: "/release v1.2", skills: [] } });
    expect(host.registry.get("openwork-cloud-release")).toContain("discovery metadata");
  });

  test("a 400-skill catalog: idle refreshes read no bodies; a changed warm skill re-reads only its own", async () => {
    let version = 1;
    const body = (url: string) => `---\nname: ${url}\n---\n\nVersion ${url.includes("skill-1/") ? version : 1}.`;
    const served = () => ({ skills: Array.from({ length: 400 }, (_, index) => {
      const url = `skill://skill-${index}/SKILL.md`;
      return { name: `skill-${index}`, description: "Short.", url, capability: `skill:skill-${index}`, digest: sha256Digest(body(url)) };
    }) });
    const host = await start(served, body);
    await host.refresh();
    await host.refresh();
    expect(host.reads).toEqual([]);

    await host.prompt({ prompt: { text: "", skills: [{ id: "openwork-cloud-skill-1" }, { id: "openwork-cloud-skill-10" }] } });
    // Two bodies, one request.
    expect(host.reads).toEqual([{ urls: ["skill://skill-1/SKILL.md", "skill://skill-10/SKILL.md"], use: true }]);
    await host.refresh();
    expect(host.reads.length).toBe(1);

    version = 2;
    await host.refresh();
    expect(host.reads.slice(1)).toEqual([{ urls: ["skill://skill-1/SKILL.md"] }]);
    expect(host.registry.get("openwork-cloud-skill-1")).toContain("Version 2.");
  });
});
