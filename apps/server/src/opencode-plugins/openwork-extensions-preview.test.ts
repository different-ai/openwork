import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";

import { OpenWorkExtensionsPreview } from "./openwork-extensions-preview.js";
import * as OpenWorkExtensionsPreviewEntry from "./openwork-extensions-preview.js";
import {
  OPENWORK_CLOUD_SKILL_AUTHORING_INSTRUCTION,
  OPENWORK_EXTENSION_DISCOVERY_INSTRUCTION,
  OPENWORK_LOCAL_SKILL_AUTHORING_INSTRUCTION,
} from "./openwork-extensions-preview-steering.js";

const originalServerUrl = process.env.OPENWORK_SERVER_URL;
const originalServerToken = process.env.OPENWORK_SERVER_TOKEN;
const stops: Array<() => void> = [];

const searchResultSchema = z.object({
  ok: z.literal(true),
  scannedSessions: z.number(),
  results: z.array(z.object({
    workspaceId: z.string(),
    sessionId: z.string(),
    kind: z.string(),
    role: z.string().optional(),
    snippet: z.object({ match: z.string() }).passthrough(),
  }).passthrough()),
}).passthrough();

const readResultSchema = z.object({
  ok: z.literal(true),
  workspaceId: z.string(),
  sessionId: z.string(),
  title: z.string(),
  messages: z.array(z.object({
    role: z.string(),
    text: z.string(),
  }).passthrough()),
}).passthrough();

const createResultSchema = z.object({
  ok: z.boolean(),
  workspaceId: z.string(),
  created: z.array(z.object({
    sessionId: z.string(),
    title: z.string(),
    started: z.boolean(),
    route: z.string(),
  })),
  failures: z.array(z.object({
    title: z.string(),
    error: z.string(),
  })),
});

const automationProposalResultSchema = z.object({
  ok: z.literal(true),
  kind: z.literal("automation-proposal"),
  created: z.literal(false),
  limitation: z.string(),
  proposal: z.object({
    name: z.string(),
    instructions: z.string(),
    schedule: z.record(z.string(), z.unknown()),
    model: z.record(z.string(), z.unknown()).optional(),
    workspaceId: z.string().optional(),
  }),
});

const affordanceResultSchema = <T extends z.ZodTypeAny>(id: string, result: T) => z.object({
  ok: z.literal(true),
  id: z.literal(id),
  result,
  effects: z.object({
    data: z.enum(["none", "read", "write"]),
    ui: z.enum(["none", "focus", "navigate"]),
    external: z.boolean(),
  }),
});

afterEach(() => {
  while (stops.length) stops.pop()?.();
  if (originalServerUrl === undefined) delete process.env.OPENWORK_SERVER_URL;
  else process.env.OPENWORK_SERVER_URL = originalServerUrl;
  if (originalServerToken === undefined) delete process.env.OPENWORK_SERVER_TOKEN;
  else process.env.OPENWORK_SERVER_TOKEN = originalServerToken;
});

async function transformedSystem(plugin: Awaited<ReturnType<typeof OpenWorkExtensionsPreview>>): Promise<string> {
  const output: { system: string[] } = { system: [] };
  await plugin["experimental.chat.system.transform"]({}, output);
  return output.system.join("\n");
}

