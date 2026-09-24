/** @jsxImportSource react */
import { useEffect, useId, useMemo, useReducer, useRef, useState, type ReactNode, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "@/components/ui/sonner";
import {
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  Code2,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  Info,
  Laptop,
  LayoutGrid,
  List,
  Loader2,
  Lock,
  Plug,
  Plus,
  Power,
  Settings2,
  TriangleAlert,
} from "lucide-react";

import { desktopRestrictionNotice } from "../../../../app/cloud/desktop-app-restrictions";
import { isBuiltInOpenWorkExtension, getMcpServerName, type McpDirectoryInfo } from "../../../../app/constants";
import { evaluateEnablement } from "../../../../app/enablement";
import type { EnablementResult } from "../../../../app/extensions";
import type { CloudImportedPlugin, CloudImportedPluginFile } from "../../../../app/cloud/import-state";
import { ExtensionCard, type ExtensionLayout } from "../../../design-system/extension-card";
import { ExtensionDetailModal } from "../../../design-system/extension-detail-modal";
import { resolveExtensionIconUrl } from "../../../design-system/extension-icon-src";
import {
  isOrgMcpConnectionReady,
  isOrgMcpConnectionItem,
  orgMcpConnectionActionLabel,
  resolveExtensionInventoryGroup,
  type ExtensionInventoryGroup,
  type ExtensionItem,
} from "../extension-items";
import {
  extensionFilterLabel,
  extensionInventoryFilters,
  extensionTaxonomyLabel,
  isLibraryMcpDirectoryEntry,
  matchesExtensionFilter,
  primaryLibraryFilter,
  taxonomyForDirectoryEntry,
  type ExtensionInventoryFilter,
  type ExtensionInventoryState,
  type ExtensionTaxonomy,
} from "../extension-taxonomy";
import { RefreshButton } from "../settings-section";
import { SettingsListSearchInput } from "../settings-list";
import {
  openDesktopUrl,
  openDesktopPath,
  readOpencodeConfig,
  revealDesktopItemInDir,
  type OpencodeConfigFile,
} from "../../../../app/lib/desktop";
import { readDenSettings, type DenExternalMcpPreset } from "../../../../app/lib/den";
import type { DenLibraryConnectionItem, DenLibraryPluginItem } from "../../../../app/lib/den-library";
import {
  getMcpIdentityKey,
  normalizeMcpSlug,
} from "../../../../app/mcp";
import type { McpServerEntry, McpStatusMap } from "../../../../app/types";
import { isDesktopRuntime, isWindowsPlatform } from "../../../../app/utils";
import { t } from "../../../../i18n";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmModal } from "../../../design-system/modals/confirm-modal";
import { isConnectDirectMcpServerName } from "../../connections/cloud-mcp-user-state";
import { AddMcpModal } from "../../connections/modals/add-mcp-modal";
import type { McpConnectResult } from "../../connections/store";
import { ClaudePluginImportModal } from "../../connections/modals/claude-plugin-import-modal";
import {
  canDisconnectMemberConnection,
  canMemberAuthorizeConnection,
} from "../../connections/native-provider-connections";
import type { OpenworkClaudePluginPreview } from "../../../../app/lib/openwork-server";
import {
  isOpenWorkExtensionEnabled,
  isOpenWorkExtensionHidden,
  OPENWORK_EXTENSION_STATE_CHANGED,
  readExtensionLayout,
  setOpenWorkExtensionEnabled,
  setOpenWorkExtensionHidden,
  writeExtensionLayout,
} from "../extension-state";
import {
  initialMcpViewLocalState,
  mcpViewLocalReducer,
  type ConfigScope,
  type McpViewLocalState,
} from "./mcp-view-state";
import { useCloudSession } from "../cloud/cloud-session-provider";
import { isConnectAdminRole } from "../connect-cloud-readiness";
import { useDenAuth } from "../../cloud/den-auth-provider";
import {
  libraryAddAction,
  libraryAddKindsForFilter,
  libraryAgentDetailId,
  libraryCommandDetailId,
  libraryCommandTriggers,
  libraryPluginFileDisplayName,
  libraryPluginFileFallbackDetailId,
  libraryPluginFileKind,
  libraryPluginFilePreferredDetailId,
  parseLibraryAgentDetailId,
  parseLibraryCommandDetailId,
  parseLibraryPluginFileDetailId,
  type CreateLibraryItemInput,
  type LibraryAddKind,
  type LibraryAgentItem,
  type LibraryAuthorableKind,
  type LibraryCommandItem,
} from "../library";
import {
  emptyLibraryAudience,
  isLibraryAudienceShared,
  libraryAudienceName,
  libraryAudiencePeopleCount,
  libraryCloudItemTaxonomy,
  libraryConnectionAudience,
  libraryOwnedCaption,
  librarySharedByCaption,
  type LibraryAudience,
  type LibrarySection,
} from "../library-sharing";
import { seededConnectorDraft } from "../../session/surface/composer/connector-token";
import { useStartSeededChat } from "../../../shell/use-start-seeded-chat";
import { libraryConnectorCues } from "../library-connector-cues";
import { useLibraryCloud, type LibraryEditableSkill, type LibraryShareTarget } from "../use-library-cloud";
import { AddLibraryItemPage } from "./add-library-item-page";
import { LibraryAddControl } from "./library-add-control";
import {
  connectorSummary,
  LibraryConnectorCatalogPage,
  LibraryConnectorSetupPage,
  type LibraryConnectorSetupInput,
} from "./library-connector-pages";
import { LibraryDeleteDialog } from "./library-delete-dialog";
import { LibraryEditSkillPage, type LibrarySkillDraft } from "./library-edit-skill-page";
import { LibraryRowMenu, type LibraryRowMenuAction } from "./library-row-menu";
import { LibraryModelPage } from "./library-model-page";
import {
  libraryModelDetailId,
  libraryModelSignInKey,
  type LibraryModelProvider,
  modelNamesSummary,
  parseLibraryModelDetailId,
} from "../library-models";
import type { GatewayConnectProvider } from "@/react-app/domains/connections/provider-auth/cloud-provider-config";
import { kindLabel, LibrarySharePage, targetsFor } from "./library-share-page";
import {
  openInDenLibraryUrl,
  shouldShowOpenInDenAction,
  type DenLibraryTarget,
} from "../open-in-den";

export type ReactMcpStatus =
  | "connected"
  | "needs_auth"
  | "reconnect_required"
  | "needs_client_registration"
  | "failed"
  | "disabled"
  | "disconnected";

export type SkillItem = {
  name: string;
  description?: string;
  trigger?: string;
  path: string;
  content?: string;
  origin?: "local" | "openwork-connect";
  marketplaceName?: string;
  pluginName?: string;
};

const getSkillHiddenId = (skill: SkillItem) => `skill:${skill.name}`;

export type McpViewProps = {
  busy: boolean;
  selectedWorkspaceRoot: string;
  isRemoteWorkspace: boolean;
  /** Installed skills to render alongside MCPs in the grid. */
  installedSkills?: SkillItem[];
  /** Composer slash commands to render in Library. */
  installedCommands?: LibraryCommandItem[];
  /** Composer agents to render in Library. */
  installedAgents?: LibraryAgentItem[];
  /** MCP capabilities assigned through OpenWork Connect. */
  availableConnectMcpServers?: McpServerEntry[];
  availableConnectMcpStatuses?: McpStatusMap;
  /** Organization inventory is still being fetched and nothing is cached yet. */
  inventoryLoading?: boolean;
  inventoryError?: string | null;
  /** Installed organization extensions to render alongside runtime extensions. */
  installedPlugins?: CloudImportedPlugin[];
  /** Uninstall a skill by name. */
  uninstallSkill?: (name: string) => void;
  /** Remove an imported marketplace package by plugin id. */
  removeCloudPlugin?: (pluginId: string) => void | Promise<unknown>;
  /** Read skill content by name. */
  readSkill?: (name: string) => Promise<{ content: string } | null>;
  readConfigFile?: (scope: "project" | "global") => Promise<OpencodeConfigFile | null>;
  mcpServers: McpServerEntry[];
  mcpStatus: string | null;
  mcpLastUpdatedAt: number | null;
  mcpStatuses: McpStatusMap;
  mcpConnectingName: string | null;
  /** False when secure storage for OpenWork-managed sign-ins is unavailable on this device. */
  managedOAuthAvailable?: boolean;
  /** Organization policy permission for local extension configuration. */
  allowManageExtensions: boolean;
  quickConnect: McpDirectoryInfo[];
  connectMcp: (entry: McpDirectoryInfo) => Promise<McpConnectResult>;
  authorizeMcp: (entry: McpServerEntry) => void;
  logoutMcpAuth: (name: string) => Promise<void> | void;
  removeMcp: (name: string) => void;
  setMcpEnabled?: (name: string, enabled: boolean) => Promise<void> | void;
  /** Return extension-specific config UI for the detail modal. */
  configSlotForEntry?: (entry: McpDirectoryInfo) => React.ReactNode | null;
  /** Check if an extension-kind entry is connected/active. */
  isExtensionConnected?: (entry: McpDirectoryInfo) => boolean;
  /** Enablement context for evaluating extension active state. */
  enablementContext?: import("../../../../app/enablement").EnablementContext;
  /** Organization policy restriction for OpenWork-provided built-in extensions. */
  builtInExtensionsDisabled?: boolean;
  /** Preview a Claude Code plugin bundle from a GitHub URL ("Will install" disclosure). */
  previewClaudePlugin?: (url: string) => Promise<OpenworkClaudePluginPreview>;
  /** Install a Claude Code plugin bundle from a GitHub URL. */
  installClaudePlugin?: (url: string) => Promise<{ ok: boolean; message: string }>;
  /** Connected org-level External MCP Connections rendered in My Extensions. */
  orgMcpItems?: ExtensionItem[];
  /**
   * The signed-in member's own active organization (`cloudSession.activeOrgName`),
   * shown only to that member so provenance and sign-in captions can say whose
   * organization shared an item. It is never an outside party's identity.
   */
  organizationName?: string | null;
  orgMcpError?: string | null;
  orgMcpConnectingId?: string | null;
  connectOrgMcp?: (connectionId: string) => void;
  reconnectOrgMcp?: (connectionId: string) => void;
  orgMcpDisconnectingId?: string | null;
  disconnectOrgMcp?: (connectionId: string) => void;
  initialFilter?: ExtensionInventoryFilter;
  onFilterChange?: (filter: ExtensionInventoryFilter) => void;
  initialState?: ExtensionInventoryState;
  onStateChange?: (state: ExtensionInventoryState, filter: ExtensionInventoryFilter) => void;
  /** Stable extension detail id from `/extensions/:id`. */
  detailId?: string | null;
  /** Navigate when detail opens/closes. When set, detail renders as a page. */
  onDetailIdChange?: (id: string | null) => void;
  /** Create a workspace skill, command, or agent from Library. */
  createLibraryItem?: (
    kind: LibraryAuthorableKind,
    input: CreateLibraryItemInput,
  ) => Promise<string>;
  /** Reload composer command and agent lists after a Library create. */
  onLibraryListsRefresh?: () => Promise<void> | void;
  onRefresh?: () => void;
  headerActionsTarget?: HTMLDivElement | null;
  /** OpenCode plugin management, shown under the Plugins category. */
  pluginsContent?: ReactNode;
  onOpenCloudAccount?: () => void;
  /** Model providers this person can use, for the Models filter. */
  modelProviders?: LibraryModelProvider[];
  /** The credential set whose sign-in is in progress, keyed like the sign-in engine. */
  modelSignInKey?: string | null;
  onModelSignIn?: (provider: GatewayConnectProvider) => void;
  onCancelModelSignIn?: () => void;
  onRemoveModelProvider?: (providerId: string) => void;
  /** Open the add-a-provider (API key) flow. */
  onAddModelProvider?: () => void;
};

const builtInExtensionDisabledReason = () => t("extensions.disabled_by_organization");
const manageExtensionsDisabledReason = () => desktopRestrictionNotice("allowManageExtensions");

const friendlyStatus = (status: ReactMcpStatus) => {
  switch (status) {
    case "connected":
      return t("mcp.friendly_status_ready");
    case "needs_auth":
    case "needs_client_registration":
      return t("mcp.friendly_status_needs_signin");
    case "reconnect_required":
      return t("mcp.friendly_status_reconnect_required");
    case "disabled":
      return t("mcp.friendly_status_paused");
    case "disconnected":
      return t("mcp.friendly_status_offline");
    default:
      return t("mcp.friendly_status_issue");
  }
};

function extensionResourceLabels(entry: McpDirectoryInfo) {
  return entry.extensionManifest?.resources.map((resource) => resource.label ?? resource.id) ?? [];
}

function extensionContributionLabels(entry: McpDirectoryInfo) {
  return entry.extensionManifest?.contributions?.map((contribution) => contribution.label ?? contribution.ref ?? contribution.type) ?? [];
}

function isToggleOnlyExtension(entry: McpDirectoryInfo) {
  if (entry.kind !== "extension") return false;
  return entry.extensionManifest?.contributions?.some((contribution) =>
    contribution.type === "session-side-panel" || contribution.type === "session-rail-item"
  ) === true;
}

type ExtensionDetailTarget =
  | { kind: "entry"; entry: McpDirectoryInfo }
  | { kind: "skill"; skill: SkillItem }
  | { kind: "command"; command: LibraryCommandItem }
  | { kind: "agent"; agent: LibraryAgentItem }
  | { kind: "connect-mcp"; entry: McpServerEntry }
  | { kind: "server"; entry: McpServerEntry }
  | { kind: "plugin"; plugin: CloudImportedPlugin }
  | { kind: "plugin-file"; plugin: CloudImportedPlugin; file: CloudImportedPluginFile }
  | { kind: "org-mcp"; item: ExtensionItem };

function extensionDetailIdForTarget(target: ExtensionDetailTarget): string {
  switch (target.kind) {
    case "entry":
      return getMcpIdentityKey(target.entry);
    case "skill":
      return `skill:${target.skill.name}`;
    case "command":
      return libraryCommandDetailId(target.command);
    case "agent":
      return libraryAgentDetailId(target.agent);
    case "connect-mcp":
      return `connect-mcp:${target.entry.name}`;
    case "server":
      return `server:${target.entry.name}`;
    case "plugin":
      return `plugin:${target.plugin.pluginId}`;
    case "plugin-file":
      return libraryPluginFileFallbackDetailId(target.plugin.pluginId, target.file);
    case "org-mcp":
      return target.item.id.startsWith("org-mcp:")
        ? target.item.id
        : `org-mcp:${target.item.orgMcpConnection?.id ?? target.item.id}`;
  }
}

