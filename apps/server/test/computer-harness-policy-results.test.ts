import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { server } from "../src/opencode-plugins/openwork-computer-use.js";

test("desktop policy denial messages reach the model through task, program and script tools", async () => {
  const denial = { ok: false, error: { code: "organization_policy_denied", message: "Your organization's agent permissions block using apps on this computer (set for Everyone)." } };
  const paths: string[] = [];
  const bridge = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      expect(request.headers.get("Authorization")).toBe("Bearer bridge-test-token");
      paths.push(new URL(request.url).pathname);
      return Response.json(denial);
    },
  });
  const directory = await mkdtemp(join(tmpdir(), "computer-policy-results-"));
  const previous = process.env.OPENWORK_UI_CONTROL_DISCOVERY;
  try {
    const discovery = join(directory, "bridge.json");
    await writeFile(discovery, JSON.stringify({ baseUrl: `http://127.0.0.1:${bridge.port}`, token: "bridge-test-token" }));
    process.env.OPENWORK_UI_CONTROL_DISCOVERY = discovery;
    const plugin = await server();
    const caller = { sessionID: "chat" };
    const task = await plugin.tool.computer_open.execute({ app_id: "editor", purpose: "Read the draft" }, caller);
    expect(task).toBe(JSON.stringify(denial));
    const program = await plugin.tool.computer_run.execute({ surface: "computer", code: "return 1" }, caller);
    expect(JSON.parse(program.output)).toEqual(denial);
    expect(program.metadata.isError).toBe(true);
    if (plugin.tool.computer_script) {
      const script = await plugin.tool.computer_script.execute({ app: "jxa", code: "1" }, caller);
      expect(JSON.parse(script.output)).toEqual(denial);
      expect(script.metadata.isError).toBe(true);
      expect(paths).toEqual(["/computer/task", "/computer/program", "/computer/script"]);
    } else expect(paths).toEqual(["/computer/task", "/computer/program"]);
  } finally {
    if (previous === undefined) delete process.env.OPENWORK_UI_CONTROL_DISCOVERY;
    else process.env.OPENWORK_UI_CONTROL_DISCOVERY = previous;
    bridge.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
