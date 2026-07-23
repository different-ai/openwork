import { afterEach, describe, expect, spyOn, test } from "bun:test";

import {
  promptTraceId,
  recordPromptContributorProvenance,
} from "./openwork-debug-log.js";
import { OpenWorkPromptLog } from "./openwork-prompt-log.js";

const originalPromptLog = process.env.OPENWORK_PROMPT_LOG;
const originalDevMode = process.env.OPENWORK_DEV_MODE;
const originalDesktopDevMode = process.env.OPENWORK_DESKTOP_DEV_MODE;
const originalDesktopPromptLog = process.env.OPENWORK_DESKTOP_PROMPT_LOG;
const originalObservability = process.env.OPENWORK_OBSERVABILITY;

function restoreEnv(
  name: "OPENWORK_PROMPT_LOG" | "OPENWORK_DEV_MODE" | "OPENWORK_DESKTOP_DEV_MODE" | "OPENWORK_DESKTOP_PROMPT_LOG" | "OPENWORK_OBSERVABILITY",
  value: string | undefined,
): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("OpenWork prompt log plugin", () => {
  afterEach(() => {
    restoreEnv("OPENWORK_PROMPT_LOG", originalPromptLog);
    restoreEnv("OPENWORK_DEV_MODE", originalDevMode);
    restoreEnv("OPENWORK_DESKTOP_DEV_MODE", originalDesktopDevMode);
    restoreEnv("OPENWORK_DESKTOP_PROMPT_LOG", originalDesktopPromptLog);
    restoreEnv("OPENWORK_OBSERVABILITY", originalObservability);
  });

  test("is off by default and emits only safe initialization metadata", async () => {
    delete process.env.OPENWORK_PROMPT_LOG;
    delete process.env.OPENWORK_DEV_MODE;
    delete process.env.OPENWORK_DESKTOP_DEV_MODE;
    delete process.env.OPENWORK_DESKTOP_PROMPT_LOG;
    delete process.env.OPENWORK_OBSERVABILITY;
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((message) => {
      errors.push(String(message));
    });
    try {
      const plugin = await OpenWorkPromptLog();
      await plugin["experimental.chat.system.transform"](
        { sessionID: "raw-session-must-not-appear" },
        { system: ["private prompt must not appear"] },
      );
      await plugin["chat.params"]({ sessionID: "raw-session-must-not-appear" });

      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(
        /^\[openwork\]\[agent-prompt\] observer initialized: at=\d{4}-\d{2}-\d{2}T.+Z, level=off, enabled=false, exact=false, source=default$/,
      );
      expect(errors.join("\n")).not.toContain("private prompt");
      expect(errors.join("\n")).not.toContain("raw-session-must-not-appear");
    } finally {
      spy.mockRestore();
    }
  });

  test("uses dev mode for metadata without logging exact prompt content", async () => {
    delete process.env.OPENWORK_PROMPT_LOG;
    process.env.OPENWORK_DEV_MODE = "1";
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((message) => {
      errors.push(String(message));
    });
    try {
      const plugin = await OpenWorkPromptLog();
      const output = { system: ["engine base", "dev-mode prompt"] };
      await plugin["experimental.chat.system.transform"](
        { agent: "openwork", sessionID: "private-session-id" },
        output,
      );
      await plugin["chat.params"]({
        agent: "openwork",
        sessionID: "private-session-id",
      });

      const joined = errors.join("\n");
      expect(joined).toContain("level=metadata, enabled=true, exact=false, source=OPENWORK_DEV_MODE");
      expect(joined).toContain("observed system array changed");
      expect(joined).toContain("reason=exact-provenance-disabled");
      expect(joined).not.toContain("BEGIN OBSERVED SYSTEM ARRAY");
      expect(joined).not.toContain("dev-mode prompt");
      expect(joined).not.toContain("engine base");
      expect(joined).not.toContain("private-session-id");
      expect(output.system).toEqual(["engine base", "dev-mode prompt"]);
    } finally {
      spy.mockRestore();
    }
  });

  test("honors an explicit opt-out over dev mode and never prints prompt content", async () => {
    process.env.OPENWORK_PROMPT_LOG = "0";
    process.env.OPENWORK_DEV_MODE = "1";
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((message) => {
      errors.push(String(message));
    });
    try {
      const plugin = await OpenWorkPromptLog();
      await plugin["experimental.chat.system.transform"](
        { sessionID: "private-session-id" },
        { system: ["private prompt must not appear"] },
      );
      await plugin["chat.params"]({ sessionID: "private-session-id" });

      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("level=off, enabled=false, exact=false, source=OPENWORK_PROMPT_LOG");
    } finally {
      spy.mockRestore();
    }
  });

  test("observes actionable MCP names and safe failure classes without logging raw errors", async () => {
    process.env.OPENWORK_PROMPT_LOG = "1";
    delete process.env.OPENWORK_DEV_MODE;
    let status = "failed";
    let statusError = "secret oauth bearer token must not be logged";
    let calls = 0;
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((message) => {
      errors.push(String(message));
    });
    try {
      const plugin = await OpenWorkPromptLog({
        directory: "/private/workspace",
        client: {
          mcp: {
            status: async () => {
              calls += 1;
              return {
                data: {
                  "private-enterprise-server": {
                    status,
                    error: statusError,
                  },
                },
              };
            },
          },
        },
      });
      expect(calls).toBe(0);
      await plugin["experimental.chat.system.transform"](
        { sessionID: "mcp-observer-session-1" },
        { system: [] },
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      statusError = "private TLS certificate endpoint must not be logged";
      await plugin["experimental.chat.system.transform"](
        { sessionID: "mcp-observer-session-2" },
        { system: [] },
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      status = "connected";
      await plugin["experimental.chat.system.transform"](
        { sessionID: "mcp-observer-session-3" },
        { system: [] },
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      status = "failed";
      statusError = "private network socket endpoint must not be logged";
      await plugin.event({
        event: {
          type: "mcp.tools.changed",
          properties: { server: "private-enterprise-server" },
        },
      });

      const rendered = errors.join("\n");
      expect(calls).toBeGreaterThanOrEqual(4);
      expect(rendered).toContain("[openwork][mcp-status] trigger=prompt server=\"private-enterprise-server\" serverHash=");
      expect(rendered).toContain("previous=unobserved status=failed failureClass=auth");
      expect(rendered).toContain("previous=failed previousFailureClass=auth status=failed failureClass=transport");
      expect(rendered).toContain("trigger=event");
      expect(rendered).toContain("status=tools-changed");
      expect(rendered).toContain("previous=failed previousFailureClass=transport status=connected");
      expect(rendered).toContain("trigger=event server=\"private-enterprise-server\"");
      expect(rendered).toContain("previous=connected status=failed failureClass=transport");
      expect(rendered).not.toContain("private TLS certificate");
      expect(rendered).not.toContain("private network socket endpoint");
      expect(rendered).not.toContain("bearer token");
      expect(rendered).not.toContain("/private/workspace");
    } finally {
      spy.mockRestore();
    }
  });

  test("detects changes per session and logs only hashed session labels", async () => {
    process.env.OPENWORK_PROMPT_LOG = "1";
    delete process.env.OPENWORK_DEV_MODE;
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((message) => {
      errors.push(String(message));
    });
    try {
      const plugin = await OpenWorkPromptLog();
      errors.length = 0;
      const output = { system: ["shared prompt"] };

      await plugin["experimental.chat.system.transform"]({ sessionID: "private-session-one" }, output);
      await plugin["chat.params"]({ sessionID: "private-session-one" });
      await plugin["experimental.chat.system.transform"]({ sessionID: "private-session-two" }, output);
      await plugin["chat.params"]({ sessionID: "private-session-two" });
      await plugin["experimental.chat.system.transform"]({ sessionID: "private-session-one" }, output);
      await plugin["chat.params"]({ sessionID: "private-session-one" });

      const metadata = errors.filter((entry) => entry.includes("observed system array "));
      expect(metadata).toHaveLength(3);
      expect(metadata[0]).toContain("observed system array changed");
      expect(metadata[0]).toContain("previousHash=none delta=initial");
      expect(metadata[1]).toContain("observed system array changed");
      expect(metadata[2]).toContain("observed system array unchanged");
      expect(metadata[2]).toMatch(/previousHash=[a-f0-9]{64} delta=none/);
      expect(errors.join("\n")).not.toContain("private-session-one");
      expect(errors.join("\n")).not.toContain("private-session-two");
    } finally {
      spy.mockRestore();
    }
  });

  test("bounds per-session change tracking and evicts the least recently used session", async () => {
    process.env.OPENWORK_PROMPT_LOG = "1";
    delete process.env.OPENWORK_DEV_MODE;
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((message) => {
      errors.push(String(message));
    });
    try {
      const plugin = await OpenWorkPromptLog();
      const output = { system: ["shared bounded prompt"] };

      // The tracker holds 128 sessions. The 129th unique session evicts the
      // first; seeing it again must therefore be reported as changed.
      for (let index = 0; index <= 128; index += 1) {
        await plugin["experimental.chat.system.transform"]({ sessionID: `session-${index}` }, output);
        await plugin["chat.params"]({ sessionID: `session-${index}` });
      }
      errors.length = 0;
      await plugin["experimental.chat.system.transform"]({ sessionID: "session-0" }, output);
      await plugin["chat.params"]({ sessionID: "session-0" });

      expect(errors.some((entry) => entry.includes("observed system array changed"))).toBe(true);
      expect(errors.some((entry) => entry.includes("observed system array unchanged"))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test("observes later plugin mutations and OpenCode normalization at chat.params", async () => {
    process.env.OPENWORK_PROMPT_LOG = "1";
    delete process.env.OPENWORK_DEV_MODE;
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((message) => {
      errors.push(String(message));
    });
    try {
      const plugin = await OpenWorkPromptLog();
      const output = { system: ["engine header", "openwork block"] };
      const input = { sessionID: "terminal-session" };
      await plugin["experimental.chat.system.transform"](input, output);

      // Simulate a project plugin that runs after the observer, followed by
      // OpenCode v1.17.11's post-transform normalization.
      output.system.push("later project block");
      const rest = output.system.slice(1);
      output.system.length = 0;
      output.system.push("engine header", rest.join("\n"));
      await plugin["chat.params"]({ sessionID: "terminal-session" });

      const rendered = errors.join("\n");
      expect(rendered).toContain("boundary=post-system-hooks");
      expect(rendered).toContain("blocks=2");
      expect(rendered).toContain(JSON.stringify("openwork block\nlater project block"));
      expect(rendered).not.toContain("block 3/3");
    } finally {
      spy.mockRestore();
    }
  });

  test("drops a stale capture when a later hook aborted the prior request", async () => {
    process.env.OPENWORK_PROMPT_LOG = "1";
    delete process.env.OPENWORK_DEV_MODE;
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((message) => {
      errors.push(String(message));
    });
    try {
      const plugin = await OpenWorkPromptLog();
      errors.length = 0;
      const staleInput = { sessionID: "same-private-session" };
      const currentInput = { sessionID: "same-private-session" };
      const staleTrace = promptTraceId(staleInput);
      const currentTrace = promptTraceId(currentInput);

      await plugin["experimental.chat.system.transform"](
        staleInput,
        { system: ["stale prompt from aborted hook chain"] },
      );
      // No chat.params follows: simulate a later plugin throwing.
      await plugin["experimental.chat.system.transform"](
        currentInput,
        { system: ["current successful prompt"] },
      );
      await plugin["chat.params"]({
        sessionID: "same-private-session",
        message: { id: "current-request" },
      });

      const rendered = errors.join("\n");
      expect(rendered).toContain(`trace=${currentTrace}`);
      expect(rendered).toContain("current successful prompt");
      expect(rendered).not.toContain(staleTrace);
      expect(rendered).not.toContain("stale prompt from aborted hook chain");
      expect(errors.filter((entry) => entry.includes("BEGIN OBSERVED SYSTEM ARRAY"))).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  test("keeps concurrent same-session model requests correlated to their own async flow", async () => {
    process.env.OPENWORK_PROMPT_LOG = "1";
    delete process.env.OPENWORK_DEV_MODE;
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((message) => {
      errors.push(String(message));
    });
    try {
      const plugin = await OpenWorkPromptLog();
      errors.length = 0;
      let releaseMain!: () => void;
      let releaseTitle!: () => void;
      const mainGate = new Promise<void>((resolve) => { releaseMain = resolve; });
      const titleGate = new Promise<void>((resolve) => { releaseTitle = resolve; });

      // Register both continuations before either request enters the observer
      // context, then force title params to run between main transform/params.
      const root = Promise.resolve();
      const main = root.then(async () => {
        const input = {
          sessionID: "shared-private-session",
          model: { providerID: "provider", modelID: "main-model" },
        };
        const trace = promptTraceId(input);
        await plugin["experimental.chat.system.transform"](input, { system: ["main prompt"] });
        releaseTitle();
        await mainGate;
        await plugin["chat.params"](input);
        return trace;
      });
      const title = root.then(async () => {
        const input = {
          sessionID: "shared-private-session",
          model: { providerID: "provider", modelID: "title-model" },
        };
        const trace = promptTraceId(input);
        await titleGate;
        await plugin["experimental.chat.system.transform"](input, { system: ["title prompt"] });
        await plugin["chat.params"](input);
        releaseMain();
        return trace;
      });

      const [mainTrace, titleTrace] = await Promise.all([main, title]);
      const rendered = errors.join("\n");
      expect(rendered).toContain(`trace=${mainTrace}`);
      expect(rendered).toContain(`trace=${titleTrace}`);
      expect(rendered).toContain(JSON.stringify("main prompt"));
      expect(rendered).toContain(JSON.stringify("title prompt"));
      expect(rendered).not.toContain("reason=request-context-mismatch");
      expect(errors.filter((entry) => entry.includes("BEGIN OBSERVED SYSTEM ARRAY"))).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });

  test("reports unavailable instead of emitting a cross-request prompt on context mismatch", async () => {
    process.env.OPENWORK_PROMPT_LOG = "1";
    delete process.env.OPENWORK_DEV_MODE;
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((message) => {
      errors.push(String(message));
    });
    try {
      const plugin = await OpenWorkPromptLog();
      errors.length = 0;
      await plugin["experimental.chat.system.transform"](
        { sessionID: "session-a", model: { providerID: "provider", modelID: "model-a" } },
        { system: ["must not be emitted"] },
      );
      await plugin["chat.params"]({
        sessionID: "session-b",
        model: { providerID: "provider", modelID: "model-b" },
      });

      const rendered = errors.join("\n");
      expect(rendered).toContain("reason=request-context-mismatch");
      expect(rendered).not.toContain("must not be emitted");
      expect(rendered).not.toContain("BEGIN OBSERVED SYSTEM ARRAY");
    } finally {
      spy.mockRestore();
    }
  });

  test("renders exact prompt text without executing terminal controls or spoofed log lines", async () => {
    process.env.OPENWORK_PROMPT_LOG = "1";
    delete process.env.OPENWORK_DEV_MODE;
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((message) => {
      errors.push(String(message));
    });
    try {
      const plugin = await OpenWorkPromptLog();
      errors.length = 0;
      const hostile = "before\u001b]52;c;Y2xpcGJvYXJk\u0007\n[openwork][spoof] fake\u0085after\u2028done\u202ereversed";
      await plugin["experimental.chat.system.transform"](
        { sessionID: "terminal-control-session" },
        { system: [hostile] },
      );
      await plugin["chat.params"]({ sessionID: "terminal-control-session" });

      const rendered = errors.join("\n");
      expect(rendered).toContain("encoding json-string");
      expect(rendered).toContain("\\u001b]52;c;Y2xpcGJvYXJk\\u0007\\n[openwork][spoof] fake\\u0085after\\u2028done\\u202ereversed");
      expect(rendered).not.toContain("\u001b");
      expect(rendered).not.toContain("\u0007");
      expect(rendered).not.toContain("\u0085");
      expect(rendered).not.toContain("\u2028");
      expect(rendered).not.toContain("\u202e");
      expect(rendered).not.toContain("\n[openwork][spoof] fake");
    } finally {
      spy.mockRestore();
    }
  });

  test("maps contributor text-correspondence candidates after OpenCode coalesces blocks", async () => {
    process.env.OPENWORK_PROMPT_LOG = "1";
    delete process.env.OPENWORK_DESKTOP_DEV_MODE;
    delete process.env.OPENWORK_DEV_MODE;
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((message) => {
      errors.push(String(message));
    });
    try {
      const plugin = await OpenWorkPromptLog();
      errors.length = 0;
      const input = { sessionID: "provenance-session" };
      const trace = promptTraceId(input);
      recordPromptContributorProvenance(trace, {
        contributorId: "connect-steering",
        text: "steering",
        chars: 8,
        hash: "bd9b587dc4ad0000000000000000000000000000000000000000000000000000",
      });
      recordPromptContributorProvenance(trace, {
        contributorId: "connect-skills",
        text: "skills",
        chars: 6,
        hash: "3e479a2aca360000000000000000000000000000000000000000000000000000",
      });

      const output = { system: ["engine", "steering", "skills"] };
      await plugin["experimental.chat.system.transform"](input, output);
      output.system.splice(1, 2, output.system.slice(1).join("\n"));
      await plugin["chat.params"](input);

      const rendered = errors.join("\n");
      expect(rendered).toContain(
        `provenance trace=${trace} contributor=connect-steering contributorHash=bd9b587dc4ad0000000000000000000000000000000000000000000000000000 chars=8 match=text-correspondence causalOrigin=unproven finalBlock=2 start=0 end=8`,
      );
      expect(rendered).toContain(
        `provenance trace=${trace} contributor=connect-skills contributorHash=3e479a2aca360000000000000000000000000000000000000000000000000000 chars=6 match=text-correspondence causalOrigin=unproven finalBlock=2 start=9 end=15`,
      );
      expect(rendered).toContain(
        `provenance trace=${trace} origin=unattributed classification=open-code-or-external-plugin finalBlock=1 start=0 end=6`,
      );
      expect(rendered).toContain(
        `provenance trace=${trace} origin=unattributed classification=open-code-or-external-plugin finalBlock=2 start=8 end=9`,
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("reports ambiguous provenance instead of inventing an origin span", async () => {
    process.env.OPENWORK_PROMPT_LOG = "1";
    delete process.env.OPENWORK_DESKTOP_DEV_MODE;
    delete process.env.OPENWORK_DEV_MODE;
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((message) => {
      errors.push(String(message));
    });
    try {
      const plugin = await OpenWorkPromptLog();
      errors.length = 0;
      const input = { sessionID: "ambiguous-provenance-session" };
      const trace = promptTraceId(input);
      recordPromptContributorProvenance(trace, {
        contributorId: "connect-skills",
        text: "repeated",
        chars: 8,
        hash: "aabbccddeeff0000000000000000000000000000000000000000000000000000",
      });
      const output = { system: ["engine", "repeated\nrepeated"] };
      await plugin["experimental.chat.system.transform"](input, output);
      await plugin["chat.params"](input);

      expect(errors.join("\n")).toContain(
        `provenance trace=${trace} contributor=connect-skills contributorHash=aabbccddeeff0000000000000000000000000000000000000000000000000000 chars=8 match=ambiguous occurrences=2 truncated=true`,
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("hashes dynamic agent and model labels before writing metadata", async () => {
    process.env.OPENWORK_PROMPT_LOG = "1";
    delete process.env.OPENWORK_DESKTOP_DEV_MODE;
    delete process.env.OPENWORK_DEV_MODE;
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((message) => {
      errors.push(String(message));
    });
    try {
      const plugin = await OpenWorkPromptLog();
      errors.length = 0;
      const input = {
        agent: "hostile-agent\u001b]52;c;YQ==\u0007\n[openwork][spoof]",
        model: {
          providerID: "private-provider\u0085",
          modelID: "private-model\u2028",
        },
        sessionID: "private-session",
      };
      await plugin["experimental.chat.system.transform"](input, { system: ["safe"] });
      await plugin["chat.params"](input);

      const rendered = errors.join("\n");
      expect(rendered).toContain("agentHash=");
      expect(rendered).toContain("modelHash=");
      expect(rendered).toContain("sessionHash=");
      expect(rendered).not.toContain("hostile-agent");
      expect(rendered).not.toContain("private-provider");
      expect(rendered).not.toContain("private-model");
      expect(rendered).not.toContain("private-session");
      expect(rendered).not.toContain("\u001b");
      expect(rendered).not.toContain("\u0007");
      expect(rendered).not.toContain("\u0085");
      expect(rendered).not.toContain("\u2028");
      expect(rendered).not.toContain("\n[openwork][spoof]");
    } finally {
      spy.mockRestore();
    }
  });
});
