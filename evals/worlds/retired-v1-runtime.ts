import { randomUUID } from "node:crypto";
import type { Seed } from "@openwork/env";

export const retiredV1SessionTitle = "A new session on the v2-only runtime";

interface EngineStatus {
  enabled: boolean;
  chatRouting: boolean;
  running: boolean;
  version?: string;
  pid?: number;
  lastError?: string;
}

export async function retiredV1Runtime(seed: Seed) {
  const token = randomUUID();
  const hostToken = randomUUID();
  const unavailableV1Binary = seed.tmpPath("retired-v1-binary-is-absent");
  const app = await seed.appWeb({
    name: "retired-v1-runtime",
    workspacePath: seed.tmpPath("retired-v1-workspace"),
    engine: "v2",
    env: {
      OPENWORK_TOKEN: token,
      OPENWORK_HOST_TOKEN: hostToken,
      OPENWORK_ENGINE_V2_ONLY: "1",
      OPENWORK_ENGINE_FORCE_POLICY: "1",
      OPENWORK_ENGINE_AUTO_UPGRADE: "0",
      OPENWORK_OPENCODE_BIN: unavailableV1Binary,
    },
  });
  await seed.workspace(app, app.workspaceRoot);
  const session = await seed.session(app, { title: retiredV1SessionTitle });

  function request(path: string, init: RequestInit = {}) {
    return fetch(`${app.openworkUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "x-openwork-host-token": hostToken,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
  }

  return {
    app,
    session,
    unavailableV1Binary,
    async status(): Promise<EngineStatus> {
      const response = await request("/experimental/engine-v2-preview/status");
      if (!response.ok) throw new Error(`Engine status: ${response.status} ${await response.text()}`);
      return response.json();
    },
    // Both actions use shipping host/client APIs; no browser state setters.
    async turnForcePolicyOff() {
      const response = await request("/experimental/engine-v2-preview/force", {
        method: "POST",
        body: JSON.stringify({ upgrade: false }),
      });
      const body: unknown = await response.json();
      return { status: response.status, body };
    },
    async requestV1Selection(disableEngine = false) {
      const response = await request("/experimental/engine-v2-preview", {
        method: "PUT",
        body: JSON.stringify(disableEngine ? { enabled: false } : { chatRouting: false }),
      });
      const body: unknown = await response.json();
      return { status: response.status, body };
    },
  };
}