function startFakeOpenWorkServer(options: { failPromptText?: string; failSessionListWorkspaceId?: string } = {}) {
  const requests: Array<{ pathname: string; search: string; authorization: string | null; method: string; body?: unknown }> = [];
  let createdCount = 0;

  const workspaceOne = { id: "ws_1", name: "Main", path: "/tmp/main" };
  const workspaceTwo = { id: "ws_2", name: "Archive", displayName: "Archive", path: "/tmp/archive", workspaceType: "remote" };
  const sessionAlpha = { id: "ses_alpha", title: "Alpha planning", time: { created: 100, updated: 300 } };
  const sessionBeta = { id: "ses_beta", title: "Neon backlog", time: { created: 50, updated: 200 } };
  const sessionArchive = { id: "ses_archive", title: "Archive decisions", directory: "/tmp/archive", time: { created: 10, updated: 100 } };
  // Lives outside every workspace root: reads must refuse to expose it even
  // though the native engine route happily returns it (cross-workspace leak).
  const sessionForeign = { id: "ses_foreign", title: "Other tenant secrets", directory: "/tmp/elsewhere", time: { created: 20, updated: 120 } };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const record: { pathname: string; search: string; authorization: string | null; method: string; body?: unknown } = {
        pathname: url.pathname,
        search: url.search,
        authorization: request.headers.get("authorization"),
        method: request.method,
      };
      if (request.method === "POST") record.body = await request.json();
      requests.push(record);

      if (request.headers.get("authorization") !== "Bearer test-token") {
        return Response.json({ message: "Unauthorized" }, { status: 401 });
      }

      if (url.pathname === "/experimental/connect/state") {
        return Response.json({
          ok: true,
          schemaVersion: 1,
          connectEnabled: true,
          connectCatalogEnabled: true,
          cloudMcpPresent: true,
          cloudHealth: {
            usable: true,
            usableByCurrentModel: true,
            phase: "ready",
            workspace: { id: "ws_2", directory: "/tmp/archive" },
            desired: { present: true, revision: "rev_ready" },
            firstFailure: null,
          },
          workspace: { resolution: "resolved", id: "ws_2", directory: "/tmp/archive" },
          googleWorkspace: { legacyConfigured: false },
        });
      }

      if (url.pathname === "/experimental/connect/skills") {
        return Response.json({
          ok: true,
          schemaVersion: 1,
          skills: [{
            name: "customer-briefing",
            title: "Customer briefing",
            description: "Prepare a connected customer briefing.",
            capability: "skill:skl_customer_briefing",
          }],
          instruction: "<available_skills><skill><name>customer-briefing</name></skill></available_skills>",
        });
      }

      if (url.pathname === "/workspaces") {
        return Response.json({ items: [workspaceOne, workspaceTwo], workspaces: [workspaceOne, workspaceTwo] });
      }

      if (url.pathname === "/workspace/ws_1/opencode/session") {
        if (options.failSessionListWorkspaceId === "ws_1") {
          return Response.json({ message: "Remote worker unavailable" }, { status: 503 });
        }
        return Response.json([sessionAlpha, sessionBeta]);
      }
      if (url.pathname === "/workspace/ws_2/opencode/session") {
        if (request.method === "POST") {
          const body = z.object({ title: z.string() }).strict().parse(record.body);
          createdCount += 1;
          return Response.json({
            id: `ses_created_${createdCount}`,
            title: body.title,
            time: { created: 400, updated: 400 },
          }, { status: 201 });
        }
        if (options.failSessionListWorkspaceId === "ws_2") {
          return Response.json({ message: "Remote worker unavailable" }, { status: 503 });
        }
        return Response.json([sessionArchive]);
      }

      if (url.pathname === "/workspace/ws_1/opencode/session/ses_alpha") return Response.json(sessionAlpha);
      if (url.pathname === "/workspace/ws_1/opencode/session/ses_beta") return Response.json(sessionBeta);
      if (url.pathname === "/workspace/ws_2/opencode/session/ses_archive") return Response.json(sessionArchive);
      if (url.pathname === "/workspace/ws_1/opencode/session/ses_foreign") return Response.json(sessionForeign);
      if (url.pathname === "/workspace/ws_2/opencode/session/ses_foreign") return Response.json(sessionForeign);
      if (url.pathname === "/workspace/ws_1/opencode/session/ses_foreign/message" || url.pathname === "/workspace/ws_2/opencode/session/ses_foreign/message") {
        return Response.json([
          {
            info: { id: "msg_foreign", role: "assistant", time: { created: 121 } },
            parts: [{ type: "text", text: "Cross-tenant transcript that must never leak." }],
          },
        ]);
      }

      if (url.pathname === "/workspace/ws_1/opencode/session/ses_alpha/message") {
        return Response.json([
          {
            info: { id: "msg_assistant", role: "assistant", time: { created: 301 } },
            parts: [{ type: "text", text: "The launch checklist can wait." }],
          },
          {
            info: { id: "msg_user", role: "user", time: { created: 302 } },
            parts: [{ type: "text", text: "Please remember the raven launch checklist." }],
          },
        ]);
      }
      if (url.pathname === "/workspace/ws_1/opencode/session/ses_beta/message") {
        return Response.json([]);
      }
      if (url.pathname === "/workspace/ws_2/opencode/session/ses_archive/message") {
        return Response.json([
          {
            info: { id: "msg_old", role: "assistant", time: { created: 101 } },
            parts: [{ type: "text", text: "Ignored implementation note", ignored: true }],
          },
          {
            info: { id: "msg_latest", role: "assistant", time: { created: 102 } },
            parts: [{ type: "text", text: "We decided to ship the archive importer first." }],
          },
        ]);
      }

      if (/^\/workspace\/ws_2\/opencode\/session\/ses_created_\d+\/prompt_async$/.test(url.pathname)) {
        const body = z.object({
          parts: z.array(z.object({ type: z.literal("text"), text: z.string() }).strict()).length(1),
        }).strict().parse(record.body);
        if (body.parts[0]?.text === options.failPromptText) {
          return Response.json({ message: "Prompt failed" }, { status: 503 });
        }
        return new Response(null, { status: 204 });
      }

      return Response.json({ message: "Not found" }, { status: 404 });
    },
  });
  stops.push(() => server.stop(true));
  process.env.OPENWORK_SERVER_URL = `http://127.0.0.1:${server.port}`;
  process.env.OPENWORK_SERVER_TOKEN = "test-token";
  return { requests };
}

