import { afterEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { OpenWorkContext } from "./openwork-context.js";

const fixturePath = join(import.meta.dir, "__fixtures__", "system-blocks-baseline.json");

const originalServerUrl = process.env.OPENWORK_SERVER_URL;
const originalServerToken = process.env.OPENWORK_SERVER_TOKEN;
const originalUiControlTools = process.env.OPENWORK_UI_CONTROL_TOOLS;
const originalPromptLog = process.env.OPENWORK_PROMPT_LOG;
const stops: Array<() => void> = [];

type SteeringScenario = {
  id: string;
  engineStatus: "connected" | "disabled" | "needs_auth" | null;
};

type SkillsScenario = {
  id: string;
  response: "present" | "empty" | "http-error";
};

type RequestRecord = {
  pathname: string;
  directory: string | null;
  steering: string | null;
  authorization: string | null;
};

const steeringScenarios: SteeringScenario[] = [
  { id: "engine-connected", engineStatus: "connected" },
  { id: "engine-disabled", engineStatus: "disabled" },
  { id: "engine-needs-auth", engineStatus: "needs_auth" },
  { id: "engine-not-found-server-fallback", engineStatus: null },
];

const skillsScenarios: SkillsScenario[] = [
  { id: "skills-present", response: "present" },
  { id: "skills-empty", response: "empty" },
  { id: "skills-http-error", response: "http-error" },
];

const uiScenarios = [
  { id: "ui-off", enabled: false },
  { id: "ui-on", enabled: true },
];

afterEach(() => {
  while (stops.length) stops.pop()?.();
  restoreEnv("OPENWORK_SERVER_URL", originalServerUrl);
  restoreEnv("OPENWORK_SERVER_TOKEN", originalServerToken);
  restoreEnv("OPENWORK_UI_CONTROL_TOOLS", originalUiControlTools);
  restoreEnv("OPENWORK_PROMPT_LOG", originalPromptLog);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function skillsResponse(directory: string | null): SkillsScenario["response"] {
  const scenario = skillsScenarios.find((candidate) => directory?.includes(`/${candidate.id}/`));
  if (!scenario) throw new Error(`Missing skills scenario in directory: ${directory ?? "<none>"}`);
  return scenario.response;
}

function startFakeOpenWorkServer(): { requests: RequestRecord[] } {
  const requests: RequestRecord[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const directory = url.searchParams.get("directory");
      requests.push({
        pathname: url.pathname,
        directory,
        steering: url.searchParams.get("steering"),
        authorization: request.headers.get("authorization"),
      });

      if (request.headers.get("authorization") !== "Bearer baseline-token") {
        return Response.json({ message: "Unauthorized" }, { status: 401 });
      }

      if (url.pathname === "/experimental/connect/context") {
        const behavior = skillsResponse(directory);
        return Response.json({
          ok: true,
          schemaVersion: 1,
          steering: {
            connectEnabled: true,
            connectCatalogEnabled: true,
            cloudMcpPresent: true,
            cloudHealth: url.searchParams.get("steering") === "passive" ? null : {
              usable: true,
              usableByCurrentModel: true,
              phase: "ready",
              workspace: { id: "ws_baseline", directory },
              desired: { present: true, revision: "rev_baseline" },
              firstFailure: null,
            },
            workspace: {
              resolution: "resolved",
              id: "ws_baseline",
              directory,
            },
            googleWorkspace: { legacyConfigured: false },
          },
          skills: {
            count: behavior === "present" ? 1 : 0,
            instruction: behavior === "present"
              ? "<available_skills>\n<skill>\n<name>customer-briefing</name>\n<description>Prepare a customer briefing.</description>\n</skill>\n</available_skills>"
              : "",
          },
          diagnostics: behavior === "present"
            ? ["baseline skill catalog present"]
            : [behavior === "http-error" ? "baseline skill catalog failure" : "baseline skill catalog empty"],
          generatedAt: 1,
        });
      }

      return Response.json({ message: "Not found" }, { status: 404 });
    },
  });

  stops.push(() => server.stop(true));
  process.env.OPENWORK_SERVER_URL = `http://127.0.0.1:${server.port}`;
  process.env.OPENWORK_SERVER_TOKEN = "baseline-token";
  return { requests };
}

function engineClient(status: SteeringScenario["engineStatus"], calls: unknown[]) {
  return {
    mcp: {
      async status(request: unknown) {
        calls.push(request);
        return status === null
          ? { data: { "unrelated-mcp": { status: "connected" } } }
          : { data: { "openwork-cloud": { status } } };
      },
    },
  };
}

function toolDescriptionMap(tools: Record<string, Readonly<Record<string, unknown>>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tools)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, definition]) => {
        if (typeof definition.description !== "string") {
          throw new Error(`Tool ${name} does not expose a string description`);
        }
        return [name, definition.description];
      }),
  );
}

async function buildBaseline() {
  const fake = startFakeOpenWorkServer();
  const scenarios: Record<string, unknown> = {};
  const engineCalls: Array<{ scenario: string; calls: unknown[] }> = [];

  process.env.OPENWORK_PROMPT_LOG = "0";

  for (const steering of steeringScenarios) {
    for (const skills of skillsScenarios) {
      for (const ui of uiScenarios) {
        if (ui.enabled) process.env.OPENWORK_UI_CONTROL_TOOLS = "1";
        else delete process.env.OPENWORK_UI_CONTROL_TOOLS;

        const scenario = `${steering.id}__${skills.id}__${ui.id}`;
        const directory = `/tmp/openwork-context-baseline/${steering.id}/${skills.id}/${ui.id}`;
        const calls: unknown[] = [];
        const context = await OpenWorkContext({
          client: engineClient(steering.engineStatus, calls),
          directory,
        });
        const output: { system: string[] } = { system: [] };

        const transform = context["experimental.chat.system.transform"];
        if (!transform) throw new Error("Consolidated context system transform is missing");
        await transform({}, output);

        scenarios[scenario] = {
          steering: steering.id,
          skills: skills.id,
          uiControlTools: ui.enabled,
          system: output.system,
          tools: toolDescriptionMap(context.tool ?? {}),
        };
        engineCalls.push({ scenario, calls });
      }
    }
  }

  expect(engineCalls.every((entry) => entry.calls.length === 1)).toBe(true);
  expect(fake.requests.filter((request) => request.pathname === "/experimental/connect/context")).toHaveLength(24);
  expect(fake.requests.every((request) => request.steering === "passive")).toBe(true);
  expect(fake.requests.filter((request) => request.pathname === "/experimental/connect/state")).toHaveLength(0);
  expect(fake.requests.filter((request) => request.pathname === "/experimental/connect/skills")).toHaveLength(0);
  expect(fake.requests.every((request) => request.authorization === "Bearer baseline-token")).toBe(true);

  return {
    schemaVersion: 1,
    matrix: {
      steering: steeringScenarios.map((scenario) => scenario.id),
      skills: skillsScenarios.map((scenario) => scenario.id),
      uiControlTools: uiScenarios.map((scenario) => scenario.id),
    },
    scenarios,
  };
}

describe("OpenWork context injection baseline", () => {
  test("matches the frozen system blocks and tool descriptions", async () => {
    const actual = await buildBaseline();

    if (process.env.UPDATE_OPENWORK_CONTEXT_BASELINE === "1") {
      await mkdir(dirname(fixturePath), { recursive: true });
      await Bun.write(fixturePath, `${JSON.stringify(actual, null, 2)}\n`);
    }

    const expected: unknown = await Bun.file(fixturePath).json();
    expect(expected).toEqual(actual);
  });
});