function resolveExtensionDetailTarget(
  detailId: string,
  lists: {
    quickConnect: McpDirectoryInfo[];
    skills: SkillItem[];
    commands: LibraryCommandItem[];
    agents: LibraryAgentItem[];
    connectMcps: McpServerEntry[];
    servers: McpServerEntry[];
    plugins: CloudImportedPlugin[];
    pendingPlugin?: CloudImportedPlugin | null;
    orgMcpItems: ExtensionItem[];
  },
): ExtensionDetailTarget | null {
  if (detailId.startsWith("skill:")) {
    const name = detailId.slice("skill:".length);
    const skill = lists.skills.find((entry) => entry.name === name);
    return skill ? { kind: "skill", skill } : null;
  }
  const commandId = parseLibraryCommandDetailId(detailId);
  if (commandId) {
    const command = lists.commands.find((entry) => entry.id === commandId || entry.name === commandId);
    return command ? { kind: "command", command } : null;
  }
  const agentName = parseLibraryAgentDetailId(detailId);
  if (agentName) {
    const agent = lists.agents.find((entry) => entry.name === agentName);
    return agent ? { kind: "agent", agent } : null;
  }
  if (detailId.startsWith("connect-mcp:")) {
    const name = detailId.slice("connect-mcp:".length);
    const entry = lists.connectMcps.find((item) => item.name === name || item.id === name);
    return entry ? { kind: "connect-mcp", entry } : null;
  }
  if (detailId.startsWith("server:")) {
    const name = detailId.slice("server:".length);
    const entry = lists.servers.find((item) => item.name === name);
    return entry ? { kind: "server", entry } : null;
  }
  const pluginFileRef = parseLibraryPluginFileDetailId(detailId);
  if (pluginFileRef) {
    const plugin = lists.plugins.find((entry) => entry.pluginId === pluginFileRef.pluginId);
    const file = plugin?.files.find((entry) => entry.configObjectId === pluginFileRef.fileId);
    return plugin && file ? { kind: "plugin-file", plugin, file } : null;
  }
  if (detailId.startsWith("plugin:")) {
    const pluginId = detailId.slice("plugin:".length);
    const plugin = lists.plugins.find((entry) => entry.pluginId === pluginId)
      ?? (lists.pendingPlugin?.pluginId === pluginId ? lists.pendingPlugin : undefined);
    return plugin ? { kind: "plugin", plugin } : null;
  }
  if (detailId.startsWith("org-mcp:")) {
    const connectionId = detailId.slice("org-mcp:".length);
    const item = lists.orgMcpItems.find((entry) =>
      entry.id === detailId
      || entry.orgMcpConnection?.id === connectionId,
    );
    return item ? { kind: "org-mcp", item } : null;
  }
  const entry = lists.quickConnect.find((item) =>
    getMcpIdentityKey(item) === detailId
    || item.id === detailId
    || item.name === detailId,
  );
  return entry ? { kind: "entry", entry } : null;
}

/** Which Library page is showing; the list is home and every other page returns to it. */
type LibraryScreen =
  | { kind: "list" }
  | { kind: "create"; addKind: LibraryAuthorableKind }
  | { kind: "catalog" }
  | { kind: "connector-setup"; preset: DenExternalMcpPreset }
  | { kind: "share"; pluginId: string }
  | { kind: "edit"; skill: LibraryEditableSkill };