describe("OpenWorkExtensionsPreview MCP Apps result preservation", () => {
  test("keeps standard MCP UI result fields in completed tool metadata", async () => {
    const plugin = await OpenWorkExtensionsPreview();
    const output: Record<string, unknown> = {
      content: [{ type: "text", text: "Fallback" }],
      structuredContent: { value: 42 },
      _meta: { receiptId: "receipt_1" },
    };

    await plugin["tool.execute.after"]?.(
      { tool: "fixture_render", sessionID: "ses_1", callID: "call_1", args: {} },
      output,
    );

    expect(output.metadata).toEqual({
      openworkMcpApp: {
        content: [{ type: "text", text: "Fallback" }],
        structuredContent: { value: 42 },
        _meta: { receiptId: "receipt_1" },
      },
    });
  });

  test("preserves content-only MCP results so their tool definition can resolve a view", async () => {
    const plugin = await OpenWorkExtensionsPreview();
    const output: Record<string, unknown> = {
      content: [{ type: "text", text: "Fallback only" }],
    };

    await plugin["tool.execute.after"]?.(
      { tool: "fixture_render", sessionID: "ses_1", callID: "call_1", args: {} },
      output,
    );

    expect(output.metadata).toEqual({
      openworkMcpApp: {
        content: [{ type: "text", text: "Fallback only" }],
      },
    });
  });

  test("leaves ordinary tool results untouched", async () => {
    const plugin = await OpenWorkExtensionsPreview();
    const output: Record<string, unknown> = { title: "Read", output: "plain", metadata: { retained: true } };

    await plugin["tool.execute.after"]?.(
      { tool: "read", sessionID: "ses_1", callID: "call_1", args: {} },
      output,
    );

    expect(output).toEqual({ title: "Read", output: "plain", metadata: { retained: true } });
  });

  test("does not duplicate oversized MCP results into session metadata", async () => {
    const plugin = await OpenWorkExtensionsPreview();
    const output: Record<string, unknown> = {
      content: [{ type: "text", text: "x".repeat(1024 * 1024) }],
      metadata: { retained: true },
    };

    await plugin["tool.execute.after"]?.(
      { tool: "fixture_render", sessionID: "ses_1", callID: "call_1", args: {} },
      output,
    );

    expect(output.metadata).toEqual({ retained: true });
  });
});

