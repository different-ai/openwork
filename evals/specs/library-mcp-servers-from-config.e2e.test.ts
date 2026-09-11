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

  await step("the MCPs category lists the workspace's servers as local items under their live status", async () => {
    await agent.run("route.extensions.skills");
    await user.see({ text: "Library" });
    await user.click({ role: "button", label: "MCPs" });
    // All three are written with enabled: false, so they wait under Disabled
    // rather than claiming to be ready.
    await user.notSee({ text: "docs-helper" });
    await user.click({ role: "tab", label: /^Disabled\b/ });
    await user.see({ text: "docs-helper" });
    await user.see({ text: "files-helper" });
    await user.see({ text: "remote-helper" });
    await user.see({ text: "Local · this workspace" });
    // Advanced still owns creation only; the inventory does not live there.
    await user.click({ role: "button", label: /^Advanced\b/ });
    await user.see({ role: "button", label: "Add workspace MCP" });
    expect((await probe.dom('button[aria-expanded="true"]')).elements.filter((element) => /^Advanced\b/.test(element.text))).toHaveLength(1);
    await user.click({ role: "button", label: /^Advanced\b/ });
    await user.screenshot();
  });

  await step("Settings stayed a working page rather than a blank document", async () => {
    const body = await probe.text();
    expect(body).toContain("docs-helper");
    expect(body).toContain("files-helper");
    expect(body.length).toBeGreaterThan(200);
    evidence.recordAssertionEvidence(
      "A Claude-style string command no longer blanks Settings",
      "With docs-helper written as command: \"python3\", args: [...] beside an array-command server and a remote server, Settings rendered and the MCPs category listed all three as local items under Disabled while Advanced kept only workspace MCP creation.",
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
