import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startEmbeddedServer, type EmbeddedServerHandle } from "./embedded.js";

const roots: string[] = [];
const handles: EmbeddedServerHandle[] = [];

afterEach(async () => {
  while (handles.length) await handles.pop()?.stop();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("embedded observability connection", () => {
  test("injects the actual bound OpenWork URL when port zero is requested", async () => {
    const root = await mkdtemp(join(tmpdir(), "openwork-embedded-observability-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const capture = join(root, "server-url.txt");
    const executable = join(root, "fake-opencode.sh");
    await writeFile(executable, `#!/bin/sh
printf '%s' "$OPENWORK_SERVER_URL" > "$OBSERVABILITY_URL_CAPTURE"
printf 'opencode server listening on http://127.0.0.1:45679\\n'
sleep 30
`, "utf8");
    await chmod(executable, 0o755);

    const previousCapture = process.env.OBSERVABILITY_URL_CAPTURE;
    process.env.OBSERVABILITY_URL_CAPTURE = capture;
    try {
      const handle = await startEmbeddedServer({
        host: "127.0.0.1",
        port: 0,
        token: "owt_client",
        hostToken: "owt_host",
        workspaces: [workspace],
        manageOpencode: true,
        opencodeBin: executable,
        opencodeCwd: workspace,
        logRequests: false,
        observability: {
          enabled: true,
          level: "debug",
          scopes: ["lifecycle", "config", "process"],
          content: "metadata",
        },
      });
      handles.push(handle);
      expect(handle.port).toBeGreaterThan(0);
      expect(await readFile(capture, "utf8")).toBe(handle.url);

      const tokenResponse = await fetch(`${handle.url}/tokens`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-OpenWork-Host-Token": "owt_host",
        },
        body: JSON.stringify({ scope: "owner", label: "observability test" }),
      });
      const owner = await tokenResponse.json() as { token: string };
      const eventsResponse = await fetch(`${handle.url}/observability/events?limit=250`, {
        headers: { Authorization: `Bearer ${owner.token}` },
      });
      const payload = await eventsResponse.json() as {
        events: Array<{ action: string }>;
      };
      const actions = payload.events.map((event) => event.action);
      expect(actions).toContain("server.listening");
      expect(actions).toContain("runtime-config.written");
      expect(actions).toContain("opencode.process.spawned");
      expect(actions).toContain("opencode.process.listening");
    } finally {
      if (previousCapture === undefined) delete process.env.OBSERVABILITY_URL_CAPTURE;
      else process.env.OBSERVABILITY_URL_CAPTURE = previousCapture;
    }
  });
});