describe("OpenWorkExtensionsPreview session tools", () => {
  test("plugin entry exposes only the factory export for the OpenCode loader", () => {
    expect(Object.keys(OpenWorkExtensionsPreviewEntry)).toEqual(["OpenWorkExtensionsPreview"]);
  });

  test("projects built-in, extension, and Connect providers into one agent context", async () => {
    startFakeOpenWorkServer();
    const plugin = await OpenWorkExtensionsPreview({
      client: {
        mcp: {
          status: async () => ({
            data: {
              notion: { status: "connected" },
              "openwork-cloud": { status: "connected" },
            },
          }),
        },
      },
    });

    const output = await plugin.tool.openwork_context.execute();
    const parsed = z.object({
      context: z.object({
        contributions: z.array(z.object({
          featureId: z.string(),
          affordances: z.array(z.object({
            id: z.string(),
            executor: z.object({ kind: z.string(), tool: z.string().optional() }),
          }).passthrough()),
          guidance: z.array(z.object({
            ref: z.string(),
          }).passthrough()),
        }).passthrough()),
      }).passthrough().nullable().optional(),
      contributions: z.array(z.object({
        featureId: z.string(),
        affordances: z.array(z.object({
          id: z.string(),
          executor: z.object({ kind: z.string(), tool: z.string().optional() }),
        }).passthrough()),
        guidance: z.array(z.object({
          ref: z.string(),
        }).passthrough()),
      }).passthrough()).optional(),
    }).passthrough().parse(JSON.parse(output));
    const contributions = parsed.context?.contributions ?? parsed.contributions ?? [];

    expect(contributions.map((contribution) => contribution.featureId)).toEqual([
      "sessions",
      "automations",
      "extensions",
      "mcp:notion",
      "connect",
    ]);
    expect(contributions.find((contribution) => contribution.featureId === "connect")?.guidance)
      .toContainEqual(expect.objectContaining({ ref: "skill:skl_customer_briefing" }));
    expect(
      contributions.flatMap((contribution) => contribution.affordances)
        .find((affordance) => affordance.id === "connect.capability.execute")?.executor,
    ).toEqual({
      kind: "tool",
      tool: "openwork-cloud_execute_capability",
    });
  });

  test("routes semantic session queries without navigating the UI", async () => {
    startFakeOpenWorkServer();
    const plugin = await OpenWorkExtensionsPreview();

    const output = await plugin.tool.openwork_query.execute({
      id: "session.read",
      args: { sessionId: "ses_archive", count: 2 },
    });
    const parsed = z.object({
      ok: z.literal(true),
      id: z.literal("session.read"),
      result: readResultSchema,
      effects: z.object({
        data: z.literal("read"),
        ui: z.literal("none"),
        external: z.literal(false),
      }),
    }).parse(JSON.parse(output));

    expect(parsed.result.sessionId).toBe("ses_archive");
    expect(parsed.result.messages.at(-1)?.text).toContain("archive importer");
  });

  test("refuses to expose a session that lives outside the requested workspace", async () => {
    startFakeOpenWorkServer();
    const plugin = await OpenWorkExtensionsPreview();

    const output = await plugin.tool.openwork_query.execute({
      id: "session.read",
      args: { sessionId: "ses_foreign", count: 2 },
    });

    expect(output).not.toContain("Other tenant secrets");
    expect(output).not.toContain("Cross-tenant transcript");
    expect(output).toContain("was not found");
  });

  test("searches past chat transcript text and prefers the user's matching message", async () => {
    const fake = startFakeOpenWorkServer();
    const plugin = await OpenWorkExtensionsPreview();

    const output = await plugin.tool.openwork_query.execute({
      id: "session.search",
      args: {
        query: "raven launch",
        limit: 5,
        scanLimit: 10,
      },
    });
    const parsed = affordanceResultSchema("session.search", searchResultSchema).parse(JSON.parse(output));

    expect(parsed.result.scannedSessions).toBe(3);
    expect(parsed.result.results[0]).toMatchObject({
      workspaceId: "ws_1",
      sessionId: "ses_alpha",
      kind: "message",
      role: "user",
    });
    expect(parsed.result.results[0]?.snippet.match.toLowerCase()).toBe("raven launch");
    expect(fake.requests.some((request) => request.pathname === "/workspace/ws_1/opencode/session" && request.search === "?roots=true&limit=10")).toBe(true);
    expect(fake.requests.some((request) => request.pathname === "/workspace/ws_1/opencode/session/ses_alpha/message" && request.search === "?limit=400")).toBe(true);
  });

  test("keeps search results when one workspace native mount is unavailable", async () => {
    const fake = startFakeOpenWorkServer({ failSessionListWorkspaceId: "ws_2" });
    const plugin = await OpenWorkExtensionsPreview();

    const output = await plugin.tool.openwork_query.execute({
      id: "session.search",
      args: { query: "raven launch", scanLimit: 10 },
    });
    const parsed = affordanceResultSchema("session.search", searchResultSchema.extend({
      workspaceErrors: z.array(z.object({ workspaceId: z.string(), error: z.string() }).passthrough()),
    })).parse(JSON.parse(output));

    expect(parsed.result.results[0]?.sessionId).toBe("ses_alpha");
    expect(parsed.result.workspaceErrors).toEqual([
      expect.objectContaining({ workspaceId: "ws_2", error: "Remote worker unavailable" }),
    ]);
    expect(fake.requests.some((request) => request.pathname === "/workspace/ws_2/opencode/session")).toBe(true);
  });

  test("merges factory directory into transform steering when hook input omits it", async () => {
    const fake = startFakeOpenWorkServer();
    const plugin = await OpenWorkExtensionsPreview({ directory: "/tmp/archive" });
    const output: { system: string[] } = { system: [] };

    await plugin["experimental.chat.system.transform"]({
      context: { sessionID: "ses_factory" },
      model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
    }, output);

    const connectStateRequest = fake.requests.find((request) => request.pathname === "/experimental/connect/state");
    const connectSkillsRequest = fake.requests.find((request) => request.pathname === "/experimental/connect/skills");
    expect(connectStateRequest?.search).toBe("?directory=%2Ftmp%2Farchive&provider=anthropic&model=claude-sonnet-4");
    expect(connectSkillsRequest?.search).toBe("");
    expect(output.system.join("\n")).toContain("verified ready for this exact workspace/model");
    expect(output.system.join("\n")).toContain(OPENWORK_CLOUD_SKILL_AUTHORING_INSTRUCTION);
    expect(output.system.join("\n")).not.toContain(OPENWORK_LOCAL_SKILL_AUTHORING_INSTRUCTION);
    expect(output.system.join("\n")).toContain("<name>customer-briefing</name>");
  });

  test("uses the factory engine client as transform steering source of truth", async () => {
    const requests: unknown[] = [];
    const mcp = {
      result: { data: { "openwork-cloud": { status: "connected" } } },
      async status(request: unknown) {
        requests.push(request);
        return this.result;
      },
    };
    const plugin = await OpenWorkExtensionsPreview({ client: { mcp }, directory: "/tmp/archive" });
    const output: { system: string[] } = { system: [] };

    await plugin["experimental.chat.system.transform"]({}, output);

    expect(requests).toEqual([{ query: { directory: "/tmp/archive" } }]);
    expect(output.system.join("\n")).toContain("verified ready for this exact workspace/model");
    expect(output.system.join("\n")).toContain(OPENWORK_CLOUD_SKILL_AUTHORING_INSTRUCTION);
    expect(output.system.join("\n")).not.toContain(OPENWORK_LOCAL_SKILL_AUTHORING_INSTRUCTION);
  });

  test("uses neutral transform steering when the engine reports failed Cloud status", async () => {
    const requests: unknown[] = [];
    const mcp = {
      result: { data: { "openwork-cloud": { status: "failed" } } },
      async status(request: unknown) {
        requests.push(request);
        return this.result;
      },
    };
    const plugin = await OpenWorkExtensionsPreview({ client: { mcp }, directory: "/tmp/archive" });
    const output: { system: string[] } = { system: [] };

    await plugin["experimental.chat.system.transform"]({}, output);

    expect(requests).toEqual([{ query: { directory: "/tmp/archive" } }]);
    expect(output.system[0]).toBe(OPENWORK_EXTENSION_DISCOVERY_INSTRUCTION);
    expect(output.system.join("\n")).toContain(OPENWORK_LOCAL_SKILL_AUTHORING_INSTRUCTION);
    expect(output.system.join("\n")).not.toContain(OPENWORK_CLOUD_SKILL_AUTHORING_INSTRUCTION);
    expect(output.system[0]).not.toContain("not ready");
    expect(output.system[0]).not.toContain("Repair and test");
    expect(output.system[0]).not.toContain("Do not use OpenWork documentation tools");
  });

  test("routes transcript reads through a remote workspace native mount", async () => {
    const fake = startFakeOpenWorkServer();
    const plugin = await OpenWorkExtensionsPreview();

    const output = await plugin.tool.openwork_query.execute({
      id: "session.read",
      args: { sessionId: "ses_archive", count: 2 },
    });
    const parsed = affordanceResultSchema("session.read", readResultSchema).parse(JSON.parse(output));

    expect(parsed.result).toMatchObject({
      workspaceId: "ws_2",
      sessionId: "ses_archive",
      title: "Archive decisions",
    });
    expect(parsed.result.messages).toEqual([
      {
        index: 1,
        id: "msg_latest",
        role: "assistant",
        text: "We decided to ship the archive importer first.",
      },
    ]);
    expect(fake.requests.some((request) => request.pathname === "/workspace/ws_2/opencode/session/ses_archive")).toBe(true);
    expect(fake.requests.some((request) => request.pathname === "/workspace/ws_2/opencode/session/ses_archive/message" && request.search === "?limit=2")).toBe(true);
    expect(fake.requests.some((request) => request.pathname.includes("/sessions"))).toBe(false);
  });

  test("creates and starts multiple sessions through the OpenWork backend", async () => {
    const fake = startFakeOpenWorkServer();
    const plugin = await OpenWorkExtensionsPreview({ directory: "/tmp/archive" });

    const output = await plugin.tool.openwork_execute.execute({
      id: "session.create",
      args: {
        sessions: [
          { title: "Look into dolphins", prompt: "Research dolphins." },
          { title: "Look into bananas", prompt: "Research bananas." },
          { title: "Look into apple pies", prompt: "Research apple pies." },
        ],
      },
    }, { sessionID: "ses_origin" });
    const parsed = affordanceResultSchema("session.create", createResultSchema).parse(JSON.parse(output));

    expect(parsed.result.ok).toBe(true);
    expect(parsed.result.workspaceId).toBe("ws_2");
    expect(parsed.result.created).toHaveLength(3);
    expect(parsed.result.failures).toEqual([]);
    expect(parsed.result.created.map((session) => session.title)).toEqual([
      "Look into dolphins",
      "Look into bananas",
      "Look into apple pies",
    ]);
    expect(parsed.result.created.map((session) => session.route).sort()).toEqual([
      "/workspace/ws_2/session/ses_created_1",
      "/workspace/ws_2/session/ses_created_2",
      "/workspace/ws_2/session/ses_created_3",
    ]);

    const createRequests = fake.requests.filter((request) => request.pathname === "/workspace/ws_2/opencode/session" && request.method === "POST");
    const promptRequests = fake.requests.filter((request) => request.pathname.endsWith("/prompt_async") && request.method === "POST");
    expect(createRequests).toHaveLength(3);
    expect(promptRequests).toHaveLength(3);
    expect([...createRequests, ...promptRequests].every((request) => request.authorization === "Bearer test-token")).toBe(true);
    expect(createRequests.map((request) => request.body)).toEqual(expect.arrayContaining([
      { title: "Look into dolphins" },
      { title: "Look into bananas" },
      { title: "Look into apple pies" },
    ]));
    expect(promptRequests.map((request) => request.body)).toEqual(expect.arrayContaining([
      { parts: [{ type: "text", text: "Research dolphins." }] },
      { parts: [{ type: "text", text: "Research bananas." }] },
      { parts: [{ type: "text", text: "Research apple pies." }] },
    ]));
  });

  test("reports a created session as failed when its native prompt does not start", async () => {
    const fake = startFakeOpenWorkServer({ failPromptText: "Fail this prompt." });
    const plugin = await OpenWorkExtensionsPreview({ directory: "/tmp/archive" });

    const output = await plugin.tool.openwork_execute.execute({
      id: "session.create",
      args: { sessions: [{ title: "Prompt failure", prompt: "Fail this prompt." }] },
    }, { sessionID: "ses_origin" });
    const parsed = z.object({
      ok: z.literal(false),
      id: z.literal("session.create"),
      error: z.string(),
      code: z.literal("failed"),
    }).parse(JSON.parse(output));

    expect(parsed.error).toBe("session.create failed");
    expect(fake.requests.filter((request) => request.pathname === "/workspace/ws_2/opencode/session" && request.method === "POST")).toHaveLength(1);
    expect(fake.requests.filter((request) => request.pathname.endsWith("/prompt_async") && request.method === "POST")).toHaveLength(1);
  });

  test("creates more than twenty sessions in one tool call", async () => {
    const fake = startFakeOpenWorkServer();
    const plugin = await OpenWorkExtensionsPreview({ directory: "/tmp/archive" });
    const sessions = Array.from({ length: 21 }, (_, index) => ({
      title: `Research topic ${index + 1}`,
      prompt: `Research topic ${index + 1}.`,
    }));

    const output = await plugin.tool.openwork_execute.execute({
      id: "session.create",
      args: { sessions },
    }, { sessionID: "ses_origin" });
    const parsed = affordanceResultSchema("session.create", createResultSchema).parse(JSON.parse(output));

    expect(parsed.result.ok).toBe(true);
    expect(parsed.result.created).toHaveLength(21);
    expect(parsed.result.failures).toEqual([]);
    expect(fake.requests.filter((request) => request.pathname === "/workspace/ws_2/opencode/session" && request.method === "POST")).toHaveLength(21);
    expect(fake.requests.filter((request) => request.pathname.endsWith("/prompt_async") && request.method === "POST")).toHaveLength(21);
  });
});

