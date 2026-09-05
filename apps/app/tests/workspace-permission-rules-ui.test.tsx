import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { t } from "../src/i18n";
import type { PendingPermission } from "../src/app/types";
import type { OpenworkServerCapabilities } from "../src/app/lib/openwork-server";
import { PermissionApprovalPanel } from "../src/react-app/domains/session/chat/permission-approval-modal";
import { WorkspacePermissionRulesPanel } from "../src/react-app/domains/settings/panels/workspace-permission-rules-panel";

const pending: PendingPermission = {
  id: "perm_1",
  sessionID: "ses_1",
  permission: "bash",
  patterns: ["git status --porcelain"],
  always: ["git status *"],
  metadata: { command: "git status --porcelain" },
  tool: { messageID: "msg_1", callID: "call_1" },
  receivedAt: Date.now(),
  protocol: "legacy",
};

const writable: OpenworkServerCapabilities = {
  skills: { read: true, write: true, source: "openwork" },
  plugins: { read: true, write: true },
  mcp: { read: true, write: true },
  commands: { read: true, write: true },
  config: { read: true, write: true },
};

describe("always allow in this workspace", () => {
  test("the approval panel offers the workspace-wide option beside the session one, and disables it when the file cannot be edited", () => {
    const enabled = renderToStaticMarkup(
      <PermissionApprovalPanel permission={pending} busy={false} respondPermission={() => undefined} canAllowInWorkspace safeStringify={(value) => JSON.stringify(value)} />,
    );
    expect(enabled).toContain(t("session.allow_for_session"));
    expect(enabled).toContain(t("session.allow_in_workspace"));
    // Static markup escapes apostrophes; assert on an unambiguous fragment of the hint.
    expect(enabled).toContain("where you can see and remove it");
    // A leading space keeps Base UI's data-disabled attribute out of the count.
    const disabledCount = (markup: string) => (markup.match(/ disabled=""/g) ?? []).length;

    const disabled = renderToStaticMarkup(
      <PermissionApprovalPanel permission={pending} busy={false} respondPermission={() => undefined} canAllowInWorkspace={false} safeStringify={(value) => JSON.stringify(value)} />,
    );
    // Only the workspace-wide button is disabled when the file cannot be edited; the session reply stays available.
    expect(disabledCount(disabled)).toBe(disabledCount(enabled) + 1);
    expect(disabled).toContain(t("session.allow_for_session"));
  });

  test("the settings list explains itself and never invents rules before the server answered", () => {
    const markup = renderToStaticMarkup(
      <WorkspacePermissionRulesPanel
        openworkServerClient={null}
        openworkServerStatus="connected"
        openworkServerCapabilities={writable}
        runtimeWorkspaceId="ws_1"
        onRulesChanged={() => undefined}
      />,
    );
    expect(markup).toContain(t("context_panel.workspace_rules"));
    expect(markup).toContain("appear here and can be removed");
    expect(markup).not.toContain("has no permission rules");

    const unavailable = renderToStaticMarkup(
      <WorkspacePermissionRulesPanel
        openworkServerClient={null}
        openworkServerStatus="disconnected"
        openworkServerCapabilities={null}
        runtimeWorkspaceId={null}
        onRulesChanged={() => undefined}
      />,
    );
    expect(unavailable).toContain("Connect to an OpenWork server workspace to see this workspace");
  });
});
