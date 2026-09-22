import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { WorkspaceDisplay } from "../src/app/types";
import { t } from "../src/i18n";
import {
  createProviderAuthStore,
  type ProviderAuthStore,
} from "../src/react-app/domains/connections/provider-auth/store";
import { AiSettingsView } from "../src/react-app/domains/settings/pages/ai-view";
import {
  createWorkspaceRoute,
  readCreateWorkspaceRequest,
  withoutCreateWorkspaceRequest,
} from "../src/react-app/shell/workspace-routes";

const stores: ProviderAuthStore[] = [];

/** A member signed in to their organization who has not created a workspace yet. */
function createStoreWithoutEngine(workspace: { root: string; runtimeId: string | null }) {
  const display: WorkspaceDisplay = {
    id: workspace.runtimeId ?? "",
    name: "",
    path: workspace.root,
    preset: "default",
    workspaceType: "local",
  };
  const store = createProviderAuthStore({
    client: () => null,
    providers: () => [],
    providerDefaults: () => ({}),
    providerConnectedIds: () => [],
    disabledProviders: () => [],
    checkDesktopAppRestriction: () => false,
    selectedWorkspaceDisplay: () => display,
    providerBaseUrl: () => "",
    selectedWorkspaceRoot: () => workspace.root,
    runtimeWorkspaceId: () => workspace.runtimeId,
    openworkServer: {
      getSnapshot: () => ({
        openworkServerStatus: "disconnected",
        openworkServerClient: null,
        openworkServerCapabilities: null,
      }),
    },
    setProviders: () => undefined,
    setProviderDefaults: () => undefined,
    setProviderConnectedIds: () => undefined,
    setDisabledProviders: () => undefined,
    markOpencodeConfigReloadRequired: () => undefined,
  });
  stores.push(store);
  return store;
}

function renderView(props: { hasWorkspace?: boolean; onCreateWorkspace?: () => void }) {
  return renderToStaticMarkup(
    <AiSettingsView
      busy={false}
      providerAuthBusy={false}
      providerStatusLabel={t("status.disconnected_label")}
      providerStatusStyle=""
      providerSummary={t("settings.no_providers_connected")}
      providerLoadState={{ status: "idle", error: null }}
      onRetryProviders={() => undefined}
      connectedProviders={[]}
      disconnectingProviderId={null}
      providerConnectError={null}
      providerDisconnectStatus={null}
      providerDisconnectError={null}
      onOpenProviderAuth={() => undefined}
      onDisconnectProvider={() => undefined}
      canDisconnectProvider={() => true}
      canAddProviders={true}
      hasWorkspace={props.hasWorkspace}
      onCreateWorkspace={props.onCreateWorkspace}
    />,
  );
}

afterEach(() => {
  for (const store of stores) store.dispose();
  stores.length = 0;
});

test("connecting a provider without a workspace explains the missing workspace, not a missing server", async () => {
  const store = createStoreWithoutEngine({ root: "", runtimeId: null });
  await expect(store.openProviderAuthModal()).rejects.toThrow(t("providers.workspace_required"));
  expect(store.getSnapshot().providerAuthError).toContain(t("providers.workspace_required"));
  expect(store.getSnapshot().providerAuthError).not.toContain(t("providers.not_connected"));
});

test("a workspace whose engine is unreachable still reports the server connection", async () => {
  const store = createStoreWithoutEngine({ root: "/workspace/team", runtimeId: "ws_team" });
  await expect(store.openProviderAuthModal()).rejects.toThrow(t("providers.not_connected"));
});

test("AI settings without a workspace offers to create one instead of loading forever", () => {
  const html = renderView({ hasWorkspace: false, onCreateWorkspace: () => undefined });
  expect(html).toContain(t("settings.providers_workspace_required_title"));
  expect(html).toContain(t("settings.providers_workspace_required_action"));
  expect(html).not.toContain(t("settings.loading_providers"));
  expect(html).not.toContain(t("settings.connect_provider"));
  expect(html).not.toContain('role="alert"');
});

test("AI settings keeps the loading state while the workspace list is still unknown", () => {
  const html = renderView({ hasWorkspace: undefined });
  expect(html).toContain(t("settings.loading_providers"));
  expect(html).not.toContain(t("settings.providers_workspace_required_title"));
});

test("the create-workspace request round-trips through the session route URL and is removed afterwards", () => {
  const route = createWorkspaceRoute("ai");
  expect(route.startsWith("/session?")).toBe(true);
  const search = route.slice(route.indexOf("?"));
  expect(readCreateWorkspaceRequest(search)).toEqual({ returnTo: "ai" });
  expect(readCreateWorkspaceRequest("?createWorkspace=1&createWorkspaceReturn=../evil")).toEqual({ returnTo: null });
  expect(readCreateWorkspaceRequest("?pendingConversation=abc")).toBeNull();
  expect(withoutCreateWorkspaceRequest("/session", `${search}&pendingConversation=abc`)).toBe("/session?pendingConversation=abc");
  expect(withoutCreateWorkspaceRequest("/session", search)).toBe("/session");
});