export function McpView(props: McpViewProps) {
  const cloudSession = useCloudSession();
  const denAuth = useDenAuth();
  const denBaseUrl = readDenSettings().baseUrl;
  const useRoutedDetail = typeof props.onDetailIdChange === "function";
  const [detailTarget, setDetailTarget] = useState<ExtensionDetailTarget | null>(null);
  const [modelDetail, setModelDetail] = useState<string | null>(null);
  const [mcpConnectFailure, setMcpConnectFailure] = useState<{ id: string; message: string } | null>(null);
  const [pendingPlugin, setPendingPlugin] = useState<CloudImportedPlugin | null>(null);
  const [landingConnector, setLandingConnector] = useState<{ pluginId: string; name: string } | null>(null);
  const [detailSkillContent, setDetailSkillContent] = useState<string | null>(null);
  const [openworkUiMcpCommand, setOpenworkUiMcpCommand] = useState<string[] | null>(null);
  const [openworkUiMcpEnvironment, setOpenworkUiMcpEnvironment] = useState<Record<string, string> | null>(null);
  const [computerUseMcpCommand, setComputerUseMcpCommand] = useState<string[] | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ExtensionInventoryFilter>(primaryLibraryFilter(props.initialFilter));
  const [layout, setLayout] = useState<ExtensionLayout>(readExtensionLayout);
  const [claudeImportOpen, setClaudeImportOpen] = useState(false);
  const [screen, setScreen] = useState<LibraryScreen>({ kind: "list" });
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [changedPluginIds, setChangedPluginIds] = useState<Set<string>>(() => new Set());
  const [, setExtensionStateVersion] = useState(0);

  const [localState, dispatchLocal] = useReducer(
    mcpViewLocalReducer,
    initialMcpViewLocalState,
  );
  const {
    logoutOpen,
    logoutTarget,
    logoutBusy,
    removeOpen,
    removeTarget,
    configScope,
    projectConfig,
    globalConfig,
    configError,
    revealBusy,
    showAdvanced,
    addMcpModalOpen,
    togglingMcp,
  } = localState;
  const setLocal = <K extends keyof McpViewLocalState>(
    key: K,
    value: SetStateAction<McpViewLocalState[K]>,
  ) => dispatchLocal({ type: "set", key, value });
  const setLogoutOpen = (value: SetStateAction<boolean>) => setLocal("logoutOpen", value);
  const setLogoutTarget = (value: SetStateAction<string | null>) => setLocal("logoutTarget", value);
  const setLogoutBusy = (value: SetStateAction<boolean>) => setLocal("logoutBusy", value);
  const setRemoveOpen = (value: SetStateAction<boolean>) => setLocal("removeOpen", value);
  const setRemoveTarget = (value: SetStateAction<string | null>) => setLocal("removeTarget", value);
  const setConfigScope = (value: SetStateAction<ConfigScope>) => setLocal("configScope", value);
  const setConfigError = (value: SetStateAction<string | null>) => setLocal("configError", value);
  const setRevealBusy = (value: SetStateAction<boolean>) => setLocal("revealBusy", value);
  const setShowAdvanced = (value: SetStateAction<boolean>) => setLocal("showAdvanced", value);
  const setAddMcpModalOpen = (value: SetStateAction<boolean>) => setLocal("addMcpModalOpen", value);
  const setTogglingMcp = (value: SetStateAction<string | null>) => setLocal("togglingMcp", value);
  const configRequestId = useRef(0);

  const quickConnectList = props.quickConnect;
  const installedSkills = props.installedSkills ?? [];
  const installedCommands = props.installedCommands ?? [];
  const installedAgents = props.installedAgents ?? [];
  const availableConnectMcpServers = props.availableConnectMcpServers ?? [];
  const installedPlugins = props.installedPlugins ?? [];
  const orgMcpItems = props.orgMcpItems ?? [];
  const libraryDetailLists = {
    quickConnect: quickConnectList,
    skills: installedSkills,
    commands: installedCommands,
    agents: installedAgents,
    connectMcps: availableConnectMcpServers,
    servers: props.mcpServers,
    plugins: installedPlugins,
    pendingPlugin,
    orgMcpItems,
  };
  const routedTarget = useRoutedDetail && props.detailId
    ? resolveExtensionDetailTarget(props.detailId, libraryDetailLists)
    : null;
  const activeTarget = useRoutedDetail ? routedTarget : detailTarget;
  const detailEntry = activeTarget?.kind === "entry" ? activeTarget.entry : null;
  const detailSkill = activeTarget?.kind === "skill" ? activeTarget.skill : null;
  const detailCommand = activeTarget?.kind === "command" ? activeTarget.command : null;
  const detailAgent = activeTarget?.kind === "agent" ? activeTarget.agent : null;
  const detailConnectMcp = activeTarget?.kind === "connect-mcp" ? activeTarget.entry : null;
  const detailServer = activeTarget?.kind === "server" ? activeTarget.entry : null;
  const detailPlugin = activeTarget?.kind === "plugin" ? activeTarget.plugin : null;
  const detailPluginFile = activeTarget?.kind === "plugin-file" ? activeTarget : null;
  const detailOrgMcpItem = activeTarget?.kind === "org-mcp" ? activeTarget.item : null;
  const detailPresentation = useRoutedDetail ? "page" : "dialog";
  const openInDenAction = (target: DenLibraryTarget): ReactNode => {
    if (!shouldShowOpenInDenAction(denBaseUrl, cloudSession.isSignedIn, target)) return null;
    const url = openInDenLibraryUrl(denBaseUrl, target);
    if (!url) return null;
    return (
      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() => void openDesktopUrl(url)}
      >
        {t("extensions.open_in_den")}
        <ArrowUpRight size={13} />
      </Button>
    );
  };
  const setInventoryFilter = (nextFilter: ExtensionInventoryFilter) => {
    setFilter(nextFilter);
    props.onFilterChange?.(nextFilter);
  };
  const libraryCloudSignedIn = cloudSession.isSignedIn
    || (Boolean(cloudSession.authToken.trim()) && denAuth.isSignedIn);
  const activeOrganizationId = cloudSession.activeOrganization?.id.trim() ?? "";
  // The connector catalog rarely changes; keep it across visits so the Add dialog shows its logos at once.
  const connectorPresetsQuery = useQuery({
    queryKey: ["library-connector-presets", cloudSession.baseUrl, activeOrganizationId],
    enabled: libraryCloudSignedIn && Boolean(activeOrganizationId),
    staleTime: 10 * 60_000,
    queryFn: () => cloudSession.client.listMcpConnectionPresets(activeOrganizationId),
  });
  const connectorPresets = useMemo(
    () => (libraryCloudSignedIn && activeOrganizationId ? connectorPresetsQuery.data ?? [] : []),
    [activeOrganizationId, connectorPresetsQuery.data, libraryCloudSignedIn],
  );
  // Persisted Cloud settings reconstruct the organization with a member role.
  // Use the verified member's current role, not that restoration placeholder.
  const identity = denAuth.verifiedIdentity;
  const organizationRole = useQuery({
    queryKey: ["library-organization-role", cloudSession.baseUrl, identity?.principalId, identity?.organizationId],
    enabled: denAuth.isSignedIn && Boolean(identity) && identity?.organizationId === activeOrganizationId,
    queryFn: async () => {
      const result = await cloudSession.client.listOrgs();
      return result.orgs.find((org) => org.id === identity?.organizationId)?.role ?? null;
    },
  });
  const canManageCloudConnections = denAuth.isSignedIn
    && identity?.organizationId === activeOrganizationId
    && isConnectAdminRole(organizationRole.data);
  const connectorCues = useMemo(() => libraryConnectorCues(connectorPresets), [connectorPresets]);
  const libraryAddOptions = {
    cloudSignedIn: libraryCloudSignedIn && Boolean(activeOrganizationId) && denAuth.status !== "unavailable",
    allowManageExtensions: props.allowManageExtensions,
  };
  const libraryAddKinds = libraryAddKindsForFilter(filter).filter((kind) => (
    libraryAddAction(kind, libraryAddOptions) !== null
  ));
  const inventoryError = props.inventoryError ?? props.orgMcpError ?? null;
  const cloudIssue = denAuth.status === "checking"
    ? t("den.checking_session")
    : denAuth.status === "unavailable"
      ? t("extensions.cloud_unavailable")
      : !libraryCloudSignedIn
        ? t("extensions.add_sign_in_required")
        : !activeOrganizationId
          ? t("extensions.cloud_choose_org")
          : undefined;
  const addDisabledReason = cloudIssue ?? (!props.createLibraryItem ? t("extensions.cloud_unavailable") : undefined);
  const signedOut = !libraryCloudSignedIn && denAuth.status !== "checking";
  // Signed out, every add kind needs Cloud: the sign-in banner carries the action instead.
  const addControl = filter === "model" && props.onAddModelProvider ? (
    <Button onClick={props.onAddModelProvider}>{t("extensions.add_to_library")}</Button>
  ) : signedOut ? null : (
    <LibraryAddControl
      kinds={libraryAddKindsForFilter("all")}
      connectorCues={connectorCues}
      variant="default"
      pending={denAuth.status === "checking"}
      disabledReason={addDisabledReason}
      label={t("extensions.add_to_library")}
      onSelect={(kind) => handleAddKind(kind)}
    />
  );
  const libraryCloud = useLibraryCloud({
    client: cloudSession.client,
    baseUrl: cloudSession.baseUrl,
    organizationId: activeOrganizationId,
    enabled: libraryAddOptions.cloudSignedIn,
  });
  const libraryDirectory = libraryCloud.directory;
  const startSeededChat = useStartSeededChat();
  const chatWith = (chips: { skills?: string[]; connectors?: string[] }) => {
    const draft = [
      ...(chips.skills ?? []).map((name) => `[skill ${name}]`),
      ...(chips.connectors ?? []).map((name) => seededConnectorDraft({ connector: name, prompt: "" }).trim()),
    ].join(" ");
    return draft ? () => startSeededChat(`${draft} `) : undefined;
  };
  const shareOwned = (pluginId: string | undefined) =>
    pluginId && libraryCloud.ownedPluginIds.has(pluginId) && libraryCloud.pluginById.has(pluginId)
      ? () => setScreen({ kind: "share", pluginId })
      : undefined;
  const audienceNameOrNull = (audience: LibraryAudience) =>
    isLibraryAudienceShared(audience) ? libraryAudienceName(audience) : null;
  const markChanged = (pluginId: string, changed: boolean) => {
    setChangedPluginIds((current) => {
      const next = new Set(current);
      if (changed) next.add(pluginId);
      else next.delete(pluginId);
      return next;
    });
  };
  const refreshLibrary = () => {
    void libraryCloud.refresh();
    void props.onLibraryListsRefresh?.();
    props.onRefresh?.();
  };

  const handleAddKind = (kind: LibraryAddKind) => {
    const action = libraryAddAction(kind, libraryAddOptions);
    if (!action) return;
    if (action.type === "workspace-mcp") {
      setAddMcpModalOpen(true);
      return;
    }
    if (action.type === "connector-catalog") {
      setScreen({ kind: "catalog" });
      return;
    }
    setScreen({ kind: "create", addKind: action.kind });
  };

  /** A new item opens on its own page, the way it would from its row; Back returns to the list. */
  const finishCreate = (pluginId: string, created: { name: string; description: string; connector?: boolean }) => {
    setScreen({ kind: "list" });
    setFilter("all");
    refreshLibrary();
    if (created.connector) props.onRefresh?.();
    openOwnedPlugin({ id: pluginId, name: created.name, description: created.description || null });
    if (created.connector) setLandingConnector({ pluginId, name: created.name });
    toast.undo(t("extensions.toast_added_title"), {
      detail: t("extensions.toast_added_detail"),
      undo: { label: t("extensions.toast_share_action"), onClick: () => setScreen({ kind: "share", pluginId }) },
      closeLabel: t("common.close"),
    });
  };

  /** OAuth connectors finish in the provider's own window, as they do in Den. */
  const reportSignInFailure = (cause: unknown) => {
    toast.error(cause instanceof Error && cause.message.trim() ? cause.message : t("common.something_went_wrong"));
  };

  const startConnectionSignIn = (connectionId: string) => {
    void cloudSession.client.startMcpConnectionConnect(activeOrganizationId, connectionId)
      .then((start) => (start.authorizeUrl ? openDesktopUrl(start.authorizeUrl) : undefined))
      .catch(reportSignInFailure);
  };

  const signInToCreatedConnection = (name: string, url: string) => {
    void cloudSession.client.listMeLibraryItems(activeOrganizationId)
      .then((items) => {
        const connection = items.find((item) => item.type === "connection" && (item.url === url || item.name === name));
        if (connection) startConnectionSignIn(connection.id);
      })
      .catch(reportSignInFailure);
  };

  const createLibraryItem = async (kind: LibraryAuthorableKind, input: CreateLibraryItemInput) => {
    if (!props.createLibraryItem) {
      throw new Error(t("common.something_went_wrong"));
    }
    return props.createLibraryItem(kind, input);
  };

  const handleCreateLibraryItem = async (kind: LibraryAuthorableKind, input: CreateLibraryItemInput) => {
    const pluginId = await createLibraryItem(kind, input);
    finishCreate(pluginId, { name: input.name.trim(), description: input.description.trim(), connector: kind === "mcp" });
    if (kind === "mcp" && input.connection?.authType === "oauth") {
      signInToCreatedConnection(input.name.trim(), input.instructions.trim());
    }
  };

  const handleConnectorSetup = async (preset: DenExternalMcpPreset, input: LibraryConnectorSetupInput) => {
    const pluginId = await createLibraryItem("mcp", {
      name: preset.displayName,
      description: connectorSummary(preset),
      instructions: preset.url,
      connection: canManageCloudConnections
        ? {
          authType: preset.authType,
          credentialMode: "per_member",
          apiKey: input.apiKey ?? "",
          useOAuthClient: Boolean(input.oauthClient),
          oauthClientId: input.oauthClient?.clientId ?? "",
          oauthClientSecret: input.oauthClient?.clientSecret ?? "",
        }
        : undefined,
    });
    finishCreate(pluginId, { name: preset.displayName, description: connectorSummary(preset), connector: true });
    if (preset.authType === "oauth") signInToCreatedConnection(preset.displayName, preset.url);
  };

  const connectionItemForPlugin = (pluginName: string) => orgMcpItems
    .filter(isOrgMcpConnectionItem)
    .find((item) => connectionPluginName(item.name) === pluginName.toLowerCase());

  const openOwnedPlugin = (plugin: Pick<DenLibraryPluginItem, "id" | "name" | "description">) => {
    const connectionItem = connectionItemForPlugin(plugin.name);
    if (connectionItem) {
      openDetail({ kind: "org-mcp", item: connectionItem });
      return;
    }
    const installed = installedPlugins.find((entry) => entry.pluginId === plugin.id);
    if (installed) {
      openDetail({ kind: "plugin", plugin: installed });
      return;
    }
    setPendingPlugin({
      pluginId: plugin.id,
      marketplaceId: null,
      name: plugin.name,
      description: plugin.description,
      updatedAt: null,
      files: [],
      importedAt: Date.now(),
    });
    props.onDetailIdChange?.(`plugin:${plugin.id}`);
  };

  const shareWith = async (plugin: DenLibraryPluginItem, targets: LibraryShareTarget[], audience: LibraryAudience) => {
    const previous = libraryCloud.audienceFor(plugin.id);
    await libraryCloud.setAudience(plugin.id, targets);
    setScreen({ kind: "list" });
    const undo = {
      label: t("common.undo"),
      onClick: () => void libraryCloud.setAudience(plugin.id, targetsFor(previous)),
    };
    if (!isLibraryAudienceShared(audience)) {
      toast.undo(t("extensions.toast_stopped_title", { name: plugin.name }), {
        detail: t("extensions.toast_stopped_detail"),
        undo,
        closeLabel: t("common.close"),
      });
      return;
    }
    toast.undo(t("extensions.toast_shared_title", { name: plugin.name, audience: libraryAudienceName(audience) }), {
      detail: t("extensions.toast_shared_detail", { count: String(libraryAudiencePeopleCount(audience, libraryDirectory)) }),
      undo,
      closeLabel: t("common.close"),
    });
  };

  const openEdit = async (plugin: DenLibraryPluginItem) => {
    const skill = await libraryCloud.readSkill(plugin.id);
    if (!skill) {
      openOwnedPlugin(plugin);
      return;
    }
    setScreen({ kind: "edit", skill });
  };

  const saveEdit = async (skill: LibraryEditableSkill, draft: LibrarySkillDraft) => {
    const audience = libraryCloud.audienceFor(skill.pluginId);
    await libraryCloud.saveSkill(skill, draft);
    markChanged(skill.pluginId, true);
    setScreen({ kind: "list" });
    const audienceName = audienceNameOrNull(audience);
    toast.undo(t("extensions.toast_saved_title", { name: skill.name }), {
      detail: audienceName
        ? t("extensions.toast_saved_detail_shared", { audience: audienceName })
        : t("extensions.toast_saved_detail"),
      undo: {
        label: t("common.undo"),
        onClick: () => {
          void libraryCloud
            .saveSkill(skill, { name: skill.name, description: skill.description, instructions: skill.instructions })
            .then(() => markChanged(skill.pluginId, false));
        },
      },
      closeLabel: t("common.close"),
    });
  };

  const duplicateSkill = async (plugin: DenLibraryPluginItem) => {
    const skill = await libraryCloud.readSkill(plugin.id);
    if (!skill) return;
    const name = t("extensions.duplicate_name", { name: skill.name });
    const pluginId = await createLibraryItem("skill", {
      name,
      description: skill.description,
      instructions: skill.instructions,
    });
    finishCreate(pluginId, { name, description: skill.description });
  };

  const deleteOwned = async (plugin: DenLibraryPluginItem) => {
    const audienceName = audienceNameOrNull(libraryCloud.audienceFor(plugin.id));
    setDeleteTargetId(null);
    await libraryCloud.archive(plugin.id);
    markChanged(plugin.id, false);
    toast.undo(t("extensions.toast_deleted_title", { name: plugin.name }), {
      detail: audienceName
        ? t("extensions.toast_deleted_detail_shared", { audience: audienceName })
        : t("extensions.toast_deleted_detail"),
      undo: { label: t("common.undo"), onClick: () => void libraryCloud.restore(plugin.id) },
      closeLabel: t("common.close"),
    });
  };

  const handleRowAction = (plugin: DenLibraryPluginItem, action: LibraryRowMenuAction) => {
    const report = (cause: unknown) => {
      toast.error(cause instanceof Error && cause.message.trim() ? cause.message : t("common.something_went_wrong"));
    };
    switch (action) {
      case "open":
        openOwnedPlugin(plugin);
        return;
      case "edit":
        void openEdit(plugin).catch(report);
        return;
      case "share":
        setScreen({ kind: "share", pluginId: plugin.id });
        return;
      case "duplicate":
        void duplicateSkill(plugin).catch(report);
        return;
      case "stop_sharing":
        void shareWith(plugin, [], emptyLibraryAudience).catch(report);
        return;
      case "delete":
        setDeleteTargetId(plugin.id);
        return;
    }
  };

  const closeDetail = () => {
    setDetailTarget(null);
    setPendingPlugin(null);
    setLandingConnector(null);
    setDetailSkillContent(null);
    setMcpConnectFailure(null);
    props.onDetailIdChange?.(null);
  };

  // Back from a provider's page returns to the Models filter it was opened from.
  const closeModelDetail = () => {
    setModelDetail(null);
    setFilter("model");
    if (!useRoutedDetail) return;
    if (props.onFilterChange) props.onFilterChange("model");
    else props.onDetailIdChange?.(null);
  };

  const openModelProvider = (provider: LibraryModelProvider) => {
    if (useRoutedDetail) props.onDetailIdChange?.(libraryModelDetailId(provider));
    else setModelDetail(provider.key);
  };

  const openDetail = (target: ExtensionDetailTarget) => {
    setDetailTarget(target);
    setMcpConnectFailure(null);
    if (target.kind === "skill") {
      setDetailSkillContent(target.skill.content ?? null);
      if (!target.skill.content && target.skill.origin !== "openwork-connect" && props.readSkill) {
        void props.readSkill(target.skill.name).then((result) => {
          if (result?.content) {
            setDetailSkillContent(result.content);
          }
        });
      }
    } else {
      setDetailSkillContent(null);
    }
    props.onDetailIdChange?.(extensionDetailIdForTarget(target));
  };

  const openPluginFile = (plugin: CloudImportedPlugin, file: CloudImportedPluginFile) => {
    const preferred = libraryPluginFilePreferredDetailId(file);
    if (preferred) {
      const resolved = resolveExtensionDetailTarget(preferred, libraryDetailLists);
      if (resolved) {
        openDetail(resolved);
        return;
      }
    }
    openDetail({ kind: "plugin-file", plugin, file });
  };

  useEffect(() => {
    setFilter(primaryLibraryFilter(props.initialFilter));
  }, [props.initialFilter]);

  useEffect(() => {
    if (!useRoutedDetail) return;
    const detailId = props.detailId ?? null;
    if (!detailId) {
      setDetailTarget(null);
      setDetailSkillContent(null);
      return;
    }
    const resolved = resolveExtensionDetailTarget(detailId, libraryDetailLists);
    setDetailTarget(resolved);
    if (resolved?.kind === "skill") {
      setDetailSkillContent(resolved.skill.content ?? null);
      if (!resolved.skill.content && resolved.skill.origin !== "openwork-connect" && props.readSkill) {
        void props.readSkill(resolved.skill.name).then((result) => {
          if (result?.content) {
            setDetailSkillContent(result.content);
          }
        });
      }
    } else {
      setDetailSkillContent(null);
    }
  }, [
    useRoutedDetail,
    props.detailId,
    props.readSkill,
    quickConnectList,
    installedSkills,
    installedCommands,
    installedAgents,
    availableConnectMcpServers,
    installedPlugins,
    pendingPlugin,
    orgMcpItems,
  ]);

  // A new connector opens on its plugin page at once, then moves to its connection page, where sign-in lives, once that loads.
  useEffect(() => {
    if (!landingConnector) return;
    const elsewhere = activeTarget !== null && !(activeTarget.kind === "plugin" && activeTarget.plugin.pluginId === landingConnector.pluginId);
    if (elsewhere) {
      setLandingConnector(null);
      return;
    }
    const item = orgMcpItems
      .filter(isOrgMcpConnectionItem)
      .find((entry) => connectionPluginName(entry.name) === landingConnector.name.toLowerCase());
    if (!item) return;
    setLandingConnector(null);
    setPendingPlugin(null);
    openDetail({ kind: "org-mcp", item });
  }, [landingConnector, activeTarget, orgMcpItems]);

  useEffect(() => {
    if (!pendingPlugin) return;
    if (installedPlugins.some((plugin) => plugin.pluginId === pendingPlugin.pluginId)) {
      setPendingPlugin(null);
    }
  }, [pendingPlugin, installedPlugins]);

  useEffect(() => {
    if (useRoutedDetail) return;
    if (detailEntry && !quickConnectList.includes(detailEntry)) {
      setDetailTarget(null);
    }
  }, [useRoutedDetail, detailEntry, quickConnectList]);

  useEffect(() => {
    setMcpConnectFailure((current) =>
      current && (!detailEntry || current.id !== getMcpIdentityKey(detailEntry)) ? null : current
    );
  }, [detailEntry]);

  useEffect(() => {
    const refresh = () => setExtensionStateVersion((value) => value + 1);
    window.addEventListener(OPENWORK_EXTENSION_STATE_CHANGED, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(OPENWORK_EXTENSION_STATE_CHANGED, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    void (async () => {
      try {
        const command = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("getOpenworkUiMcpCommand");
        if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
          setOpenworkUiMcpCommand(command);
        }
        const environment = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("getOpenworkUiMcpEnvironment");
        if (environment && typeof environment === "object" && !Array.isArray(environment)) {
          setOpenworkUiMcpEnvironment(Object.fromEntries(
            Object.entries(environment).filter((entry): entry is [string, string] =>
              typeof entry[0] === "string" && typeof entry[1] === "string"
            ),
          ));
        }
        const computerUseCommand = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("getComputerUseMcpCommand");
        if (Array.isArray(computerUseCommand) && computerUseCommand.every((part) => typeof part === "string")) {
          setComputerUseMcpCommand(computerUseCommand);
        }
      } catch {
        setOpenworkUiMcpCommand(null);
        setOpenworkUiMcpEnvironment(null);
        setComputerUseMcpCommand(null);
      }
    })();
  }, []);

  useEffect(() => {
    const root = props.selectedWorkspaceRoot.trim();
    const nextId = configRequestId.current + 1;
    configRequestId.current = nextId;
    const readConfig = props.readConfigFile;
    const canReadDesktopConfig = !props.isRemoteWorkspace && isDesktopRuntime();

    if (!readConfig && !canReadDesktopConfig) {
      dispatchLocal({ type: "configUnavailable" });
      return;
    }

    void (async () => {
      try {
        setConfigError(null);
        const [project, global] = await Promise.all([
          root
            ? readConfig
              ? readConfig("project")
              : canReadDesktopConfig
              ? readOpencodeConfig("project", root)
              : Promise.resolve(null)
            : Promise.resolve(null),
          readConfig
            ? readConfig("global")
            : canReadDesktopConfig
            ? readOpencodeConfig("global", root)
            : Promise.resolve(null),
        ]);
        if (nextId !== configRequestId.current) return;
        dispatchLocal({
          type: "configLoaded",
          project: project as OpencodeConfigFile | null,
          global: global as OpencodeConfigFile | null,
        });
      } catch (error) {
        if (nextId !== configRequestId.current) return;
        dispatchLocal({
          type: "configLoadError",
          error: error instanceof Error ? error.message : t("mcp.config_load_failed"),
        });
      }
    })();
  }, [props.isRemoteWorkspace, props.readConfigFile, props.selectedWorkspaceRoot]);

  const activeConfig = configScope === "project" ? projectConfig : globalConfig;

  const revealLabel = isWindowsPlatform()
    ? t("mcp.open_file")
    : t("mcp.reveal_in_finder");

  const canRevealConfig =
    isDesktopRuntime() &&
    !props.isRemoteWorkspace &&
    !revealBusy &&
    !(configScope === "project" && !props.selectedWorkspaceRoot.trim()) &&
    Boolean(activeConfig?.exists);

  const resolveQuickConnectMatch = (name: string) =>
    quickConnectList.find((candidate) => {
      const candidateKey = getMcpIdentityKey(candidate);
      return (
        candidateKey === name ||
        candidate.name === name ||
        normalizeMcpSlug(candidate.name) === name
      );
    });

  const displayName = (name: string) => resolveQuickConnectMatch(name)?.name ?? name;

  const quickConnectStatus = (entry: McpDirectoryInfo) =>
    props.mcpStatuses[getMcpIdentityKey(entry)];

  const isQuickConnectConfigured = (entry: McpDirectoryInfo) =>
    props.mcpServers.some((server) => server.name === getMcpIdentityKey(entry));

  // Servers written into this workspace's config appear under MCPs as local
  // items. Projected Cloud connections have their own account controls, and
  // OpenWork's own runtimes are app functionality rather than MCPs to browse.
  const localServers = props.mcpServers.filter((entry) => {
    if (isConnectDirectMcpServerName(entry.name)) return false;
    const match = resolveQuickConnectMatch(entry.name);
    return !match || isLibraryMcpDirectoryEntry(match);
  });

  // A directory entry that is already configured is represented by its local
  // server card, so the catalog only offers what is not set up yet.
  const libraryDirectoryEntries = quickConnectList.filter((entry) =>
    isLibraryMcpDirectoryEntry(entry) && !isQuickConnectConfigured(entry));

  const isMcpBackedExtension = (entry: McpDirectoryInfo) =>
    entry.kind === "extension" && Boolean(entry.type || entry.command?.length || entry.url);

  const enablementForEntry = (entry: McpDirectoryInfo): { active: boolean; results: EnablementResult[] } | null => {
    const manifest = entry.extensionManifest;
    if (manifest?.enablement && props.enablementContext) {
      return evaluateEnablement(manifest.enablement, props.enablementContext);
    }
    return null;
  };

  const isEntryConfigured = (entry: McpDirectoryInfo) => {
    if (props.builtInExtensionsDisabled && isBuiltInOpenWorkExtension(entry)) return false;
    const result = enablementForEntry(entry);
    if (result) return result.active;
    // Fallback for entries without enablement context.
    if (isToggleOnlyExtension(entry)) return isOpenWorkExtensionEnabled(entry);
    if (entry.kind === "extension" && !isMcpBackedExtension(entry)) return props.isExtensionConnected?.(entry) ?? false;
    return isQuickConnectConfigured(entry);
  };

  // Built-in OpenWork extensions answer to `allowBuiltInExtensions`; every
  // other directory entry is a local install governed by
  // `allowManageExtensions`. Entries the member already installed stay usable
  // but can no longer be managed.
  const builtInDisabledReasonForEntry = (entry: McpDirectoryInfo) =>
    props.builtInExtensionsDisabled && isBuiltInOpenWorkExtension(entry)
      ? builtInExtensionDisabledReason()
      : null;
  const manageDisabledReasonForEntry = (entry: McpDirectoryInfo) =>
    !props.allowManageExtensions && !isBuiltInOpenWorkExtension(entry)
      ? manageExtensionsDisabledReason()
      : null;

  const launchCommandForEntry = (entry: McpDirectoryInfo) => {
    if (entry.serverName === "openwork-ui") return openworkUiMcpCommand ?? undefined;
    if (entry.serverName === "computer-use") return computerUseMcpCommand ?? entry.command;
    return entry.command;
  };

  const supportsOauth = (entry: McpServerEntry) =>
    Boolean(entry.managedOAuth) || (entry.config.type === "remote" && entry.config.oauth !== false);

  const resolveStatus = (entry: McpServerEntry): ReactMcpStatus => {
    if (entry.config.enabled === false) return "disabled";
    const resolved = props.mcpStatuses[entry.name];
    return resolved?.status ?? "disconnected";
  };

  const requestLogout = (name: string) => {
    if (!name.trim()) return;
    setLogoutTarget(name);
    setLogoutOpen(true);
  };

  const confirmLogout = async () => {
    const name = logoutTarget;
    if (!name || logoutBusy) return;
    setLogoutBusy(true);
    try {
      await props.logoutMcpAuth(name);
    } finally {
      setLogoutBusy(false);
      setLogoutOpen(false);
      setLogoutTarget(null);
    }
  };

  const revealConfig = async () => {
    if (!isDesktopRuntime() || revealBusy) return;
    const root = props.selectedWorkspaceRoot.trim();

    if (configScope === "project" && !root) {
      setConfigError(t("mcp.pick_workspace_error"));
      return;
    }

    setRevealBusy(true);
    setConfigError(null);
    try {
      const resolved = props.readConfigFile
        ? await props.readConfigFile(configScope)
        : !props.isRemoteWorkspace
        ? await readOpencodeConfig(configScope, root)
        : null;
      const configFile = resolved as OpencodeConfigFile | null;
      if (!configFile) {
        throw new Error(t("mcp.config_load_failed"));
      }
      if (isWindowsPlatform()) {
        await openDesktopPath(configFile.path);
      } else {
        await revealDesktopItemInDir(configFile.path);
      }
    } catch (error) {
      setConfigError(
        error instanceof Error ? error.message : t("mcp.reveal_config_failed"),
      );
    } finally {
      setRevealBusy(false);
    }
  };

  const detailPanels = (
    <>
      {detailEntry ? (() => {
        const extensionConfigSlot = props.configSlotForEntry?.(detailEntry) ?? null;
        const hasConfigSlot = extensionConfigSlot !== null;
        const hidden = isOpenWorkExtensionHidden(detailEntry);
        const builtInDisabledReason = builtInDisabledReasonForEntry(detailEntry);
        const disabledReason = builtInDisabledReason ?? manageDisabledReasonForEntry(detailEntry);
        const isConnected = builtInDisabledReason
          ? false
          : detailEntry.serverName === "computer-use"
          ? enablementForEntry(detailEntry)?.active === true
          : isToggleOnlyExtension(detailEntry)
          ? isOpenWorkExtensionEnabled(detailEntry)
          : detailEntry.kind === "extension" && !isMcpBackedExtension(detailEntry)
          ? props.isExtensionConnected?.(detailEntry) ?? false
          : isQuickConnectConfigured(detailEntry);
        return (
          <ExtensionDetailModal
            open={!!detailEntry}
            onClose={closeDetail}
            presentation={detailPresentation}
            backLabel={t("extensions.title")}
            name={detailEntry.name}
            description={detailEntry.description}
            iconSlug={detailEntry.iconSlug}
            iconSrc={detailEntry.iconSrc}
            taxonomy={taxonomyForDirectoryEntry(detailEntry)}
            uiControl={detailEntry.kind === "ui-control"}
            connected={isConnected}
            connecting={props.mcpConnectingName === detailEntry.name}
            errorInfo={mcpConnectFailure?.id === getMcpIdentityKey(detailEntry) ? mcpConnectFailure.message : null}
            hidden={hidden}
            preview={detailEntry.preview}
            disabledReason={disabledReason}
            setupInstructions={detailEntry.extensionManifest?.setup?.instructions}
            resourceLabels={extensionResourceLabels(detailEntry)}
            contributionLabels={extensionContributionLabels(detailEntry)}
            launchCommand={launchCommandForEntry(detailEntry)}
            environment={detailEntry.serverName === "openwork-ui" ? openworkUiMcpEnvironment ?? undefined : undefined}
            url={typeof detailEntry.url === "string" ? detailEntry.url : undefined}
            oauth={detailEntry.oauth}
            configSlot={disabledReason ? null : extensionConfigSlot}
            showEnablementCard
            onConnect={disabledReason ? undefined : isToggleOnlyExtension(detailEntry) ? () => {
              setOpenWorkExtensionEnabled(detailEntry, true);
              closeDetail();
            } : hasConfigSlot ? undefined : async () => {
              setMcpConnectFailure(null);
              const result = await props.connectMcp(detailEntry);
              if (result.ok) {
                closeDetail();
                return;
              }
              setMcpConnectFailure({
                id: getMcpIdentityKey(detailEntry),
                message: result.error.trim() ? result.error : t("mcp.connect_failed"),
              });
            }}
            onUninstall={disabledReason ? undefined : isToggleOnlyExtension(detailEntry) && isConnected ? () => {
              setOpenWorkExtensionEnabled(detailEntry, false);
            } : isQuickConnectConfigured(detailEntry) ? () => {
              const slug = getMcpIdentityKey(detailEntry);
              props.removeMcp(slug);
              closeDetail();
            } : undefined}
            onChat={chatWith({ connectors: [detailEntry.name] })}
            onHide={() => setOpenWorkExtensionHidden(detailEntry, true)}
            onShow={() => setOpenWorkExtensionHidden(detailEntry, false)}
          />
        );
      })() : null}

      {detailSkill ? (() => {
        const hidden = isOpenWorkExtensionHidden(getSkillHiddenId(detailSkill));
        return (
          <ExtensionDetailModal
            open={!!detailSkill}
            onClose={closeDetail}
            presentation={detailPresentation}
            backLabel={t("extensions.title")}
            name={detailSkill.name}
            description={detailSkill.description ?? "Installed skill"}
            taxonomy="skill"
            connected={true}
            connectedLabel={detailSkill.origin === "openwork-connect" ? "Available through OpenWork Connect" : undefined}
            hidden={hidden}
            path={detailSkill.origin === "openwork-connect" ? undefined : detailSkill.path}
            sourceLabel={
              detailSkill.origin === "openwork-connect"
                ? [detailSkill.pluginName, detailSkill.marketplaceName].filter(Boolean).join(" · ") || t("extensions.surface_cloud")
                : detailSkill.path
            }
            triggers={detailSkill.trigger ? [detailSkill.trigger] : []}
            triggerHint={t("extensions.detail_triggers_skill_hint")}
            instructionsHint={t("extensions.detail_instructions_skill_hint")}
            openFileLabel={t("extensions.detail_open_skill")}
            contentPreview={detailSkillContent ?? undefined}
            configSlot={openInDenAction({ id: detailSkill.path })}
            onReveal={detailSkill.path && detailSkill.origin !== "openwork-connect" ? () => {
              void revealDesktopItemInDir(detailSkill.path);
            } : undefined}
            onUninstall={props.uninstallSkill && detailSkill.origin !== "openwork-connect" ? () => {
              props.uninstallSkill?.(detailSkill.name);
              closeDetail();
            } : undefined}
            onChat={chatWith({ skills: [detailSkill.name] })}
            onHide={() => setOpenWorkExtensionHidden(getSkillHiddenId(detailSkill), true)}
            onShow={() => setOpenWorkExtensionHidden(getSkillHiddenId(detailSkill), false)}
          />
        );
      })() : null}

      {detailCommand ? (
        <ExtensionDetailModal
          open={true}
          onClose={closeDetail}
          presentation={detailPresentation}
          backLabel={t("extensions.title")}
          name={`/${detailCommand.name}`}
          description={detailCommand.description ?? t("extensions.detail_source_composer")}
          taxonomy="command"
          connected={true}
          sourceLabel={t("extensions.detail_source_composer")}
          triggers={libraryCommandTriggers(detailCommand)}
          triggerHint={t("extensions.detail_triggers_command_hint")}
          instructionsHint={t("extensions.detail_instructions_command_hint")}
          contentPreview={detailCommand.template}
          facts={[
            { label: t("extensions.detail_fact_slash"), value: `/${detailCommand.name}` },
            ...(detailCommand.agent ? [{ label: t("extensions.detail_fact_agent"), value: detailCommand.agent }] : []),
            ...(detailCommand.model ? [{ label: t("extensions.detail_fact_model"), value: detailCommand.model }] : []),
          ]}
          onChat={() => startSeededChat(`/${detailCommand.name} `)}
        />
      ) : null}

      {detailAgent ? (
        <ExtensionDetailModal
          open={true}
          onClose={closeDetail}
          presentation={detailPresentation}
          backLabel={t("extensions.title")}
          name={detailAgent.name}
          description={detailAgent.description ?? t("extensions.detail_source_composer")}
          taxonomy="agent"
          connected={true}
          sourceLabel={detailAgent.native ? t("extensions.detail_native_agent") : t("extensions.detail_workspace_agent")}
          triggers={[t("extensions.detail_agent_trigger")]}
          triggerHint={t("extensions.detail_triggers_agent_hint")}
          instructionsHint={t("extensions.detail_instructions_agent_hint")}
          contentPreview={detailAgent.prompt}
          facts={[
            ...(detailAgent.mode ? [{ label: t("extensions.detail_fact_mode"), value: detailAgent.mode }] : []),
            { label: t("extensions.detail_fact_origin"), value: detailAgent.native ? t("extensions.detail_native_agent") : t("extensions.detail_workspace_agent") },
            ...(detailAgent.model
              ? [{ label: t("extensions.detail_fact_model"), value: `${detailAgent.model.providerID}/${detailAgent.model.modelID}` }]
              : []),
          ]}
        />
      ) : null}

      {detailConnectMcp ? (
        <ExtensionDetailModal
          open={true}
          onClose={closeDetail}
          presentation={detailPresentation}
          backLabel={t("extensions.title")}
          name={detailConnectMcp.name}
          description={
            detailConnectMcp.pluginName
              ? `Provided by ${detailConnectMcp.pluginName}${detailConnectMcp.marketplaceName ? ` · ${detailConnectMcp.marketplaceName}` : ""}.`
              : detailConnectMcp.marketplaceName
                ? `Provided by ${detailConnectMcp.marketplaceName}.`
                : "Available through OpenWork Connect."
          }
          taxonomy="connection"
          connected={(props.availableConnectMcpStatuses?.[detailConnectMcp.id ?? detailConnectMcp.name]?.status) === "connected"}
          connectedLabel="Available through OpenWork Connect"
          disconnectedLabel="Setup required"
          url={detailConnectMcp.config.type === "remote" ? detailConnectMcp.config.url : undefined}
          oauth={detailConnectMcp.config.type === "remote"}
          facts={[
            ...(detailConnectMcp.pluginName
              ? [{ label: t("extensions.detail_fact_plugin"), value: detailConnectMcp.pluginName }]
              : []),
            ...(detailConnectMcp.marketplaceName
              ? [{ label: t("extensions.detail_fact_collection"), value: detailConnectMcp.marketplaceName }]
              : []),
          ]}
          showEnablementCard
          onChat={chatWith({ connectors: [detailConnectMcp.name] })}
          configSlot={openInDenAction({ id: detailConnectMcp.id ?? detailConnectMcp.name })}
        />
      ) : null}

      {detailServer ? (() => {
        const status = resolveStatus(detailServer);
        const match = resolveQuickConnectMatch(detailServer.name);
        return (
          <ExtensionDetailModal
            open={true}
            onClose={closeDetail}
            presentation={detailPresentation}
            backLabel={t("extensions.title")}
            name={displayName(detailServer.name)}
            description={match?.description ?? localServerTypeLabel(detailServer)}
            iconSlug={match?.iconSlug}
            iconSrc={match?.iconSrc}
            taxonomy="mcp"
            connected={status === "connected"}
            connectedLabel={friendlyStatus(status)}
            disconnectedLabel={friendlyStatus(status)}
            sourceLabel={localServerSourceLabel(detailServer)}
            errorInfo={readMcpErrorInfo(props.mcpStatuses[detailServer.name])}
            oauth={supportsOauth(detailServer)}
            showEnablementCard={false}
            onChat={chatWith({ connectors: [displayName(detailServer.name)] })}
            configSlot={(
              <McpConfiguredServerDetails
                entry={detailServer}
                status={status}
                errorInfo={null}
                busy={props.busy}
                logoutBusy={logoutBusy}
                logoutTarget={logoutTarget}
                togglingMcp={togglingMcp}
                supportsOauth={supportsOauth}
                onAuthorize={props.authorizeMcp}
                onRequestLogout={requestLogout}
                onRemove={(name) => {
                  setRemoveTarget(name);
                  setRemoveOpen(true);
                }}
                onToggleEnabled={props.setMcpEnabled}
                onToggleBusy={setTogglingMcp}
              />
            )}
          />
        );
      })() : null}

      {detailPlugin ? (() => {
        const hidden = isOpenWorkExtensionHidden(`plugin:${detailPlugin.pluginId}`);
        const marketplaceName = detailPlugin.files.find((file) => file.marketplaceName)?.marketplaceName;
        const cloudItem = libraryCloud.pluginById.get(detailPlugin.pluginId);
        const pluginTaxonomy = cloudItem ? libraryCloudItemTaxonomy(cloudItem.componentKinds, cloudItem.componentCount) : "plugin";
        const filesOfKind = (kind: string) => detailPlugin.files
          .filter((file) => libraryPluginFileKind(file.objectType) === kind)
          .map((file) => libraryPluginFileDisplayName(file));
        const pluginSkills = filesOfKind("skill");
        const pluginConnectors = filesOfKind("mcp");
        return (
          <ExtensionDetailModal
            open={!!detailPlugin}
            onClose={closeDetail}
            presentation={detailPresentation}
            backLabel={t("extensions.title")}
            name={detailPlugin.name}
            description={detailPlugin.description ?? kindLabel(pluginTaxonomy)}
            taxonomy={pluginTaxonomy}
            connected={true}
            hidden={hidden}
            facts={[
              {
                label: t("extensions.detail_fact_capabilities"),
                value: String(detailPlugin.files.length),
              },
              ...(marketplaceName
                ? [{ label: t("extensions.detail_fact_collection"), value: marketplaceName }]
                : []),
            ]}
            contents={detailPlugin.files.map((file) => {
              const kind = libraryPluginFileKind(file.objectType);
              return {
                key: file.configObjectId,
                kindLabel: kind ? extensionTaxonomyLabel(kind) : file.objectType,
                name: libraryPluginFileDisplayName(file),
                onOpen: () => openPluginFile(detailPlugin, file),
              };
            })}
            configSlot={openInDenAction({ id: `marketplace:installed:${detailPlugin.pluginId}`, pluginId: detailPlugin.pluginId })}
            onChat={chatWith({
              skills: pluginSkills.length === 0 && pluginTaxonomy === "skill" ? [detailPlugin.name] : pluginSkills,
              connectors: pluginConnectors,
            })}
            onShare={shareOwned(detailPlugin.pluginId)}
            onUninstall={props.removeCloudPlugin ? () => {
              void props.removeCloudPlugin?.(detailPlugin.pluginId);
              closeDetail();
            } : undefined}
            onHide={() => setOpenWorkExtensionHidden(`plugin:${detailPlugin.pluginId}`, true)}
            onShow={() => setOpenWorkExtensionHidden(`plugin:${detailPlugin.pluginId}`, false)}
          />
        );
      })() : null}

      {detailPluginFile ? (() => {
        const { plugin, file } = detailPluginFile;
        const kind = libraryPluginFileKind(file.objectType);
        const taxonomy = kind === "skill" || kind === "command" || kind === "agent" || kind === "mcp" || kind === "app"
          ? kind
          : "plugin";
        return (
          <ExtensionDetailModal
            open={true}
            onClose={() => openDetail({ kind: "plugin", plugin })}
            presentation={detailPresentation}
            backLabel={plugin.name}
            name={libraryPluginFileDisplayName(file)}
            description={file.connectCapabilityName
              ? `Provided by ${plugin.name}.`
              : `From ${plugin.name}.`}
            taxonomy={taxonomy}
            connected={true}
            facts={[
              { label: t("extensions.detail_fact_plugin"), value: plugin.name },
              ...(file.marketplaceName
                ? [{ label: t("extensions.detail_fact_collection"), value: file.marketplaceName }]
                : []),
            ]}
            configSlot={openInDenAction({ id: `marketplace:installed:${plugin.pluginId}`, pluginId: plugin.pluginId })}
            onChat={kind === "skill"
              ? chatWith({ skills: [libraryPluginFileDisplayName(file)] })
              : kind === "mcp"
                ? chatWith({ connectors: [libraryPluginFileDisplayName(file)] })
                : undefined}
          />
        );
      })() : null}

      {detailOrgMcpItem && isOrgMcpConnectionItem(detailOrgMcpItem) ? (() => {
        const connection = detailOrgMcpItem.orgMcpConnection;
        const ready = isOrgMcpConnectionReady(connection);
        const canAuthorize = canMemberAuthorizeConnection(connection);
        const canDisconnect = canDisconnectMemberConnection(connection);
        const connectingBusy = props.orgMcpConnectingId === connection.id;
        const disconnectingBusy = props.orgMcpDisconnectingId === connection.id;
        const cloudConnection = libraryCloud.items.find((item) => item.type === "connection" && item.id === connection.id);
        const addedBy = cloudConnection?.edges.find((edge) => edge.kind === "person");
        const currentMember = libraryDirectory?.currentMemberId ?? null;
        const addedByMe = Boolean(cloudConnection?.edges.some((edge) => edge.kind === "mine" || (edge.kind === "person" && edge.sharedById === currentMember)));
        const ownPlugin = [...libraryCloud.pluginById.values()].find((plugin) =>
          libraryCloud.ownedPluginIds.has(plugin.id) && plugin.name.toLowerCase() === connectionPluginName(detailOrgMcpItem.name));
        const displayName = ownPlugin?.name ?? detailOrgMcpItem.name;
        return (
          <ExtensionDetailModal
            open={true}
            onClose={closeDetail}
            presentation={detailPresentation}
            backLabel={t("extensions.title")}
            name={displayName}
            description={(!ready && addedByMe ? ownPlugin?.description : null) ?? detailOrgMcpItem.description ?? orgMcpConnectionActionLabel(connection)}
            taxonomy="connection"
            connected={ready}
            connectedLabel={orgMcpConnectionActionLabel(connection)}
            connecting={connectingBusy || disconnectingBusy}
            connectingLabel={disconnectingBusy ? t("mcp.org_connection_disconnecting_action") : t("mcp.org_connection_waiting_browser")}
            beta
            errorInfo={props.orgMcpError}
            url={connection.url}
            oauth={connection.authType === "oauth"}
            facts={[
              {
                label: t("extensions.detail_fact_who"),
                value: libraryConnectionAudience(cloudConnection?.edges ?? [], props.organizationName?.trim() || t("extensions.surface_cloud")),
              },
              {
                label: t("extensions.detail_fact_whose_account"),
                value: connection.credentialMode === "shared" ? t("extensions.detail_account_org") : t("extensions.detail_account_yours"),
              },
              ...(addedBy?.kind === "person" && addedBy.sharedByName
                ? [{ label: t("extensions.detail_fact_added_by"), value: addedBy.sharedByName }]
                : []),
            ]}
            connectLabel={orgMcpConnectionActionLabel(connection)}
            reconnectLabel={t("mcp.org_connection_reconnect_action")}
            onConnect={!ready && canAuthorize && props.connectOrgMcp ? () => props.connectOrgMcp?.(connection.id) : undefined}
            onReconnect={ready && canAuthorize && props.reconnectOrgMcp ? () => props.reconnectOrgMcp?.(connection.id) : undefined}
            onUninstall={canDisconnect && props.disconnectOrgMcp ? () => props.disconnectOrgMcp?.(connection.id) : undefined}
            uninstallLabel={t("mcp.org_connection_disconnect_action")}
            onChat={chatWith({ connectors: [displayName] })}
            onShare={shareOwned(ownPlugin?.id)}
            closeOnUninstall={false}
            showEnablementCard={false}
            configSlot={(
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                  <span className="rounded-full border border-dls-border bg-dls-hover px-2 py-1 text-xs text-dls-secondary">{addedByMe ? t("extensions.detail_chip_added_by_you") : t("extensions.detail_chip_shared_by_org")}</span>
                  <span className="rounded-full border border-dls-border bg-dls-hover px-2 py-1 text-xs text-dls-secondary">{connection.credentialMode === "shared" ? "Org account" : "Your account"}</span>
                </div>
                {openInDenAction({ id: detailOrgMcpItem.id })}
              </div>
            )}
          />
        );
      })() : null}
    </>
  );

  const cloudPlugins = [...libraryCloud.pluginById.values()];
  const ownedPlugins = cloudPlugins.filter((plugin) => libraryCloud.ownedPluginIds.has(plugin.id));
  const cloudConnections = libraryCloud.items.filter((item): item is DenLibraryConnectionItem => item.type === "connection");
  const currentMemberId = libraryDirectory?.currentMemberId ?? null;
  const ownedPluginNames = new Set(ownedPlugins.map((plugin) => plugin.name.toLowerCase()));
  const pluginRowNames = new Set([...ownedPluginNames, ...installedPlugins.map((plugin) => plugin.name.toLowerCase())]);
  // Connections the member made arrive with their connector plugin; list them once, under Added by you.
  const myConnectionIds = new Set(cloudConnections
    .filter((item) => ownedPluginNames.has(connectionPluginName(item.name))
      || item.edges.some((edge) => edge.kind === "mine" || (edge.kind === "person" && edge.sharedById === currentMemberId)))
    .map((item) => item.id));
  const connectionForPlugin = (name: string) => cloudConnections.find((item) => connectionPluginName(item.name) === name.toLowerCase());
  const connectMcpForPlugin = (name: string) => availableConnectMcpServers.find((entry) => entry.pluginName?.toLowerCase() === name.toLowerCase());
  const connectorGroup = (name: string): ExtensionInventoryGroup => {
    const entry = connectMcpForPlugin(name);
    const connection = connectionForPlugin(name);
    if (entry) {
      const group = connectMcpInventoryGroup(entry, props.availableConnectMcpStatuses ?? {});
      if (group !== "available" || !connection) return group;
    }
    if (!connection) return "ready";
    return connection.state === "connected" ? "ready" : connection.state;
  };
  const addedConnectorUrls = new Set([
    ...cloudConnections.map((item) => item.url),
    ...orgMcpItems.flatMap((item) => (item.orgMcpConnection ? [item.orgMcpConnection.url] : [])),
  ]);
  const orgCaption = props.organizationName?.trim()
    ? t("extensions.row_cloud_from", { source: props.organizationName.trim() })
    : t("extensions.surface_cloud");

  const rows: LibraryRow[] = [];

  for (const entry of libraryDirectoryEntries) {
    const configured = isEntryConfigured(entry);
    const enablement = props.enablementContext ? enablementForEntry(entry) : null;
    const hidden = isOpenWorkExtensionHidden(entry);
    const disabledReason = builtInDisabledReasonForEntry(entry) ?? (configured ? null : manageDisabledReasonForEntry(entry));
    const isComputerUse = entry.id === "computer-use";
    const runtimeStatus = quickConnectStatus(entry)?.status;
    const ready = isComputerUse ? enablement?.active === true : runtimeStatus ? runtimeStatus === "connected" : configured || enablement?.active;
    rows.push({
      key: getMcpIdentityKey(entry),
      section: "mac",
      taxonomy: taxonomyForDirectoryEntry(entry),
      searchText: `${entry.name} ${entry.description}`,
      node: (
        <ExtensionCard
          layout={layout}
          name={entry.name}
          description={entry.description}
          iconSlug={entry.iconSlug}
          iconSrc={entry.iconSrc}
          url={typeof entry.url === "string" ? entry.url : undefined}
          taxonomy={taxonomyForDirectoryEntry(entry)}
          connected={Boolean(ready) && !hidden && !disabledReason}
          enablement={enablement?.results}
          connecting={props.mcpConnectingName === entry.name}
          hidden={hidden}
          preview={entry.preview}
          disabledReason={disabledReason}
          disabled={props.busy}
          meta={t("extensions.row_local_you")}
          nextActionLabel={isComputerUse ? ready || disabledReason ? undefined : t("extensions.row_action_set_up") : configured || disabledReason ? undefined : t("connect.row_action_connect")}
          onClick={() => openDetail({ kind: "entry", entry })}
        />
      ),
    });
  }

  for (const server of localServers) {
    const status = resolveStatus(server);
    const group = localServerInventoryGroup(status);
    const match = resolveQuickConnectMatch(server.name);
    const name = displayName(server.name);
    const error = readMcpErrorInfo(props.mcpStatuses[server.name]);
    const attention = libraryRowAttention(group);
    rows.push({
      key: `server:${server.name}`,
      section: "mac",
      taxonomy: "mcp",
      searchText: `${server.name} ${name} ${match?.description ?? ""} ${server.config.type === "remote" ? server.config.url : server.config.command?.join(" ") ?? ""}`,
      node: (
        <ExtensionCard
          layout={layout}
          name={name}
          description={error ?? match?.description ?? localServerTypeLabel(server)}
          iconSlug={match?.iconSlug}
          iconSrc={match?.iconSrc}
          url={server.config.type === "remote" ? server.config.url : undefined}
          taxonomy="mcp"
          connected={group === "ready"}
          disabled={props.busy}
          meta={t("extensions.row_local_you")}
          statusChip={attention.statusChip}
          nextActionLabel={group === "ready" || group === "disabled" ? undefined : friendlyStatus(status)}
          onClick={() => openDetail({ kind: "server", entry: server })}
        />
      ),
    });
  }

  for (const skill of installedSkills) {
    const fromOrg = skill.origin === "openwork-connect";
    if (fromOrg && skill.pluginName && pluginRowNames.has(skill.pluginName.toLowerCase())) continue;
    if (fromOrg && ownedPluginNames.has(skill.name.toLowerCase())) continue;
    const hidden = isOpenWorkExtensionHidden(getSkillHiddenId(skill));
    rows.push({
      key: `skill:${skill.path}`,
      section: fromOrg ? "openwork" : "mac",
      taxonomy: "skill",
      searchText: `${skill.name} ${skill.description ?? ""}`,
      node: (
        <ExtensionCard
          layout={layout}
          name={skill.name}
          description={skill.description ?? t("extensions.row_skill_fallback")}
          taxonomy="skill"
          connected={!hidden}
          hidden={hidden}
          meta={fromOrg ? orgCaption : t("extensions.row_local_you")}
          onClick={() => openDetail({ kind: "skill", skill })}
        />
      ),
    });
  }

  for (const plugin of ownedPlugins) {
    const taxonomy = libraryCloudItemTaxonomy(plugin.componentKinds, plugin.componentCount);
    const audience = libraryCloud.audienceFor(plugin.id);
    const shared = isLibraryAudienceShared(audience);
    const group = taxonomy === "connection" ? connectorGroup(plugin.name) : "ready";
    const attention = libraryRowAttention(group);
    const connection = taxonomy === "connection" ? connectionForPlugin(plugin.name) : undefined;
    rows.push({
      key: `mine:${plugin.id}`,
      section: "mine",
      taxonomy,
      searchText: `${plugin.name} ${plugin.description ?? ""}`,
      node: (
        <ExtensionCard
          layout={layout}
          name={plugin.name}
          description={plugin.description ?? kindLabel(taxonomy)}
          url={connection?.url}
          taxonomy={taxonomy}
          connected={group === "ready"}
          meta={libraryOwnedCaption(audience, changedPluginIds.has(plugin.id))}
          statusChip={attention.statusChip}
          nextActionLabel={group === "needs_signin" ? attention.actionLabel : undefined}
          onNextAction={group === "needs_signin" && connection
            ? () => startConnectionSignIn(connection.id)
            : undefined}
          onClick={() => openOwnedPlugin(plugin)}
          trailing={(
            <LibraryRowMenu
              name={plugin.name}
              canEdit={taxonomy === "skill"}
              canDuplicate={taxonomy === "skill"}
              shared={shared}
              onAction={(action) => handleRowAction(plugin, action)}
            />
          )}
        />
      ),
    });
  }

  for (const entry of availableConnectMcpServers) {
    if (entry.pluginName && pluginRowNames.has(entry.pluginName.toLowerCase())) continue;
    const group = connectMcpInventoryGroup(entry, props.availableConnectMcpStatuses ?? {});
    const attention = libraryRowAttention(group);
    rows.push({
      key: `connect-mcp:${entry.id ?? entry.name}`,
      section: "openwork",
      taxonomy: "connection",
      searchText: `${entry.name} ${entry.pluginName ?? ""} ${entry.marketplaceName ?? ""}`,
      node: (
        <ExtensionCard
          layout={layout}
          name={entry.name}
          description={entry.pluginName
            ? t("extensions.row_provided_by", { source: entry.pluginName })
            : entry.marketplaceName
              ? t("extensions.row_provided_by", { source: entry.marketplaceName })
              : t("extensions.surface_cloud")}
          taxonomy="connection"
          connected={group === "ready"}
          meta={orgCaption}
          statusChip={attention.statusChip}
          nextActionLabel={attention.actionLabel}
          onClick={() => openDetail({ kind: "connect-mcp", entry })}
        />
      ),
    });
  }

  for (const plugin of installedPlugins) {
    if (libraryCloud.ownedPluginIds.has(plugin.pluginId)) continue;
    const cloudItem = libraryCloud.pluginById.get(plugin.pluginId);
    // A local copy outlives a delete or lost access until the next sync; the cloud list decides.
    if (libraryCloud.ready && !cloudItem) continue;
    const taxonomy = (cloudItem
      ? libraryCloudItemTaxonomy(cloudItem.componentKinds, cloudItem.componentCount)
      : libraryCloudItemTaxonomy(plugin.files.map((file) => file.objectType), plugin.files.length));
    const group = taxonomy === "connection" ? connectorGroup(plugin.name) : "ready";
    const attention = libraryRowAttention(group);
    const hidden = isOpenWorkExtensionHidden(`plugin:${plugin.pluginId}`);
    const fileCount = plugin.files.length;
    rows.push({
      key: `plugin:${plugin.pluginId}`,
      section: "openwork",
      taxonomy,
      searchText: [plugin.name, plugin.description ?? "", ...plugin.files.map((file) => `${file.title} ${file.objectType} ${file.path}`)].join(" "),
      node: (
        <ExtensionCard
          layout={layout}
          name={plugin.name}
          description={plugin.description ?? t(fileCount === 1 ? "extensions.row_one_capability" : "extensions.row_capabilities", { count: String(fileCount) })}
          taxonomy={taxonomy}
          connected={group === "ready" && !hidden}
          hidden={hidden}
          meta={cloudItem ? librarySharedByCaption(cloudItem, props.organizationName?.trim() || t("extensions.surface_cloud")) : orgCaption}
          statusChip={attention.statusChip}
          nextActionLabel={attention.actionLabel}
          onClick={() => openDetail({ kind: "plugin", plugin })}
        />
      ),
    });
  }

  for (const item of orgMcpItems.filter(isOrgMcpConnectionItem)) {
    const connection = item.orgMcpConnection;
    if (myConnectionIds.has(connection.id) || ownedPluginNames.has(connectionPluginName(item.name))) continue;
    const group = resolveExtensionInventoryGroup(item);
    const attention = libraryRowAttention(group);
    rows.push({
      key: item.id,
      section: "openwork",
      taxonomy: "connection",
      searchText: `${item.name} ${item.description ?? ""} ${connection.url}`,
      node: (
        <ExtensionCard
          layout={layout}
          name={item.name}
          description={item.description?.trim() || t("extensions.row_shared_connection")}
          taxonomy="connection"
          url={connection.url}
          connected={group === "ready"}
          meta={orgCaption}
          statusChip={attention.statusChip}
          nextActionLabel={attention.actionLabel}
          onClick={() => openDetail({ kind: "org-mcp", item })}
        />
      ),
    });
  }

  for (const provider of props.modelProviders ?? []) {
    const signInKey = libraryModelSignInKey(provider);
    const waiting = signInKey !== null && props.modelSignInKey === signInKey;
    const pending = provider.pending[0];
    rows.push({
      key: libraryModelDetailId(provider),
      section: provider.section,
      taxonomy: "model",
      searchText: `${provider.name} ${provider.models.map((model) => model.name).join(" ")}`,
      node: (
        <ExtensionCard
          layout={layout}
          name={provider.name}
          description={modelNamesSummary(provider.models)}
          iconSlug={provider.iconSlug ?? undefined}
          taxonomy="model"
          connected={provider.state !== "needs_signin"}
          connecting={waiting}
          meta={provider.state === "needs_signin" ? null : t("extensions.model_ready")}
          nextActionLabel={provider.state === "needs_signin" && props.onModelSignIn ? t("extensions.model_sign_in") : undefined}
          alwaysChevron
          onNextAction={pending && props.onModelSignIn ? () => props.onModelSignIn?.(pending) : undefined}
          onClick={() => openModelProvider(provider)}
        />
      ),
    });
  }

  const sharedOwned = ownedPlugins.filter((plugin) => isLibraryAudienceShared(libraryCloud.audienceFor(plugin.id)));
  const firstSharedOwned = sharedOwned[0];
  const openworkRowCount = rows.filter((row) => row.section === "openwork").length;
  const sectionMeta: Partial<Record<LibrarySection, string | null>> = {
    mine: firstSharedOwned
      ? t("extensions.section_mine_shared", { count: String(sharedOwned.length), audience: libraryAudienceName(libraryCloud.audienceFor(firstSharedOwned.id)) })
      : t("extensions.section_mine_just_me", { count: String(ownedPlugins.length) }),
    openwork: openworkRowCount > 0 ? t("extensions.section_openwork_meta", { count: String(openworkRowCount) }) : null,
  };

  const inventory = (
    <LibraryInventory
      rows={rows}
      loading={props.inventoryLoading === true}
      layout={layout}
      filter={filter}
      search={search}
      sectionMeta={sectionMeta}
      signedOut={signedOut}
      onSignUp={props.onOpenCloudAccount}
      emptyState={(
        <LibraryEmptyState
          filter={filter}
          searching={Boolean(search.trim())}
          cloudIssue={cloudIssue}
          onAdd={!addDisabledReason && libraryAddKinds[0] ? () => handleAddKind(libraryAddKinds[0]) : undefined}
          onClearSearch={() => setSearch("")}
          onOpenCloudAccount={!libraryCloudSignedIn || !activeOrganizationId ? props.onOpenCloudAccount : undefined}
          onRefresh={denAuth.status === "unavailable" || inventoryError ? props.onRefresh : undefined}
          error={inventoryError}
        />
      )}
    />
  );

  const libraryIconFor = (taxonomy: ExtensionTaxonomy) =>
    taxonomy === "skill" ? <FileText size={18} /> : taxonomy === "plugin" ? <LayoutGrid size={18} /> : <Plug size={18} />;
  const sharePlugin = screen.kind === "share" ? libraryCloud.pluginById.get(screen.pluginId) ?? null : null;
  const deleteTarget = deleteTargetId ? libraryCloud.pluginById.get(deleteTargetId) ?? null : null;
  const deleteAudience = deleteTarget ? libraryCloud.audienceFor(deleteTarget.id) : emptyLibraryAudience;
  const toList = () => setScreen({ kind: "list" });

  if (screen.kind === "create") {
    const addKind = screen.addKind;
    return (
      <AddLibraryItemPage
        kind={addKind}
        busy={props.busy}
        cloud={cloudSession.isSignedIn}
        canConfigureMcpConnections={canManageCloudConnections}
        connectorPresets={connectorPresets}
        checkMcpServer={libraryAddOptions.cloudSignedIn
          ? (url) => cloudSession.client.discoverMcpConnectionRequirements(activeOrganizationId, url)
          : undefined}
        crumbs={addKind === "mcp" ? [{ label: t("extensions.connector_catalog_title"), onClick: () => setScreen({ kind: "catalog" }) }] : undefined}
        onClose={toList}
        onCreate={(input) => handleCreateLibraryItem(addKind, input)}
      />
    );
  }
  if (screen.kind === "catalog") {
    return (
      <LibraryConnectorCatalogPage
        presets={connectorPresets}
        addedUrls={addedConnectorUrls}
        onBack={toList}
        onPick={(preset) => setScreen({ kind: "connector-setup", preset })}
        onSomethingElse={() => setScreen({ kind: "create", addKind: "mcp" })}
      />
    );
  }
  if (screen.kind === "connector-setup") {
    const preset = screen.preset;
    return (
      <LibraryConnectorSetupPage
        preset={preset}
        onBack={toList}
        onCatalog={() => setScreen({ kind: "catalog" })}
        onSubmit={(input) => handleConnectorSetup(preset, input)}
      />
    );
  }
  if (screen.kind === "share" && sharePlugin) {
    const taxonomy = libraryCloudItemTaxonomy(sharePlugin.componentKinds, sharePlugin.componentCount);
    return (
      <LibrarySharePage
        name={sharePlugin.name}
        description={sharePlugin.description}
        taxonomy={taxonomy}
        icon={libraryIconFor(taxonomy)}
        directory={libraryDirectory}
        initialAudience={libraryCloud.audienceFor(sharePlugin.id)}
        canShareOrgWide={canManageCloudConnections}
        onCancel={toList}
        onSave={(targets, audience) => shareWith(sharePlugin, targets, audience)}
      />
    );
  }
  if (screen.kind === "edit") {
    const skill = screen.skill;
    const audience = libraryCloud.audienceFor(skill.pluginId);
    return (
      <LibraryEditSkillPage
        skill={skill}
        audienceName={audienceNameOrNull(audience)}
        audiencePeople={libraryAudiencePeopleCount(audience, libraryDirectory)}
        onCancel={toList}
        onSave={(draft) => saveEdit(skill, draft)}
        onSaveCopy={async (draft) => {
          const name = t("extensions.duplicate_name", { name: draft.name });
          const pluginId = await createLibraryItem("skill", {
            name,
            description: draft.description,
            instructions: draft.instructions,
          });
          finishCreate(pluginId, { name, description: draft.description });
        }}
      />
    );
  }

  const modelDetailKey = modelDetail ?? (useRoutedDetail && props.detailId ? parseLibraryModelDetailId(props.detailId) : null);
  const modelDetailProvider = modelDetailKey ? (props.modelProviders ?? []).find((provider) => provider.key === modelDetailKey) ?? null : null;
  if (modelDetailProvider) {
    return (
      <LibraryModelPage
        provider={modelDetailProvider}
        signingInKey={props.modelSignInKey ?? null}
        onBack={closeModelDetail}
        onSignIn={props.onModelSignIn}
        onCancelSignIn={props.onCancelModelSignIn}
        onRemove={props.onRemoveModelProvider ? (providerId) => { props.onRemoveModelProvider?.(providerId); closeModelDetail(); } : undefined}
      />
    );
  }

  if (useRoutedDetail && props.detailId) {
    if (activeTarget) {
      return detailPanels;
    }
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 animate-in fade-in duration-300">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 w-fit gap-1 px-2 text-muted-foreground"
          onClick={closeDetail}
        >
          <ChevronLeft size={16} />
          {t("extensions.title")}
        </Button>
        {props.inventoryLoading === true || pendingPlugin ? (
          <p className="flex items-center gap-2 text-sm text-dls-secondary">
            <Loader2 size={14} className="animate-spin" />
            {t("extensions.detail_loading")}
          </p>
        ) : (
          <p className="text-sm text-dls-secondary">{t("extensions.detail_unavailable")}</p>
        )}
      </div>
    );
  }

  return (
    <section className="w-full animate-in fade-in duration-300">
      {props.headerActionsTarget ? createPortal(addControl, props.headerActionsTarget) : props.headerActionsTarget === undefined ? (
        <div className="mb-5 flex h-[52px] items-center justify-between border-b border-dls-border px-6">
          <h1 className="text-base leading-6 font-medium">{t("extensions.title")}</h1>
          {addControl}
        </div>
      ) : null}
      {props.builtInExtensionsDisabled && props.allowManageExtensions ? (
        <div className="mb-5 rounded-xl border border-border bg-muted/30 px-4 py-3 text-xs text-foreground">
          {t("extensions.builtins_disabled_notice")}
        </div>
      ) : null}

      {props.allowManageExtensions ? null : (
        <div
          data-testid="manage-extensions-policy-notice"
          className="mb-5 rounded-xl border border-dls-border bg-dls-hover px-4 py-4 text-xs leading-5 text-dls-secondary"
        >
          <p className="text-sm font-medium text-foreground">Your team’s tool access</p>
          <p className="mt-1">{manageExtensionsDisabledReason()}</p>
          <p className="mt-2">Need an MCP server or skill? Ask your admin to share it with your team or allow local tools in Team → Access. You can still sign in to available connections below.</p>
          {props.builtInExtensionsDisabled ? <p className="mt-2">{t("extensions.builtins_disabled_notice")}</p> : null}
        </div>
      )}

      <div className="mb-6 flex flex-wrap items-center gap-2" aria-label={t("extensions.filters_label")}>
        {extensionInventoryFilters.map((f) => {
          const selected = filter === f;
          return (
            <button
              key={f}
              type="button"
              aria-pressed={selected}
              onClick={() => setInventoryFilter(f)}
              className={`inline-flex h-[30px] items-center rounded-full border px-3 text-[13px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring ${
                selected
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-background text-muted-foreground hover:border-foreground/40 hover:text-foreground"
              }`}
            >
              {extensionFilterLabel(f)}
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-1">
          <div className="mr-1 w-[min(220px,40vw)]">
            <SettingsListSearchInput
              containerClassName="h-[30px] rounded-lg bg-background hover:bg-background"
              placeholder={t("extensions.search_placeholder")}
              aria-label={t("extensions.search_placeholder")}
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
            />
          </div>
          <ExtensionLayoutToggle
            layout={layout}
            onChange={(next) => {
              setLayout(next);
              writeExtensionLayout(next);
            }}
          />
          {props.onRefresh ? (
            <RefreshButton className="h-[30px] w-8 rounded-lg hover:bg-dls-hover" busy={props.busy} onRefresh={refreshLibrary}>
              {t("common.refresh")}
            </RefreshButton>
          ) : null}
          <LibraryStatusWarning message={props.mcpStatus} />
        </div>
      </div>

      {localServers.length > 0 && props.managedOAuthAvailable === false ? (
        <div
          data-testid="mcp-managed-oauth-unavailable"
          className="mb-4 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-foreground"
        >
          {t("mcp.managed_oauth_unavailable")}
        </div>
      ) : null}

      {inventory}

      {filter === "plugin" && props.pluginsContent ? <div className="mt-6">{props.pluginsContent}</div> : null}

      <McpAdvancedConfigSection
        open={showAdvanced}
        configScope={configScope}
        activeConfig={activeConfig}
        canRevealConfig={canRevealConfig}
        revealBusy={revealBusy}
        revealLabel={revealLabel}
        configError={configError}
        onToggle={() => setShowAdvanced((current) => !current)}
        onScopeChange={setConfigScope}
        onReveal={revealConfig}
        onAddMcp={props.allowManageExtensions ? () => handleAddKind("workspace-mcp") : undefined}
        onImportFromGithub={props.allowManageExtensions && props.previewClaudePlugin && props.installClaudePlugin ? () => setClaudeImportOpen(true) : undefined}
      />

      <ConfirmModal
        open={logoutOpen}
        title={t("mcp.logout_modal_title")}
        message={t("mcp.logout_modal_message").replace("{server}", displayName(logoutTarget ?? ""))}
        confirmLabel={logoutBusy ? t("mcp.logout_working") : t("mcp.logout_action")}
        cancelLabel={t("common.cancel")}
        variant="danger"
        onCancel={() => {
          if (logoutBusy) return;
          setLogoutOpen(false);
          setLogoutTarget(null);
        }}
        onConfirm={() => {
          void confirmLogout();
        }}
      />

      <ConfirmModal
        open={removeOpen}
        title={t("mcp.remove_modal_title")}
        message={t("mcp.remove_modal_message").replace("{server}", displayName(removeTarget ?? ""))}
        confirmLabel={t("mcp.remove_app")}
        cancelLabel={t("common.cancel")}
        variant="danger"
        onCancel={() => {
          setRemoveOpen(false);
          setRemoveTarget(null);
        }}
        onConfirm={() => {
          if (removeTarget) props.removeMcp(removeTarget);
          setRemoveOpen(false);
          setRemoveTarget(null);
        }}
      />

      <AddMcpModal
        open={addMcpModalOpen}
        onClose={() => setAddMcpModalOpen(false)}
        onAdd={props.connectMcp}
        busy={props.busy}
        isRemoteWorkspace={props.isRemoteWorkspace}
      />

      {props.allowManageExtensions && props.previewClaudePlugin && props.installClaudePlugin ? (
        <ClaudePluginImportModal
          open={claudeImportOpen}
          onClose={() => setClaudeImportOpen(false)}
          onPreview={props.previewClaudePlugin}
          onInstall={props.installClaudePlugin}
        />
      ) : null}

      <LibraryDeleteDialog
        open={deleteTarget !== null}
        name={deleteTarget?.name ?? ""}
        audienceName={audienceNameOrNull(deleteAudience)}
        audiencePeople={libraryAudiencePeopleCount(deleteAudience, libraryDirectory)}
        onCancel={() => setDeleteTargetId(null)}
        onDelete={() => {
          if (!deleteTarget) return;
          void deleteOwned(deleteTarget).catch((cause: unknown) => {
            toast.error(cause instanceof Error && cause.message.trim() ? cause.message : t("common.something_went_wrong"));
          });
        }}
        onStopSharing={() => {
          if (!deleteTarget) return;
          setDeleteTargetId(null);
          void shareWith(deleteTarget, [], emptyLibraryAudience);
        }}
      />

      {detailPanels}
    </section>
  );
}

export function connectMcpInventoryGroup(entry: McpServerEntry, statuses: McpStatusMap): ExtensionInventoryGroup {
  const status = statuses[entry.id ?? entry.name]?.status;
  if (entry.config.enabled === false || status === "disabled") return "disabled";
  if (status === "connected") return "ready";
  if (status === "needs_auth" || status === "reconnect_required") return "needs_signin";
  return "available";
}

/** A workspace server's live engine status decides whether its row says Ready or Sign in. */
export function localServerInventoryGroup(status: ReactMcpStatus): ExtensionInventoryGroup {
  switch (status) {
    case "connected":
      return "ready";
    case "needs_auth":
    case "reconnect_required":
    case "needs_client_registration":
      return "needs_signin";
    case "disabled":
      return "disabled";
    default:
      return "available";
  }
}

export function localServerTypeLabel(entry: McpServerEntry) {
  return entry.config.type === "remote" ? t("mcp.type_cloud") : t("mcp.type_local");
}

export function localServerSourceLabel(entry: McpServerEntry) {
  return entry.source === "config.global" ? t("extensions.local_this_device") : t("extensions.local_this_workspace");
}

/** Den names a connection a plugin brings "<plugin> / <server>". */
export function connectionPluginName(connectionName: string) {
  const separator = connectionName.lastIndexOf(" / ");
  return (separator > 0 ? connectionName.slice(0, separator) : connectionName).trim().toLowerCase();
}

/** The chip and button a row shows when it is not ready yet. */
export function libraryRowAttention(group: ExtensionInventoryGroup): {
  statusChip?: { label: string; tone: "attention" | "setup" };
  actionLabel?: string;
} {
  if (group === "needs_signin") {
    return { statusChip: { label: t("extensions.row_chip_sign_in"), tone: "attention" }, actionLabel: t("extensions.row_action_sign_in") };
  }
  if (group === "needs_admin_setup" || group === "available") {
    return { statusChip: { label: t("extensions.row_chip_set_up"), tone: "setup" }, actionLabel: t("extensions.row_action_set_up") };
  }
  return {};
}

/** Progress and success notes from the MCP store are information, not alerts. */
export function libraryStatusTone(message: string | null): "info" | "warning" {
  return message === t("mcp.reloading_status") || message === t("mcp.connected") ? "info" : "warning";
}

export function LibraryStatusWarning({ message }: { message: string | null }) {
  const descriptionId = useId();
  if (!message?.trim()) return null;
  const tone = libraryStatusTone(message);
  return (
    <Tooltip>
      <TooltipTrigger render={
        <Button
          variant="ghost"
          size="icon-sm"
          className={tone === "warning"
            ? "h-[30px] w-8 rounded-lg bg-amber-3 text-amber-11 hover:bg-amber-4"
            : "h-[30px] w-8 rounded-lg text-dls-secondary hover:bg-dls-hover"}
          aria-label={t("extensions.mcp_status")}
          aria-describedby={descriptionId}
        >
          {tone === "warning" ? <TriangleAlert size={15} /> : <Info size={15} />}
        </Button>
      } />
      <TooltipContent
        id={descriptionId}
        role="tooltip"
        side="bottom"
        align="end"
        className="max-w-[min(432px,calc(100vw-32px))] flex-col items-start gap-2 rounded-[8px] border border-[#e5e5e5] bg-white p-4 text-[#202020] shadow-[0_4px_12px_rgba(0,0,0,0.08),0_16px_32px_rgba(0,0,0,0.08)] [&>[aria-hidden=true]]:border-t [&>[aria-hidden=true]]:border-l [&>[aria-hidden=true]]:border-[#e5e5e5] [&>[aria-hidden=true]]:bg-white [&>[aria-hidden=true]]:fill-white"
      >
        <span className="text-sm leading-5 font-medium">{t("extensions.mcp_status")}</span>
        <span className="whitespace-pre-wrap wrap-break-word text-[13px] leading-5">{message}</span>
      </TooltipContent>
    </Tooltip>
  );
}

export function LibraryEmptyState(props: {
  filter: ExtensionInventoryFilter;
  searching: boolean;
  cloudIssue?: string;
  error?: string | null;
  onAdd?: () => void;
  onClearSearch: () => void;
  onOpenCloudAccount?: () => void;
  onRefresh?: () => void;
}) {
  const category = primaryLibraryFilter(props.filter);
  const title = props.searching
    ? t("extensions.empty_filtered_title")
    : props.error
      ? t("extensions.cloud_unavailable")
      : props.cloudIssue && category !== "all"
        ? t("extensions.cloud_library_title")
        : t(category === "skill" ? "extensions.empty_skill_title" : category === "plugin" ? "extensions.empty_plugin_title" : category === "model" ? "extensions.models_empty_title" : "extensions.empty_all_title");
  const description = props.searching
    ? t("extensions.empty_filtered_hint")
    : category === "model"
      ? t("extensions.models_empty")
      : props.error || (category !== "all" ? props.cloudIssue : undefined)
        || t(category === "skill" ? "extensions.empty_skill_hint" : category === "plugin" ? "extensions.empty_plugin_hint" : "extensions.empty_all_hint");
  const addKind = libraryAddKindsForFilter(category)[0];
  return (
    <div className="flex flex-col items-center gap-3 rounded-[10px] border border-dashed border-dls-border bg-dls-surface px-6 py-12 text-center">
      <h2 className="text-[15px] font-medium text-dls-text">{title}</h2>
      <p className="max-w-md text-[13px] text-dls-secondary">{description}</p>
      {props.searching ? (
        <Button variant="outline" onClick={props.onClearSearch}>{t("extensions.clear_filters")}</Button>
      ) : props.onRefresh ? (
        <Button variant="outline" onClick={props.onRefresh}>{t("common.refresh")}</Button>
      ) : props.onOpenCloudAccount && category !== "all" ? (
        <Button variant="outline" onClick={props.onOpenCloudAccount}>{t("extensions.open_cloud_account")}</Button>
      ) : props.onAdd && addKind ? (
        <LibraryAddControl kinds={[addKind]} onSelect={() => props.onAdd?.()} />
      ) : null}
    </div>
  );
}

/** One Library row: where it sits, what kind it reads as, and what it renders. */
export type LibraryRow = {
  key: string;
  section: LibrarySection;
  taxonomy: ExtensionTaxonomy;
  searchText: string;
  node: ReactNode;
};

const librarySectionOrder: LibrarySection[] = ["mac", "mine", "openwork"];

function librarySectionLabel(section: LibrarySection) {
  switch (section) {
    case "mac":
      return t("extensions.section_mac");
    case "mine":
      return t("extensions.section_mine");
    case "openwork":
      return t("extensions.section_openwork");
  }
}

function LibrarySectionHeader(props: { section: LibrarySection; label: string; meta?: string | null }) {
  return (
    <div className="flex items-center justify-between gap-3 px-0.5">
      <h2 className="flex items-center gap-1.5 text-[13px] font-medium text-dls-secondary">
        {props.section === "mac" ? <Laptop size={12} /> : null}
        {props.label}
      </h2>
      {props.meta ? <span data-library-section-meta={props.section} className="text-xs text-dls-secondary">{props.meta}</span> : null}
    </div>
  );
}

/** Rows a signed-out member could use after signing in, shown locked. */
const lockedLibraryPreviews: Array<{ name: string; description: string; iconSrc: string }> = [
  { name: "Google Workspace", description: "Gmail, Calendar and Drive", iconSrc: "/ext-google-workspace.svg" },
  // Simple Icons no longer ships Slack's mark, so it is bundled like the others.
  { name: "Slack", description: "Read and post in your channels", iconSrc: "/ext-slack.svg" },
  { name: "Linear", description: "Issues and projects", iconSrc: "/ext-linear.svg" },
];

/**
 * Signed out, adding to the Library needs OpenWork Cloud, so the page's one
 * primary action is signing in. It lives here, above what it unlocks, instead
 * of a header "Add to library" that could not do anything.
 */
function LibrarySignUpBanner(props: { onSignUp?: () => void }) {
  return (
    <div data-testid="library-sign-up-banner" className="flex items-center gap-4 rounded-xl border border-dls-border bg-dls-surface px-4 py-3">
      <div className="flex shrink-0 -space-x-1.5" aria-hidden>
        {lockedLibraryPreviews.map((preview) => {
          const src = resolveExtensionIconUrl({ iconSrc: preview.iconSrc });
          return (
            <span key={preview.name} className="flex size-7 items-center justify-center rounded-lg border border-dls-border bg-dls-surface">
              {src ? <img src={src} alt="" width={16} height={16} loading="lazy" className="block" /> : null}
            </span>
          );
        })}
      </div>
      <p className="min-w-0 flex-1 text-[13px] text-dls-text">{t("extensions.sign_up_banner")}</p>
      {props.onSignUp ? (
        <Button size="sm" className="shrink-0" onClick={props.onSignUp}>
          {t("extensions.sign_up_action")}
        </Button>
      ) : null}
    </div>
  );
}

export function LibraryInventory(props: {
  rows: LibraryRow[];
  loading: boolean;
  layout: ExtensionLayout;
  filter: ExtensionInventoryFilter;
  search?: string;
  sectionMeta?: Partial<Record<LibrarySection, string | null>>;
  signedOut?: boolean;
  onSignUp?: () => void;
  emptyState?: ReactNode;
}) {
  const needle = props.search?.trim().toLowerCase() ?? "";
  const category = primaryLibraryFilter(props.filter);
  const visible = props.rows.filter((row) =>
    matchesExtensionFilter(category, row.taxonomy)
    && (!needle || row.searchText.toLowerCase().includes(needle)));
  const sections = librarySectionOrder
    .map((section) => ({ section, rows: visible.filter((row) => row.section === section) }))
    .filter((entry) => entry.rows.length > 0);
  const containerClassName = props.layout === "list"
    ? "overflow-hidden rounded-xl border border-dls-border bg-dls-surface [&>div+div]:border-t [&>div+div]:border-dls-border/60"
    : "grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-3";
  const showLocked = props.signedOut === true && category === "all" && !needle;

  return (
    <div className="space-y-6">
      {props.signedOut ? <LibrarySignUpBanner onSignUp={props.onSignUp} /> : null}
      {sections.length === 0 && props.loading ? (
        <div className={props.layout === "list" ? "flex flex-col gap-2" : "grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-3"}>
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className={props.layout === "list" ? "h-[42px] rounded-lg" : "h-[104px] rounded-xl"} />
          ))}
        </div>
      ) : sections.length === 0 && !showLocked ? props.emptyState ?? null : (
        sections.map(({ section, rows }) => (
          <div key={section} className="space-y-2.5" data-library-section={section}>
            <LibrarySectionHeader section={section} label={librarySectionLabel(section)} meta={props.sectionMeta?.[section]} />
            <div className={containerClassName}>
              {rows.map((row) => (
                <div key={row.key} data-library-row-key={row.key}>{row.node}</div>
              ))}
            </div>
          </div>
        ))
      )}
      {showLocked ? (
        <div className="space-y-2.5" data-library-section="locked">
          <LibrarySectionHeader section="openwork" label={t("extensions.section_openwork_locked")} />
          <div className={containerClassName}>
            {lockedLibraryPreviews.map((preview) => (
              <div key={preview.name} className="opacity-60" data-library-locked={preview.name}>
                <ExtensionCard
                  layout={props.layout}
                  name={preview.name}
                  description={preview.description}
                  iconSrc={preview.iconSrc}
                  taxonomy="connection"
                  disabled
                  trailing={<Lock size={13} className="text-dls-secondary" aria-label={t("extensions.row_locked")} />}
                />
              </div>
            ))}
          </div>
          <p className="px-0.5 text-xs text-dls-secondary">{t("extensions.locked_more")}</p>
        </div>
      ) : null}
    </div>
  );
}

