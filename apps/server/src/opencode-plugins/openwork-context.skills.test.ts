import { afterEach, describe, expect, test } from "bun:test";

import {
  classifyOpenWorkContextBundleFailure,
  fetchOpenWorkContextBundle,
  resolveOpenWorkConnectSkillInstruction,
  type OpenWorkContextBundleFailure,
} from "./lib/connect-steering.js";

const originalServerUrl = process.env.OPENWORK_SERVER_URL;
const originalServerToken = process.env.OPENWORK_SERVER_TOKEN;

afterEach(() => {
  if (originalServerUrl === undefined) delete process.env.OPENWORK_SERVER_URL;
  else process.env.OPENWORK_SERVER_URL = originalServerUrl;
  if (originalServerToken === undefined) delete process.env.OPENWORK_SERVER_TOKEN;
  else process.env.OPENWORK_SERVER_TOKEN = originalServerToken;
});

async function captureContextBundleFailure(
  run: () => Promise<unknown>,
): Promise<{ failure: OpenWorkContextBundleFailure; rendered: string }> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  return {
    failure: classifyOpenWorkContextBundleFailure(caught),
    rendered: String(caught),
  };
}

describe("OpenWorkContext Connect skills", () => {
  test("bounds the per-turn loopback context request with an abort deadline", async () => {
    process.env.OPENWORK_SERVER_URL = "http://openwork.test";
    process.env.OPENWORK_SERVER_TOKEN = "skills-token";
    const observedSignals: AbortSignal[] = [];

    await fetchOpenWorkContextBundle({}, async (_url, init) => {
      if (init?.signal instanceof AbortSignal) observedSignals.push(init.signal);
      return Response.json({
        ok: true,
        schemaVersion: 1,
        steering: null,
        skills: { instruction: "", count: 0 },
        diagnostics: [],
        generatedAt: 1,
      });
    });

    expect(observedSignals).toHaveLength(1);
    expect(observedSignals[0]?.aborted).toBe(false);
  });

  test("rejects unknown context-bundle contract versions", async () => {
    process.env.OPENWORK_SERVER_URL = "http://openwork.test";
    process.env.OPENWORK_SERVER_TOKEN = "skills-token";

    await expect(fetchOpenWorkContextBundle({}, async () => Response.json({
      ok: true,
      schemaVersion: 2,
      steering: {
        connectEnabled: true,
        connectCatalogEnabled: true,
        cloudMcpPresent: false,
        cloudHealth: null,
        workspace: { resolution: "resolved", id: "ws_1", directory: "/tmp/ws_1" },
        googleWorkspace: { legacyConfigured: false },
      },
      skills: { instruction: "", count: 0 },
      diagnostics: [],
      generatedAt: 1,
    }))).rejects.toThrow();
  });

  test("classifies configuration failures without invoking transport", async () => {
    process.env.OPENWORK_SERVER_URL = "not-a-valid-server-url/private-fragment";
    process.env.OPENWORK_SERVER_TOKEN = "configuration-secret-token";
    let calls = 0;

    const result = await captureContextBundleFailure(() => fetchOpenWorkContextBundle({}, async () => {
      calls += 1;
      return Response.json({ ok: true });
    }));

    expect(result.failure).toEqual({ classification: "configuration" });
    expect(calls).toBe(0);
    expect(result.rendered).not.toContain("private-fragment");
    expect(result.rendered).not.toContain("configuration-secret-token");
  });

  test("classifies authentication and other HTTP statuses without retaining response payloads", async () => {
    process.env.OPENWORK_SERVER_URL = "http://openwork.test";
    process.env.OPENWORK_SERVER_TOKEN = "http-secret-token";
    const secretPayload = "sensitive-server-payload";
    const cases = [
      { status: 401, classification: "auth" },
      { status: 403, classification: "auth" },
      { status: 429, classification: "http" },
      { status: 503, classification: "http" },
    ] as const;

    for (const expected of cases) {
      const result = await captureContextBundleFailure(() => fetchOpenWorkContextBundle(
        {},
        async () => Response.json({ message: secretPayload }, { status: expected.status }),
      ));
      expect(result.failure).toEqual(expected);
      expect(result.rendered).not.toContain(secretPayload);
      expect(result.rendered).not.toContain("http-secret-token");
      expect(result.rendered).not.toContain("openwork.test");
    }
  });

  test("classifies schema and transport failures without retaining thrown details", async () => {
    process.env.OPENWORK_SERVER_URL = "http://openwork.test";
    process.env.OPENWORK_SERVER_TOKEN = "transport-secret-token";
    const schemaSecret = "sensitive-schema-payload";
    const transportSecret = "sensitive-transport-error";

    const schema = await captureContextBundleFailure(() => fetchOpenWorkContextBundle(
      {},
      async () => Response.json({ ok: true, schemaVersion: 2, detail: schemaSecret }),
    ));
    const transport = await captureContextBundleFailure(() => fetchOpenWorkContextBundle(
      {},
      async () => {
        throw new Error(`${transportSecret} http://private.example transport-secret-token`);
      },
    ));

    expect(schema.failure).toEqual({ classification: "schema" });
    expect(transport.failure).toEqual({ classification: "transport" });
    const rendered = `${schema.rendered}\n${transport.rendered}`;
    expect(rendered).not.toContain(schemaSecret);
    expect(rendered).not.toContain(transportSecret);
    expect(rendered).not.toContain("private.example");
    expect(rendered).not.toContain("transport-secret-token");
  });

  test("requests the server-scoped catalog and returns its instruction byte-for-byte", async () => {
    process.env.OPENWORK_SERVER_URL = "http://openwork.test/";
    process.env.OPENWORK_SERVER_TOKEN = "skills-token";
    const instruction = "<available_skills>\n<skill><name>briefing</name></skill>\n</available_skills>";
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({
        ok: true,
        schemaVersion: 1,
        instruction,
        diagnostics: ["one workspace skill"],
      });
    };

    await expect(resolveOpenWorkConnectSkillInstruction({
      context: { workspaceId: "ws_1", worktree: "/tmp/worktree" },
    }, fetcher)).resolves.toBe(instruction);
    expect(calls).toEqual([{
      url: "http://openwork.test/experimental/connect/skills",
      authorization: "Bearer skills-token",
    }]);
  });

  test("omits empty, failed, invalid, and unavailable catalogs", async () => {
    process.env.OPENWORK_SERVER_URL = "http://openwork.test";
    process.env.OPENWORK_SERVER_TOKEN = "skills-token";

    await expect(resolveOpenWorkConnectSkillInstruction({}, async () => Response.json({
      ok: true,
      schemaVersion: 1,
      instruction: "",
    }))).resolves.toBe("");
    await expect(resolveOpenWorkConnectSkillInstruction({}, async () =>
      Response.json({ message: "unavailable" }, { status: 503 })
    )).resolves.toBe("");
    await expect(resolveOpenWorkConnectSkillInstruction({}, async () => Response.json({ ok: true }))).resolves.toBe("");
    await expect(resolveOpenWorkConnectSkillInstruction({}, async () => {
      throw new Error("network unavailable");
    })).resolves.toBe("");
  });
});
