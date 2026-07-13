import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApprovalService } from "../approvals.js";
import { EnvService } from "../env-file.js";
import type { ExtensionActionService } from "../extensions/action-contract.js";
import { createRoutes } from "../server.js";
import { TokenService } from "../tokens.js";
import type { ServerConfig } from "../types.js";
import { describeRoutes } from "./registry.js";

const LEGACY_ROUTE_INVENTORY = `GET /health none
GET /w/:id/health none
POST /dev/log none
GET /dev/log none
GET /ui none
GET /w/:id/ui none
GET /ui/assets/toy.css none
GET /ui/assets/toy.js none
GET /ui/assets/openwork-mark.svg none
GET /w/:id/status client
GET /w/:id/capabilities client
GET /w/:id/workspaces client
GET /status client
GET /runtime/versions client
POST /runtime/upgrade host
GET /w/:id/runtime/versions client
POST /w/:id/runtime/upgrade host
GET /whoami client
GET /capabilities client
GET /experimental/connect/state client
PUT /experimental/connect/state host
GET /experimental/extensions/actions client
POST /experimental/extensions/call client
GET /experimental/google-workspace/status client
POST /experimental/google-workspace/connect/start client
GET /experimental/google-workspace/connect/status/:flowId client
POST /experimental/google-workspace/disconnect client
POST /experimental/google-workspace/active-account client
POST /experimental/google-workspace/test client
POST /experimental/google-workspace/smoke-test client
GET /workspaces client
GET /tokens host
POST /tokens host
DELETE /tokens/:id host
GET /env host-token
GET /env/keys host-token
GET /env/status host-token
PUT /env/status host-token
GET /env/:key host-token
PUT /env host-token
DELETE /env/:key host-token
POST /voice/realtime/session host
POST /workspaces/local host
POST /workspaces/remote host
PATCH /workspaces/:id/display-name host
POST /workspaces/:id/activate host
DELETE /workspaces/:id host
GET /workspace/:id/sessions client
GET /workspace/:id/session-groups client
PUT /workspace/:id/session-groups client
POST /workspace/:id/session-groups client
PATCH /workspace/:id/session-groups/reorder client
PATCH /workspace/:id/session-groups/assignments/:sessionId client
PATCH /workspace/:id/session-groups/:groupId client
DELETE /workspace/:id/session-groups/:groupId client
GET /workspace/:id/session-groups/events client
GET /workspace/:id/sessions/:sessionId client
GET /workspace/:id/sessions/:sessionId/messages client
GET /workspace/:id/sessions/:sessionId/snapshot client
DELETE /workspace/:id/sessions/:sessionId client
GET /workspace/:id/config client
GET /workspace/:id/desktop-cloud-sync client
POST /workspace/:id/desktop-cloud-sync client
GET /workspace/:id/cloud-plugins client
POST /workspace/:id/cloud-plugins client
POST /workspace/:id/claude-plugins client
DELETE /workspace/:id/cloud-plugins/:pluginId client
GET /workspace/:id/authorized-folders client
PUT /workspace/:id/authorized-folders client
POST /workspace/:id/runtime-config/migrate client
GET /workspace/:id/runtime-config client
GET /workspace/:id/opencode-config client
POST /workspace/:id/opencode-config client
GET /workspace/:id/audit client
PATCH /workspace/:id/config client
GET /workspace/:id/events client
POST /workspace/:id/engine/reload client
GET /approvals host
POST /approvals/:id host
GET /workspace/:id/inbox client
GET /workspace/:id/inbox/:inboxId client
POST /workspace/:id/inbox client
GET /workspace/:id/artifacts client
GET /workspace/:id/artifacts/:artifactId client
POST /workspace/:id/artifacts/resolve client
POST /workspace/:id/files/sessions client
POST /files/sessions/:sessionId/renew client
DELETE /files/sessions/:sessionId client
GET /files/sessions/:sessionId/catalog/snapshot client
GET /files/sessions/:sessionId/catalog/events client
POST /files/sessions/:sessionId/read-batch client
POST /files/sessions/:sessionId/write-batch client
POST /files/sessions/:sessionId/ops client
GET /workspace/:id/files/content client
GET /workspace/:id/files/stat client
GET /workspace/:id/files/raw client
POST /workspace/:id/files/raw client
POST /workspace/:id/files/content client
GET /workspace/:id/plugins client
POST /workspace/:id/plugins client
DELETE /workspace/:id/plugins/:name client
GET /hub/skills client
GET /workspace/:id/skills client
POST /workspace/:id/skills/hub/:name client
GET /workspace/:id/skills/:name client
POST /workspace/:id/skills client
DELETE /workspace/:id/skills/:name client
GET /workspace/:id/mcp client
POST /workspace/:id/extensions/export client
POST /workspace/:id/mcp client
DELETE /workspace/:id/mcp/:name client
POST /workspace/:id/mcp/:name/enabled client
DELETE /workspace/:id/mcp/:name/auth client
GET /workspace/:id/commands client
POST /workspace/:id/commands client
DELETE /workspace/:id/commands/:name client
GET /workspace/:id/export client
POST /workspace/:id/import/preview client
POST /workspace/:id/import client
POST /workspace/:id/blueprint/sessions/materialize client`;

function testConfig(): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "client-token",
    hostToken: "host-token",
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: [],
    workspaces: [],
    authorizedRoots: [],
    readOnly: false,
    startedAt: 0,
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "json",
    logRequests: false,
  };
}

test("preserves the complete legacy method/path/auth route inventory", () => {
  const config = testConfig();
  const extensionActions: ExtensionActionService = {
    list: () => [],
    call: async () => ({}),
  };
  const routes = createRoutes(
    config,
    new ApprovalService(config.approval),
    new TokenService(config),
    new EnvService({ path: join(tmpdir(), "openwork-route-inventory-env.json") }),
    extensionActions,
    () => undefined,
  );
  const inventory = describeRoutes(routes)
    .map((route) => `${route.method} ${route.path} ${route.auth}`);
  const methodAndPath = inventory.map((route) => route.split(" ").slice(0, 2).join(" "));

  expect(inventory.join("\n")).toBe(LEGACY_ROUTE_INVENTORY);
  expect(inventory).toHaveLength(120);
  expect(new Set(methodAndPath).size).toBe(methodAndPath.length);
});
