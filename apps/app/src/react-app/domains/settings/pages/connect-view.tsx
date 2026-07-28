/** @jsxImportSource react */
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

import type { DenExternalMcpConnection, DenOrgPlugin } from "@/app/lib/den";
import type { DenAuthStatus } from "@/react-app/domains/cloud/den-auth-provider";
import {
  formatPluginConnectRowMeta,
  isConnectAdminRole,
  resolveConnectRowGroup,
  resolveConnectionRowGroup,
  type ConnectRowGroup,
} from "@/react-app/domains/settings/connect-cloud-readiness";
import type { ExtensionItem } from "@/react-app/domains/settings/extension-items";
import { t } from "@/i18n";

export { readyCloudMcpToolIds } from "@/react-app/domains/settings/cloud/agent-access-card";

export type ConnectViewState = "loading" | "signin" | "active" | "pitch";

export function resolveConnectViewState(input: {
  authStatus: DenAuthStatus;
  connectEnabled?: boolean;
  connectionsCount: number;
  activeOrgSelected?: boolean;
}): ConnectViewState {
  if (input.authStatus === "checking") return "loading";
  if (input.authStatus === "signed_out") return "signin";
  if (input.connectEnabled === true || input.connectionsCount > 0 || (input.authStatus === "signed_in" && input.activeOrgSelected === true)) return "active";
  return "pitch";
}

type CloudMarketplaceItem = ExtensionItem & { plugin: DenOrgPlugin };

export function isCloudMarketplaceItem(item: ExtensionItem): item is CloudMarketplaceItem {
  return item.source === "marketplace" && Boolean(item.plugin);
}

type ConnectOrganizationRow =
  | {
      kind: "connection";
      id: string;
      group: Exclude<ConnectRowGroup, "excluded">;
      name: string;
      description: string;
      meta: string;
      canManage: boolean;
      connection: DenExternalMcpConnection;
    }
  | {
      kind: "plugin";
      id: string;
      group: Exclude<ConnectRowGroup, "excluded">;
      name: string;
      description: string;
      meta: string;
      importedLocally: boolean;
      plugin: DenOrgPlugin;
    };

export function buildConnectRows(input: {
  connections: DenExternalMcpConnection[];
  items: ExtensionItem[];
  role: "owner" | "admin" | "member" | null | undefined;
}) {
  const marketplaceItems = input.items.filter(isCloudMarketplaceItem);
  const pluginConnectionIds = new Set(
    marketplaceItems.flatMap((item) => item.plugin.cloudReadiness?.connections.flatMap((connection) => connection.id ? [connection.id] : []) ?? []),
  );
  const connectionRows: ConnectOrganizationRow[] = input.connections.filter((connection) => !pluginConnectionIds.has(connection.id)).map((connection) => ({
    kind: "connection",
    id: connection.id,
    group: resolveConnectionRowGroup(connection),
    name: connection.name,
    description: connection.url,
    meta: connection.credentialMode === "shared" ? t("connect.row_meta_managed_by_org") : t("connect.row_meta_your_account"),
    canManage: isConnectAdminRole(input.role),
    connection,
  }));

  const pluginRows: ConnectOrganizationRow[] = marketplaceItems.flatMap((item) => {
    const group = resolveConnectRowGroup(item.plugin.cloudReadiness, input.role, item.plugin.componentCounts);
    if (group === "excluded") return [];
    return [{
      kind: "plugin",
      id: item.plugin.id,
      group,
      name: item.plugin.name,
      description: item.plugin.description ?? "",
      meta: formatPluginConnectRowMeta(item.plugin),
      importedLocally: Boolean(item.importedPlugin),
      plugin: item.plugin,
    }];
  });

  return [...connectionRows, ...pluginRows];
}

/** Legacy Connect tab — redirects into the unified Extensions inventory. */
export function ConnectView() {
  const navigate = useNavigate();
  useEffect(() => {
    navigate("/settings/extensions", { replace: true });
  }, [navigate]);
  return null;
}
