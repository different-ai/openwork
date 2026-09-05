import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { t } from "../src/i18n";
import { EffectivePermissionsPanel } from "../src/react-app/domains/settings/panels/effective-permissions-panel";
import type { OpenworkServerCapabilities } from "../src/app/lib/openwork-server";

const readableCapabilities: OpenworkServerCapabilities = {
  skills: { read: true, write: true, source: "openwork" },
  plugins: { read: true, write: true },
  mcp: { read: true, write: true },
  commands: { read: true, write: true },
  config: { read: true, write: true },
};

describe("effective permissions panel", () => {
  test("names the section and explains that the engine is the source of truth", () => {
    const markup = renderToStaticMarkup(
      <EffectivePermissionsPanel
        openworkServerClient={null}
        openworkServerStatus="connected"
        openworkServerCapabilities={readableCapabilities}
        runtimeWorkspaceId="ws_1"
      />,
    );
    expect(markup).toContain(t("context_panel.effective_permissions"));
    expect(markup).toContain(t("context_panel.effective_permissions_desc"));
    // Nothing is claimed before the engine has answered: no row and no
    // decision badge is rendered from assumptions.
    expect(markup).not.toContain(t("context_panel.permission_action_allow"));
    expect(markup).not.toContain(t("context_panel.permission_action_ask"));
  });

  test("explains what is missing instead of showing an empty list", () => {
    const markup = renderToStaticMarkup(
      <EffectivePermissionsPanel
        openworkServerClient={null}
        openworkServerStatus="disconnected"
        openworkServerCapabilities={null}
        runtimeWorkspaceId={null}
      />,
    );
    expect(markup).toContain(t("context_panel.effective_permissions_unavailable"));
  });
});
