import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { libraryMcpServersFromConfig } from "../worlds/desktop.ts";

const test = spec.world(libraryMcpServersFromConfig);

// People paste MCP servers into opencode.json from Claude Desktop or Cursor,
// where the shape is `command: "python3", args: [...]`. OpenWork must list that
// server beside its own `command: [...]` shape instead of blanking Settings.
test("the Library lists MCP servers written by hand into opencode.json, whichever command shape they use", async ({ world, user, agent, probe, step, evidence }) => {
  await step("the workspace fixture wrote three servers into opencode.json", async () => {
    expect(world.configWrite).toMatchObject({ ok: true });
  });

  await step("only Library Advanced lists the workspace's configured servers", async () => {
    await agent.run("route.extensions.skills");
    await user.see({ text: "Library" });
    await user.click({ role: "button", label: "MCPs" });
    await user.notSee({ text: "docs-helper" });
    await user.notSee({ text: "files-helper" });
    await user.notSee({ text: "remote-helper" });
    await user.click({ role: "button", label: /^Advanced\b/ });
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
      "With docs-helper written as command: \"python3\", args: [...] beside an array-command server and a remote server, Settings rendered and Advanced listed all three names without exposing them in the primary MCPs inventory.",
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
