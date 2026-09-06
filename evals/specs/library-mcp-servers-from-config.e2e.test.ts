import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { emptySession } from "../worlds/desktop.ts";

const test = spec.world(emptySession);

// People paste MCP servers into opencode.json from Claude Desktop or Cursor,
// where the shape is `command: "python3", args: [...]`. OpenWork must list that
// server beside its own `command: [...]` shape instead of blanking Settings.
const handWrittenConfig = {
  $schema: "https://opencode.ai/config.json",
  mcp: {
    "docs-helper": { type: "local", command: "python3", args: ["-m", "http.server", "8321"], enabled: false },
    "files-helper": { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-filesystem"], enabled: false },
    "remote-helper": { type: "remote", url: "https://mcp.example.test/sse", enabled: false },
  },
};

test("the Library lists MCP servers written by hand into opencode.json, whichever command shape they use", async ({ world, seed, user, agent, probe, step, evidence }) => {
  await step("a person writes three servers into the workspace's opencode.json", async () => {
    const written = await seed.evalIn(world.app, `async (workspacePath, content) => {
      const result = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("writeOpencodeConfig", "project", workspacePath, content);
      return result ?? { ok: false, stderr: "desktop bridge unavailable" };
    }`, { args: [world.workspacePath, `${JSON.stringify(handWrittenConfig, null, 2)}\n`], awaitPromise: true });
    expect(written).toMatchObject({ ok: true });
  });

  await step("Settings opens and the Library lists every server", async () => {
    await agent.run("route.extensions.skills");
    await user.see({ text: "Library" });
    await user.click({ role: "button", label: "MCPs" });
    await user.see({ text: "docs-helper" });
    await user.see({ text: "files-helper" });
    await user.see({ text: "remote-helper" });
    await user.screenshot();
  });

  await step("Settings stayed a working page rather than a blank document", async () => {
    const body = await probe.text();
    expect(body).toContain("docs-helper");
    expect(body).toContain("files-helper");
    expect(body.length).toBeGreaterThan(200);
    evidence.recordAssertionEvidence(
      "A Claude-style string command no longer blanks Settings",
      "With docs-helper written as command: \"python3\", args: [...] beside an array-command server and a remote server, Settings rendered and the MCPs filter listed all three names.",
      true,
    );
  });

  await step("expanding the string-command server shows its command line", async () => {
    await user.click({ text: "docs-helper" });
    await user.click({ text: "Technical details" });
    await user.see({ text: "python3 -m http.server 8321" });
    await user.notSee({ text: "python3,-m" });
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "String command and args are read as one command list",
      "Technical details showed \"python3 -m http.server 8321\" for the hand-written entry, proving the parser folded command and args into one list rather than treating the string as an array.",
      true,
    );
  });
});
