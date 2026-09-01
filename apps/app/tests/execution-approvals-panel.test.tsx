import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { t } from "../src/i18n";
import { ExecutionApprovalsPanel } from "../src/react-app/domains/settings/panels/execution-approvals-panel";
import type { OpenworkServerCapabilities } from "../src/app/lib/openwork-server";

const writableCapabilities: OpenworkServerCapabilities = {
  skills: { read: true, write: true, source: "openwork" },
  plugins: { read: true, write: true },
  mcp: { read: true, write: true },
  commands: { read: true, write: true },
  config: { read: true, write: true },
};

describe("execution approvals panel", () => {
  test("offers the run mode choice with the prompting default selected", () => {
    const markup = renderToStaticMarkup(
      <ExecutionApprovalsPanel
        openworkServerClient={null}
        openworkServerStatus="connected"
        openworkServerCapabilities={writableCapabilities}
        runtimeWorkspaceId="ws_1"
        onConfigUpdated={() => undefined}
      />,
    );

    expect(markup).toContain(t("settings.run_mode.mode"));
    expect(markup).toContain(t("settings.run_mode.approve"));
    expect(markup).toContain(t("settings.run_mode.approve_desc"));
    // The default posture never renders the run-everything risk warning.
    expect(markup).not.toContain(t("settings.run_mode.run_everything_warning"));
  });

  test("explains when the server connection is missing instead of offering a dead control", () => {
    const markup = renderToStaticMarkup(
      <ExecutionApprovalsPanel
        openworkServerClient={null}
        openworkServerStatus="disconnected"
        openworkServerCapabilities={null}
        runtimeWorkspaceId={null}
        onConfigUpdated={() => undefined}
      />,
    );

    expect(markup).toContain(t("context_panel.server_disconnected"));
  });
});