function ExtensionLayoutToggle(props: {
  layout: ExtensionLayout;
  onChange: (layout: ExtensionLayout) => void;
}) {
  const options: { layout: ExtensionLayout; label: string; icon: ReactNode }[] = [
    { layout: "grid", label: t("extensions.layout_grid"), icon: <LayoutGrid size={13} /> },
    { layout: "list", label: t("extensions.layout_list"), icon: <List size={13} /> },
  ];
  return (
    <div className="flex items-center gap-1">
      {options.map((option) => (
        <Tooltip key={option.layout}>
          <TooltipTrigger render={
            <Button
              variant={props.layout === option.layout ? "secondary" : "ghost"}
              size="icon-sm"
              className="h-[30px] w-8 rounded-full hover:bg-dls-hover"
              aria-pressed={props.layout === option.layout}
              aria-label={option.label}
              onClick={() => props.onChange(option.layout)}
            >
              {option.icon}
            </Button>
          } />
          <TooltipContent>{option.label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

function readMcpErrorInfo(status: McpStatusMap[string] | undefined) {
  if (!status || status.status !== "failed") return null;
  return "error" in status ? status.error : t("mcp.connection_failed");
}

type McpConfiguredServerDetailsProps = {
  entry: McpServerEntry;
  status: ReactMcpStatus;
  errorInfo: string | null;
  busy: boolean;
  logoutBusy: boolean;
  logoutTarget: string | null;
  togglingMcp: string | null;
  supportsOauth: (entry: McpServerEntry) => boolean;
  onAuthorize: (entry: McpServerEntry) => void;
  onRequestLogout: (name: string) => void;
  onRemove: (name: string) => void;
  onToggleEnabled?: (name: string, enabled: boolean) => Promise<void> | void;
  onToggleBusy: (value: SetStateAction<string | null>) => void;
};

/** Workspace-server management shown on the local MCP detail page. */
function McpConfiguredServerDetails(props: McpConfiguredServerDetailsProps) {
  return (
    <div className="space-y-3 rounded-xl border border-dls-border bg-dls-surface px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="rounded-md border border-dls-border bg-dls-surface px-2 py-0.5 text-[10px] font-medium text-dls-text">
          {t("mcp.cap_tools")}
        </span>
        {props.entry.config.type === "remote" ? (
          <span className="rounded-md border border-dls-border bg-dls-surface px-2 py-0.5 text-[10px] font-medium text-dls-text">
            {t("mcp.cap_signin")}
          </span>
        ) : null}
      </div>
      {props.errorInfo ? <div className="rounded-lg border border-red-6 bg-red-2 px-3 py-2 text-xs text-red-11">{props.errorInfo}</div> : null}
      {props.entry.managedOAuth?.status === "reconnect_required" && props.entry.managedOAuth.lastError ? (
        <div
          data-testid="mcp-managed-reconnect-reason"
          className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-foreground"
        >
          {props.entry.managedOAuth.lastError}
        </div>
      ) : null}
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] text-dls-secondary transition-colors hover:text-dls-text">
          <Code2 size={11} />
          {t("mcp.technical_details")}
          <ChevronDown size={10} className="transition-transform group-open:rotate-180" />
        </summary>
        <div className="mt-1.5 break-all rounded-lg bg-dls-hover px-3 py-2 font-mono text-[11px] text-dls-secondary">
          {props.entry.config.type === "remote" ? props.entry.config.url : props.entry.config.command?.join(" ")}
        </div>
      </details>
      <McpConfiguredServerAuthActions {...props} />
      <div className="flex justify-end gap-2 pt-1">
        {props.onToggleEnabled && props.entry.source !== "config.global" ? (
          <Button
            variant="outline"
            size="sm"
            disabled={props.busy || props.togglingMcp === props.entry.name}
            onClick={(event) => {
              event.stopPropagation();
              if (props.togglingMcp) return;
              const next = props.entry.config.enabled !== false ? false : true;
              props.onToggleBusy(props.entry.name);
              void Promise.resolve(props.onToggleEnabled?.(props.entry.name, next)).finally(() => props.onToggleBusy(null));
            }}
          >
            <Power size={13} />
            {props.entry.config.enabled === false ? t("mcp.enable_app") : t("mcp.disable_app")}
          </Button>
        ) : null}
        <Button
          variant="destructive"
          size="sm"
          onClick={(event) => {
            event.stopPropagation();
            props.onRemove(props.entry.name);
          }}
        >
          {t("mcp.remove_app")}
        </Button>
      </div>
    </div>
  );
}

function McpConfiguredServerAuthActions(props: McpConfiguredServerDetailsProps) {
  if (!props.supportsOauth(props.entry)) return null;
  if (props.status !== "connected") {
    return (
      <>
        <div className="flex items-center justify-between gap-3 pt-1">
          <div className="text-xs text-dls-secondary">{t("mcp.logout_label")}</div>
          <Button
            data-testid="mcp-managed-auth-action"
            size="sm"
            disabled={props.busy}
            onClick={() => props.onAuthorize(props.entry)}
          >
            {props.status === "reconnect_required" ? t("mcp.action_reconnect") : t("mcp.login_action")}
          </Button>
        </div>
        <div className="text-[11px] text-dls-secondary/70">{t("mcp.login_hint")}</div>
      </>
    );
  }
  return (
    <>
      <div className="flex items-center justify-between gap-3 pt-1">
        <div className="text-xs text-dls-secondary">{t("mcp.logout_label")}</div>
        <Button
          variant="destructive"
          size="sm"
          disabled={props.busy || props.logoutBusy}
          onClick={() => props.onRequestLogout(props.entry.name)}
        >
          {props.logoutBusy && props.logoutTarget === props.entry.name ? t("mcp.logout_working") : t("mcp.logout_action")}
        </Button>
      </div>
      <div className="text-[11px] text-dls-secondary/70">{t("mcp.logout_hint")}</div>
    </>
  );
}

export function McpAdvancedConfigSection(props: {
  open: boolean;
  configScope: ConfigScope;
  activeConfig: OpencodeConfigFile | null;
  canRevealConfig: boolean;
  revealBusy: boolean;
  revealLabel: string;
  configError: string | null;
  onToggle: () => void;
  onScopeChange: (scope: ConfigScope) => void;
  onReveal: () => Promise<void>;
  onAddMcp?: () => void;
  onImportFromGithub?: () => void;
}) {
  return (
    <div className="mt-6 overflow-hidden rounded-xl border border-dls-border bg-dls-surface">
      <button type="button" aria-expanded={props.open} className="flex w-full items-center justify-between px-5 py-4 transition-colors hover:bg-dls-hover" onClick={props.onToggle}>
        <div className="flex items-center gap-3">
          <Settings2 size={16} className="text-dls-secondary" />
          <div className="text-left">
            <div className="text-sm font-medium text-dls-text">{t("mcp.advanced_settings")}</div>
            <div className="text-xs text-dls-secondary">{t("mcp.advanced_settings_hint")}</div>
          </div>
        </div>
        <div className={`transition-transform ${props.open ? "rotate-180" : ""}`}>
          <ChevronDown size={16} className="text-dls-secondary" />
        </div>
      </button>
      {props.open ? (
        <div className="animate-in fade-in slide-in-from-top-1 space-y-4 border-t border-dls-border px-5 py-4 duration-200">
          <div className="flex flex-col gap-2">
            <div className="text-xs text-dls-secondary">{t("mcp.custom_app_cta_hint")}</div>
            <div className="flex flex-wrap items-center gap-2">
              {props.onAddMcp ? (
                <Button variant="outline" onClick={props.onAddMcp}>
                  <Plus size={14} />
                  {t("extensions.add_workspace_mcp")}
                </Button>
              ) : null}
              {props.onImportFromGithub ? (
                <Button variant="outline" onClick={props.onImportFromGithub}>
                  <Download size={14} />
                  From GitHub
                </Button>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <McpConfigScopeButton scope="project" activeScope={props.configScope} onScopeChange={props.onScopeChange} />
            <McpConfigScopeButton scope="global" activeScope={props.configScope} onScopeChange={props.onScopeChange} />
          </div>
          <div className="flex flex-col gap-1 text-xs">
            <div className="text-dls-secondary">{t("mcp.config_file")}</div>
            <div className="truncate font-mono text-[11px] text-dls-secondary/80">
              {props.activeConfig?.path ?? t("mcp.config_not_loaded")}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => void props.onReveal()} disabled={!props.canRevealConfig}>
                {props.revealBusy ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    {t("mcp.opening_label")}
                  </>
                ) : (
                  <>
                    <FolderOpen size={14} />
                    {props.revealLabel}
                  </>
                )}
              </Button>
              <a href="https://opencode.ai/docs/mcp-servers/" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-dls-secondary transition-colors hover:text-dls-text">
                {t("mcp.docs_link")}
                <ExternalLink size={11} />
              </a>
            </div>
            {props.activeConfig && props.activeConfig.exists === false ? <div className="text-[11px] text-dls-secondary">{t("mcp.file_not_found")}</div> : null}
          </div>
          {props.configError ? <div className="text-xs text-red-11">{props.configError}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function McpConfigScopeButton(props: {
  scope: ConfigScope;
  activeScope: ConfigScope;
  onScopeChange: (scope: ConfigScope) => void;
}) {
  return (
    <button
      type="button"
      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
        props.activeScope === props.scope
          ? "bg-dls-active text-dls-text"
          : "text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
      }`}
      onClick={() => props.onScopeChange(props.scope)}
    >
      {props.scope === "project" ? t("mcp.scope_project") : t("mcp.scope_global")}
    </button>
  );
}

export default McpView;