describe("OpenWorkExtensionsPreview semantic tool surface", () => {
  test("exposes only the three semantic tools", async () => {
    const plugin = await OpenWorkExtensionsPreview();
    const tools = Object.keys(plugin.tool).sort();

    expect(tools).toEqual(["openwork_context", "openwork_execute", "openwork_query"]);

    const system = await transformedSystem(plugin);
    expect(system).not.toContain("## Default Skill: skill-creator");
    expect(system).not.toContain("<openwork_default_skill");
    expect(system).not.toContain("openwork_ui_");
    expect(system).not.toContain("openwork_session_");
    expect(system).not.toContain("openwork_extension_");
    expect(system).not.toContain("openwork_browser_");
    expect(system).toContain("Use openwork_context");
    expect(system).toContain("session.search");
    expect(system).toContain("browser.open_url");
  });

  test("proposes an Automation without creating anything or calling a backend", async () => {
    const fake = startFakeOpenWorkServer();
    const plugin = await OpenWorkExtensionsPreview({ directory: "/tmp/archive" });

    const output = await plugin.tool.openwork_execute.execute({
      id: "automation.propose",
      args: {
        name: "Morning Slack check",
        instructions: "Summarize my most recent Slack message.",
        schedule: { kind: "daily", timezone: "Europe/Berlin", hour: 9, minute: 0 },
      },
    }, { sessionID: "ses_origin" });
    const parsed = affordanceResultSchema("automation.propose", automationProposalResultSchema)
      .parse(JSON.parse(output));

    expect(parsed.result.created).toBe(false);
    expect(parsed.result.proposal.name).toBe("Morning Slack check");
    expect(parsed.result.proposal.schedule).toEqual({
      kind: "daily",
      timezone: "Europe/Berlin",
      hour: 9,
      minute: 0,
    });
    // The whole point of proposal-only: an agent never reaches Den or the
    // local server, so it cannot bring an Automation into existence.
    expect(fake.requests).toHaveLength(0);
    expect(parsed.effects).toEqual({ data: "none", ui: "none", external: false });
  });

  test("discards a model-supplied workspaceId and pins the conversation's workspace", async () => {
    const plugin = await OpenWorkExtensionsPreview({ directory: "/tmp/archive", workspaceId: "ws_conversation" });

    const output = await plugin.tool.openwork_execute.execute({
      id: "automation.propose",
      args: {
        name: "Morning Slack check",
        instructions: "Summarize my most recent Slack message.",
        schedule: { kind: "daily", timezone: "Europe/Berlin", hour: 9, minute: 0 },
        // A prompt-injected agent must not be able to retarget the Automation.
        workspaceId: "ws_attacker",
      },
    }, { sessionID: "ses_origin" });
    const parsed = affordanceResultSchema("automation.propose", automationProposalResultSchema)
      .parse(JSON.parse(output));

    expect(parsed.result.proposal.workspaceId).toBe("ws_conversation");
  });

  test("rejects a proposal whose schedule is not a supported kind", async () => {
    const plugin = await OpenWorkExtensionsPreview({ directory: "/tmp/archive" });

    await expect(plugin.tool.openwork_execute.execute({
      id: "automation.propose",
      args: {
        name: "Every five minutes",
        instructions: "Say hello.",
        schedule: { kind: "interval", timezone: "Europe/Berlin", everyMinutes: 5 },
      },
    }, { sessionID: "ses_origin" })).rejects.toThrow();
  });
});
