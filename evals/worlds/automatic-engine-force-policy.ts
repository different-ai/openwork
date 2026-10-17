import { randomUUID } from "node:crypto";
import type { Seed } from "@openwork/env";

export const retainedHistoryText = "Keep this project note readable when the organization changes its engine policy.";

interface EngineStatus {
  engineOrigin: string;
  engineForced: boolean;
  chatRouting: boolean;
  running: boolean;
  version?: string;
  migration: { state: string; imported: number; total: number; backupPath?: string };
}

export async function automaticEngineForcePolicy(seed: Seed) {
  const token = randomUUID();
  const hostToken = randomUUID();
  const app = await seed.appWeb({
    name: "automatic-engine-force-policy",
    workspacePath: seed.tmpPath("automatic-engine-force-policy"),
    engine: "v1",
    env: {
      OPENWORK_TOKEN: token,
      OPENWORK_HOST_TOKEN: hostToken,
      OPENWORK_ENGINE_V2_PREVIEW: "",
      OPENWORK_ENGINE_FORCE_POLICY: "1",
      OPENWORK_ENGINE_AUTO_UPGRADE: "0",
      OPENWORK_FRESH_INSTALL_ENGINE: "v1",
    },
  });
  const workspace = await seed.workspace(app, app.workspaceRoot);
  const session = await seed.session(app, { title: "A project note that survives engine policy changes" });
  async function request(path: string, init: RequestInit = {}) {
    const response = await fetch(`${app.openworkUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "x-openwork-host-token": hostToken,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`);
    return response;
  }
  const sessionPath = `/workspace/${workspace.workspaceId}/opencode/session/${session.sessionId}`;
  // The real v1 prompt API supports noReply: arrange persisted user history
  // without a provider call or a mock engine, before the person's first act.
  await request(`${sessionPath}/message`, {
    method: "POST",
    body: JSON.stringify({ noReply: true, parts: [{ type: "text", text: retainedHistoryText }] }),
  });
  return {
    app,
    session,
    async status(): Promise<EngineStatus> {
      const response = await request("/experimental/engine-v2-preview/status");
      return response.json();
    },
    async messages(): Promise<string> {
      const response = await request(`${sessionPath}/message`);
      return response.text();
    },
    // These are the shipping host/client APIs, not browser state setters.
    async setOrganizationPolicy(upgrade: boolean): Promise<void> {
      await request("/experimental/engine-v2-preview/force", { method: "POST", body: JSON.stringify({ upgrade }) });
    },
    async chooseV2Manually(): Promise<void> {
      await request("/experimental/engine-v2-preview", { method: "PUT", body: JSON.stringify({ enabled: true, chatRouting: true }) });
    },
  };
}
