import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { libraryMcpServersFromConfig } from "../worlds/desktop.ts";

const test = spec.world(libraryMcpServersFromConfig, {
  resources: {
    surfaces: ["desktop"],
    services: ["den", "mock"],
    nativeReason: "Read hand-written workspace MCP configuration through the Electron desktop bridge.",
  },
});

// People paste MCP servers into opencode.json from Claude Desktop or Cursor,
// where the shape is `command: "python3", args: [...]`. OpenWork must list that
// server beside its own `command: [...]` shape instead of blanking Settings.
test("the Library lists MCP servers written by hand into opencode.json, whichever command shape they use", async ({ world, user, agent, probe, step, evidence }) => {
  await step("opencode.json contains the enabled mock before the workspace is opened", async () => {
    expect(world.configWrite).toMatchObject({ ok: true });
    const config = await probe.desktopApi(`/workspace/${encodeURIComponent(world.workspace.workspaceId)}/mcp`);
    expect(config).toMatchObject({
      status: 200,
      body: { items: expect.arrayContaining([
        expect.objectContaining({ name: "ready-helper", config: expect.objectContaining({ url: world.readyMock.mcpUrl, enabled: true }) }),
      ]) },
    });
  });

  await step("the enabled mock completes a real MCP handshake and reaches connected", async () => {
    await agent.run("route.extensions.skills");
    await user.see({ text: "Library" });
    await user.click({ role: "button", label: "All" });
    await probe.eventually(async () => {
      const status = await probe.desktopApi(`/workspace/${encodeURIComponent(world.workspace.workspaceId)}/opencode/mcp`);
      expect(status).toMatchObject({ status: 200, body: { "ready-helper": { status: "connected" } } });
      return true;
    }, { within: 60_000, label: "ready-helper connected in the workspace engine" });
    await probe.eventually(async () => {
      const handshakes = await world.readyMock.handshakes({ sinceIso: world.handshakeSince });
      expect(handshakes).toEqual(expect.arrayContaining([
        expect.objectContaining({ method: "POST", path: "/mcp", status: 200 }),
      ]));
      return true;
    }, { within: 15_000, label: "the mock witnessed a successful MCP initialize" });
  });

  await step("On this computer lists every hand-written server, and only the connected mock reads as ready", async () => {
    await user.see({ text: "ready-helper" }, { timeoutMs: 60_000 });
    for (const name of ["docs-helper", "files-helper", "remote-helper"]) await user.see({ text: name });
    const servers = ["ready-helper", "docs-helper", "files-helper", "remote-helper"];
    const ready = await probe.eventually(
      async () => {
        const rows = (await probe.dom('[data-library-section="mac"] [data-library-row]:has([data-library-ready])')).elements;
        return servers.filter((name) => rows.some((row) => row.text.startsWith(name)));
      },
      { within: 60_000, label: "the connected mock reads as ready", until: (names) => names.includes("ready-helper") },
    );
    for (const name of ["docs-helper", "files-helper", "remote-helper"]) expect(ready).not.toContain(name);
    // Advanced still owns creation only; the inventory does not live there.
    await user.click({ role: "button", label: /^Advanced\b/ });
    await user.see({ role: "button", label: "Add workspace MCP" });
    expect((await probe.dom('button[aria-expanded="true"]')).elements.filter((element) => /^Advanced\b/.test(element.text))).toHaveLength(1);
    await user.click({ role: "button", label: /^Advanced\b/ });
    await user.screenshot();
    evidence.recordAssertionEvidence(
      "Library readiness follows a real MCP connection",
      `The fixture wrote ready-helper into opencode.json before opening the workspace, without an MCP registration API call. It completed MCP initialize and the workspace engine reported connected. On this computer lists all four servers; ready: ${ready.join(", ")}; the three disabled entries carry no ready mark.`,
      ready.includes("ready-helper"),
    );
  });

  await step("Settings stayed a working page rather than a blank document", async () => {
    const body = await probe.text();
    expect(body).toContain("docs-helper");
    expect(body).toContain("files-helper");
    expect(body.length).toBeGreaterThan(200);
    evidence.recordAssertionEvidence(
      "A Claude-style string command no longer blanks Settings",
      "With docs-helper written as command: \"python3\", args: [...] beside an array-command server and a remote server, Settings rendered and the Library listed all three as local items under On this computer while Advanced kept only workspace MCP creation.",
      true,
    );
  });

  await step("opening the string-command server shows its command line", async () => {
    await user.click({ text: "docs-helper" });
    await user.see({ text: "Local · this workspace" });
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
