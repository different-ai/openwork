/** @jsxImportSource react */
import { useEffect, useReducer, useRef, useState, type ReactNode, type SetStateAction } from "react";
import {
  BookOpen,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  CircleAlert,
  Cloud,
  Code2,
  CreditCard,
  Download,
  ExternalLink,
  FolderOpen,
  Globe,
  LayoutGrid,
  List,
  Loader2,
  MonitorSmartphone,
  Plug2,
  Plus,
  Power,
  Settings2,
  Unplug,
  Zap,
} from "lucide-react";

import { desktopRestrictionNotice } from "../../../../app/cloud/desktop-app-restrictions";
import { isBuiltInOpenWorkExtension, getMcpServerName, type McpDirectoryInfo } from "../../../../app/constants";
import { evaluateEnablement } from "../../../../app/enablement";
import type { EnablementResult } from "../../../../app/extensions";
import type { CloudImportedPlugin, CloudImportedPluginFile } from "../../../../app/cloud/import-state";
import { ExtensionCard, type ExtensionLayout } from "../../../design-system/extension-card";
import { ExtensionDetailModal } from "../../../design-system/extension-detail-modal";
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
  matchesExtensionFilter,
  taxonomyForDirectoryEntry,
  type ExtensionInventoryFilter,
  type ExtensionInventoryState,
} from "../extension-taxonomy";
import { SettingsGroupHeader, RefreshButton } from "../settings-section";
import { SettingsListSearchInput } from "../settings-list";
import {
  openDesktopUrl,
  openDesktopPath,
  readOpencodeConfig,
  revealDesktopItemInDir,
  type OpencodeConfigFile,
} from "../../../../app/lib/desktop";
import { readDenSettings, type DenExternalMcpPreset } from "../../../../app/lib/den";
import {
  getMcpIdentityKey,
  normalizeMcpSlug,
} from "../../../../app/mcp";
import type { McpServerEntry, McpStatusMap } from "../../../../app/types";
import { formatRelativeTime, isDesktopRuntime, isWindowsPlatform } from "../../../../app/utils";
import { t } from "../../../../i18n";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmModal } from "../../../design-system/modals/confirm-modal";
import { isConnectDirectMcpServerName } from "../../connections/cloud-mcp-user-state";
import { AddMcpModal } from "../../connections/modals/add-mcp-modal";
import type { McpConnectResult } from "../../connections/store";
import { ClaudePluginImportModal } from "../../connections/modals/claude-plugin-import-modal";
import {
  canDisconnectMemberConnection,
  canDisconnectNativeProviderAccount,
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
  slugifyLibraryItemName,
  type CreateLibraryItemInput,
  type LibraryAddKind,
  type LibraryAgentItem,
  type LibraryAuthorableKind,
  type LibraryCommandItem,
} from "../library";
import { AddLibraryItemModal } from "./add-library-item-modal";
import { LibraryAddControl } from "./library-add-control";
import { libraryConnectorCues } from "../library-connector-cues";
import {
  denAddUrl,
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
  selectedMcp: string | null;
  setSelectedMcp: (name: string | null) => void;
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
};

const builtInExtensionDisabledReason = () => t("extensions.disabled_by_organization");
const manageExtensionsDisabledReason = () => desktopRestrictionNotice("allowManageExtensions");

const statusDot = (status: ReactMcpStatus) => {
  switch (status) {
    case "connected":
      return "bg-green-9";
    case "needs_auth":
    case "reconnect_required":
    case "needs_client_registration":
      return "bg-amber-9";
    case "disabled":
      return "bg-gray-8";
    case "disconnected":
      return "bg-gray-7";
    default:
      return "bg-red-9";
  }
};

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

const statusBadgeStyle = (status: ReactMcpStatus) => {
  switch (status) {
    case "connected":
      return "bg-green-3 text-green-11";
    case "needs_auth":
    case "reconnect_required":
    case "needs_client_registration":
      return "bg-amber-3 text-amber-11";
    case "disabled":
    case "disconnected":
      return "bg-gray-3 text-gray-11";
    default:
      return "bg-red-3 text-red-11";
  }
};

const serviceIcon = (name: string) => {
  const lower = name.toLowerCase();
  if (lower.includes("notion")) return BookOpen;
  if (lower.includes("linear")) return Zap;
  if (lower.includes("sentry")) return CircleAlert;
  if (lower.includes("stripe")) return CreditCard;
  if (lower.includes("context")) return Globe;
  if (lower.includes("devtools")) {
    return MonitorSmartphone;
  }
  if (lower.includes("openwork") && lower.includes("cloud")) return Cloud;
  if (lower.includes("openwork") && lower.includes("ui")) return MonitorSmartphone;
  return Plug2;
};

const serviceColor = (name: string) => {
  const lower = name.toLowerCase();
  if (lower.includes("notion")) return "text-gray-12";
  if (lower.includes("linear")) return "text-blue-11";
  if (lower.includes("sentry")) return "text-purple-11";
  if (lower.includes("stripe")) return "text-blue-11";
  if (lower.includes("context")) return "text-green-11";
  if (lower.includes("devtools")) {
    return "text-amber-11";
  }
  if (lower.includes("openwork")) return "text-gray-12";
  return "text-dls-secondary";
};

const serviceIconBg = (name: string) => {
  const lower = name.toLowerCase();
  if (lower.includes("notion")) return "bg-gray-3 border-gray-6";
  if (lower.includes("linear")) return "bg-blue-3 border-blue-6";
  if (lower.includes("sentry")) return "bg-purple-3 border-purple-6";
  if (lower.includes("stripe")) return "bg-blue-3 border-blue-6";
  if (lower.includes("context")) return "bg-green-3 border-green-6";
  if (lower.includes("devtools")) {
    return "bg-amber-3 border-amber-6";
  }
  if (lower.includes("openwork")) return "bg-gray-3 border-gray-6";
  return "bg-dls-hover border-dls-border";
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

export function McpView(props: McpViewProps) {
  const cloudSession = useCloudSession();
  const denAuth = useDenAuth();
  const denBaseUrl = readDenSettings().baseUrl;
  const skillCount = props.installedSkills?.length ?? 0;
  const useRoutedDetail = typeof props.onDetailIdChange === "function";
  const [detailTarget, setDetailTarget] = useState<ExtensionDetailTarget | null>(null);
  const [mcpConnectFailure, setMcpConnectFailure] = useState<{ id: string; message: string } | null>(null);
  const [pendingPlugin, setPendingPlugin] = useState<CloudImportedPlugin | null>(null);
  const [detailSkillContent, setDetailSkillContent] = useState<string | null>(null);
  const [openworkUiMcpCommand, setOpenworkUiMcpCommand] = useState<string[] | null>(null);
  const [openworkUiMcpEnvironment, setOpenworkUiMcpEnvironment] = useState<Record<string, string> | null>(null);
  const [computerUseMcpCommand, setComputerUseMcpCommand] = useState<string[] | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ExtensionInventoryFilter>(props.initialFilter ?? "all");
  const [inventoryState, setInventoryState] = useState<ExtensionInventoryState>(props.initialState ?? "all");
  const [inventoryStateCounts, setInventoryStateCounts] = useState<InventoryStateCounts>({
    needs_signin: 0,
    needs_admin_setup: 0,
    ready: 0,
  });
  const [showHidden, setShowHidden] = useState(false);
  const [layout, setLayout] = useState<ExtensionLayout>(readExtensionLayout);
  const [claudeImportOpen, setClaudeImportOpen] = useState(false);
  const [addAuthorableKind, setAddAuthorableKind] = useState<LibraryAuthorableKind | null>(null);
  const [connectorPresets, setConnectorPresets] = useState<DenExternalMcpPreset[]>([]);
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
  useEffect(() => {
    let current = true;
    if (!libraryCloudSignedIn || !activeOrganizationId) {
      setConnectorPresets([]);
      return () => {
        current = false;
      };
    }

    setConnectorPresets([]);
    void cloudSession.client.listMcpConnectionPresets(activeOrganizationId)
      .then((presets) => {
        if (current) setConnectorPresets(presets);
      })
      .catch(() => {
        if (current) setConnectorPresets([]);
      });

    return () => {
      current = false;
    };
  }, [activeOrganizationId, cloudSession.client, libraryCloudSignedIn]);
  const connectorCues = libraryConnectorCues(connectorPresets);
  const libraryAddOptions = {
    cloudSignedIn: libraryCloudSignedIn,
    allowManageExtensions: props.allowManageExtensions,
  };
  const libraryAddKinds = libraryAddKindsForFilter(filter).filter((kind) => (
    libraryAddAction(kind, libraryAddOptions) !== null
  ));
  const skillAddPending = filter === "skill"
    && !libraryCloudSignedIn
    && denAuth.status === "checking"
    && Boolean(cloudSession.authToken.trim())
    && Boolean(cloudSession.activeOrganization?.id.trim());
  const handleAddKind = (kind: LibraryAddKind) => {
    const action = libraryAddAction(kind, libraryAddOptions);
    if (!action) return;
    if (action.type === "workspace-mcp") {
      setAddMcpModalOpen(true);
      return;
    }
    if (action.type === "den-url") {
      const url = denAddUrl(denBaseUrl, action.kind);
      if (url) void openDesktopUrl(url);
      return;
    }
    setAddAuthorableKind(action.kind);
  };
  const handleCreateLibraryItem = async (input: CreateLibraryItemInput) => {
    if (!addAuthorableKind || !props.createLibraryItem) {
      throw new Error(t("common.something_went_wrong"));
    }
    const createdId = await props.createLibraryItem(addAuthorableKind, input);
    const pendingFiles = addAuthorableKind === "plugin"
      ? (input.components ?? []).map((component, index) => ({
        configObjectId: `pending:${index}`,
        objectType: component.kind,
        title: component.name.trim(),
        path: "",
        versionId: null,
        updatedAt: null,
        skillName: component.kind === "skill" ? slugifyLibraryItemName(component.name, "skill") : undefined,
      }))
      : [{
        configObjectId: "pending",
        objectType: addAuthorableKind,
        title: input.name.trim(),
        path: "",
        versionId: null,
        updatedAt: null,
        skillName: addAuthorableKind === "skill" ? slugifyLibraryItemName(input.name, "skill") : undefined,
      }];
    setPendingPlugin({
      pluginId: createdId,
      marketplaceId: null,
      name: input.name.trim(),
      description: input.description.trim() || null,
      updatedAt: null,
      files: pendingFiles,
      importedAt: Date.now(),
    });
    props.onDetailIdChange?.(`plugin:${createdId}`);
    void props.onLibraryListsRefresh?.();
    return createdId;
  };
  const setInventoryStateFilter = (nextState: ExtensionInventoryState) => {
    setInventoryState(nextState);
    props.onStateChange?.(nextState, filter);
  };

  const closeDetail = () => {
    setDetailTarget(null);
    setPendingPlugin(null);
    setDetailSkillContent(null);
    setMcpConnectFailure(null);
    props.onDetailIdChange?.(null);
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
    const nextState = props.initialState ?? "all";
    setInventoryState(nextState);
    if (nextState === "all") {
      setFilter(props.initialFilter ?? "all");
    }
  }, [props.initialFilter, props.initialState]);

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

  // Auto-configured built-ins like openwork-cloud remain active but hidden from
  // Your apps until Show hidden reveals the row for disable/remove. Projected
  // direct org connections are shown through their OpenWork Connect card.
  const visibleMcpServers = inventoryState === "all" && (filter === "all" || filter === "mcp")
    ? showHidden
      ? props.mcpServers
      : props.mcpServers.filter((entry) => {
          if (isConnectDirectMcpServerName(entry.name)) return false;
          const match = resolveQuickConnectMatch(entry.name);
          return !match || !isOpenWorkExtensionHidden(match);
        })
    : [];

  const displayName = (name: string) => resolveQuickConnectMatch(name)?.name ?? name;

  const quickConnectStatus = (entry: McpDirectoryInfo) =>
    props.mcpStatuses[getMcpIdentityKey(entry)];

  const isQuickConnectConfigured = (entry: McpDirectoryInfo) =>
    props.mcpServers.some((server) => server.name === getMcpIdentityKey(entry));

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

  const hiddenCount = quickConnectList.filter((entry) => isOpenWorkExtensionHidden(entry)).length +
    props.mcpServers.filter((entry) => isConnectDirectMcpServerName(entry.name)).length +
    (props.installedSkills ?? []).filter((skill) => isOpenWorkExtensionHidden(getSkillHiddenId(skill))).length +
    (props.installedPlugins ?? []).filter((plugin) => isOpenWorkExtensionHidden(`plugin:${plugin.pluginId}`)).length;
  const policyHiddenBuiltInCount = props.builtInExtensionsDisabled
    ? quickConnectList.filter((entry) => isBuiltInOpenWorkExtension(entry) && !isOpenWorkExtensionHidden(entry)).length
    : 0;
  const hiddenOrPolicyCount = hiddenCount + policyHiddenBuiltInCount;

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
          configSlot={openInDenAction({ id: detailConnectMcp.id ?? detailConnectMcp.name })}
        />
      ) : null}

      {detailPlugin ? (() => {
        const hidden = isOpenWorkExtensionHidden(`plugin:${detailPlugin.pluginId}`);
        const marketplaceName = detailPlugin.files.find((file) => file.marketplaceName)?.marketplaceName;
        return (
          <ExtensionDetailModal
            open={!!detailPlugin}
            onClose={closeDetail}
            presentation={detailPresentation}
            backLabel={t("extensions.title")}
            name={detailPlugin.name}
            description={detailPlugin.description ?? "Organization extension installed in this workspace."}
            taxonomy="plugin"
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
        return (
          <ExtensionDetailModal
            open={true}
            onClose={closeDetail}
            presentation={detailPresentation}
            backLabel={t("extensions.title")}
            name={detailOrgMcpItem.name}
            description={detailOrgMcpItem.description ?? orgMcpConnectionActionLabel(connection)}
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
                label: t("extensions.detail_fact_account"),
                value: connection.credentialMode === "shared" ? "Org account" : "Your account",
              },
            ]}
            connectLabel={orgMcpConnectionActionLabel(connection)}
            reconnectLabel={t("mcp.org_connection_reconnect_action")}
            onConnect={!ready && canAuthorize && props.connectOrgMcp ? () => props.connectOrgMcp?.(connection.id) : undefined}
            onReconnect={ready && canAuthorize && props.reconnectOrgMcp ? () => props.reconnectOrgMcp?.(connection.id) : undefined}
            onUninstall={canDisconnect && props.disconnectOrgMcp ? () => props.disconnectOrgMcp?.(connection.id) : undefined}
            uninstallLabel={t("mcp.org_connection_disconnect_action")}
            closeOnUninstall={false}
            showEnablementCard={false}
            configSlot={(
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                  <span className="rounded-full border border-dls-border bg-dls-hover px-2 py-1 text-xs text-dls-secondary">Shared by your organization</span>
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

  if (useRoutedDetail && props.detailId) {
    if (activeTarget) {
      return detailPanels;
    }
    return (
      <div className="flex w-full max-w-3xl flex-col gap-6 animate-in fade-in duration-300">
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
    <section className="w-full max-w-3xl animate-in fade-in duration-300">
      {props.mcpStatus ? (
        <div className="mb-5 whitespace-pre-wrap wrap-break-word rounded-xl border border-dls-border bg-dls-hover px-4 py-3 text-xs text-dls-secondary">
          {props.mcpStatus}
        </div>
      ) : null}

      {props.builtInExtensionsDisabled && props.allowManageExtensions ? (
        <div className="mb-5 rounded-xl border border-amber-6 bg-amber-2 px-4 py-3 text-xs text-amber-11">
          Built-in OpenWork extensions are disabled by your organization. Use Show hidden to review blocked built-ins.
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
          {props.builtInExtensionsDisabled ? <p className="mt-2">Built-in OpenWork extensions are disabled by your organization. Use Show hidden to review blocked built-ins.</p> : null}
        </div>
      )}

      {libraryAddKinds.length > 0 || skillAddPending ? (
        <div className="mb-5 flex justify-end">
          <LibraryAddControl
            kinds={skillAddPending ? ["skill"] : libraryAddKinds}
            connectorCues={connectorCues}
            pending={skillAddPending}
            onSelect={handleAddKind}
          />
        </div>
      ) : null}

      <div className="mb-5">
        <ExtensionStateTabs
          state={inventoryState}
          needsSigninCount={inventoryStateCounts.needs_signin}
          needsAdminSetupCount={inventoryStateCounts.needs_admin_setup}
          readyCount={inventoryStateCounts.ready}
          onChange={setInventoryStateFilter}
        />
      </div>

      <div className="mb-7 flex flex-wrap items-center gap-2" aria-label="Library filters">
        <div className="w-full sm:w-[220px]">
          <SettingsListSearchInput
            containerClassName="bg-background hover:bg-background"
            placeholder="Search your library"
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
          />
        </div>
        {extensionInventoryFilters.map((f) => {
          const selected = filter === f;
          return (
            <button
              key={f}
              type="button"
              aria-pressed={selected}
              onClick={() => setInventoryFilter(f)}
              className={`inline-flex h-[26px] items-center rounded-full border px-3 text-[12px] font-medium transition-colors ${
                selected
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-background text-muted-foreground hover:border-foreground/40 hover:text-foreground"
              }`}
            >
              {extensionFilterLabel(f)}
            </button>
          );
        })}
        <button
          type="button"
          aria-pressed={showHidden}
          onClick={() => setShowHidden((current) => !current)}
          className={`inline-flex h-[26px] items-center rounded-full border px-3 text-[12px] font-medium transition-colors ${
            showHidden
              ? "border-foreground bg-foreground text-background"
              : "border-border bg-background text-muted-foreground hover:border-foreground/40 hover:text-foreground"
          }`}
        >
          {showHidden ? "Showing hidden" : hiddenOrPolicyCount > 0 ? `Show hidden (${hiddenOrPolicyCount})` : "Show hidden"}
        </button>
        <div className="ml-auto flex items-center gap-1">
          <ExtensionLayoutToggle
            layout={layout}
            onChange={(next) => {
              setLayout(next);
              writeExtensionLayout(next);
            }}
          />
          {props.onRefresh ? (
            <RefreshButton busy={props.busy} onRefresh={props.onRefresh}>
              {t("common.refresh")}
            </RefreshButton>
          ) : null}
        </div>
      </div>

      <McpQuickConnectSection
        skillCount={skillCount}
        entries={
          quickConnectList.filter((entry) => {
            if (!showHidden && (isOpenWorkExtensionHidden(entry) || (props.builtInExtensionsDisabled && isBuiltInOpenWorkExtension(entry)))) return false;
            if (!matchesExtensionFilter(
              filter,
              taxonomyForDirectoryEntry(entry),
              entry.kind === "mcp" ? "mcp" : null,
            )) return false;
            if (!search.trim()) return true;
            const q = search.toLowerCase();
            return entry.name.toLowerCase().includes(q) || entry.description.toLowerCase().includes(q);
          })
        }
        installedSkills={
          installedSkills.filter((skill) => {
            if (!showHidden && isOpenWorkExtensionHidden(getSkillHiddenId(skill))) return false;
            if (!matchesExtensionFilter(filter, "skill")) return false;
            if (!search.trim()) return true;
            const q = search.toLowerCase();
            return skill.name.toLowerCase().includes(q) || (skill.description ?? "").toLowerCase().includes(q);
          })
        }
        installedCommands={
          (props.installedCommands ?? []).filter((command) => {
            if (!matchesExtensionFilter(filter, "command")) return false;
            if (!search.trim()) return true;
            const q = search.toLowerCase();
            return command.name.toLowerCase().includes(q) || (command.description ?? "").toLowerCase().includes(q);
          })
        }
        installedAgents={
          (props.installedAgents ?? []).filter((agent) => {
            if (!matchesExtensionFilter(filter, "agent")) return false;
            if (!search.trim()) return true;
            const q = search.toLowerCase();
            return agent.name.toLowerCase().includes(q) || (agent.description ?? "").toLowerCase().includes(q);
          })
        }
        availableConnectMcpServers={
          availableConnectMcpServers.filter((entry) => {
            if (!matchesExtensionFilter(filter, "connection", "mcp")) return false;
            if (!search.trim()) return true;
            const query = search.toLowerCase();
            return [
              entry.name,
              entry.marketplaceName ?? "",
              entry.pluginName ?? "",
            ].join(" ").toLowerCase().includes(query);
          })
        }
        availableConnectMcpStatuses={props.availableConnectMcpStatuses ?? {}}
        loading={props.inventoryLoading === true}
        layout={layout}
        filter={filter}
        state={inventoryState}
        onStateCountsChange={setInventoryStateCounts}
        installedPlugins={
          installedPlugins.filter((plugin) => {
            if (!showHidden && isOpenWorkExtensionHidden(`plugin:${plugin.pluginId}`)) return false;
            if (!matchesExtensionFilter(filter, "plugin")) return false;
            if (!search.trim()) return true;
            const q = search.toLowerCase();
            return [plugin.name, plugin.description ?? "", ...plugin.files.map((file) => `${file.title} ${file.objectType} ${file.path}`)]
              .join(" ")
              .toLowerCase()
              .includes(q);
          })
        }
        orgMcpItems={
          orgMcpItems.filter((item) => {
            if (!isOrgMcpConnectionItem(item)) return false;
            if (!matchesExtensionFilter(
              filter,
              "connection",
              item.orgMcpConnection.nativeProviderKey == null ? "mcp" : "native",
            )) return false;
            if (!search.trim()) return true;
            const q = search.toLowerCase();
            return [item.name, item.description ?? "", item.orgMcpConnection.url].join(" ").toLowerCase().includes(q);
          })
        }
        organizationName={props.organizationName}
        busy={props.busy}
        connectingName={props.mcpConnectingName}
        isEntryHidden={(entry) => isOpenWorkExtensionHidden(entry)}
        isSkillHidden={(skill) => isOpenWorkExtensionHidden(getSkillHiddenId(skill))}
        isPluginHidden={(plugin) => isOpenWorkExtensionHidden(`plugin:${plugin.pluginId}`)}
        disabledReasonForEntry={(entry) =>
          builtInDisabledReasonForEntry(entry)
            ?? (isEntryConfigured(entry) ? null : manageDisabledReasonForEntry(entry))
        }
        isConfigured={isEntryConfigured}
        enablementForEntry={props.enablementContext ? enablementForEntry : undefined}
        statusForEntry={quickConnectStatus}
        onConnect={async (entry) => {
          setMcpConnectFailure(null);
          const result = await props.connectMcp(entry);
          if (result.ok) return;
          openDetail({ kind: "entry", entry });
          setMcpConnectFailure({
            id: getMcpIdentityKey(entry),
            message: result.error.trim() ? result.error : t("mcp.connect_failed"),
          });
        }}
        onDetail={(entry) => openDetail({ kind: "entry", entry })}
        onSkillDetail={(skill) => openDetail({ kind: "skill", skill })}
        onCommandDetail={(command) => openDetail({ kind: "command", command })}
        onAgentDetail={(agent) => openDetail({ kind: "agent", agent })}
        onConnectMcpDetail={(entry) => openDetail({ kind: "connect-mcp", entry })}
        onPluginDetail={(plugin) => openDetail({ kind: "plugin", plugin })}
        onOrgMcpDetail={(item) => openDetail({ kind: "org-mcp", item })}
        orgMcpDisconnectingId={props.orgMcpDisconnectingId ?? null}
        disconnectOrgMcp={props.disconnectOrgMcp}
        filtersActive={Boolean(search.trim()) || filter !== "all" || inventoryState !== "all"}
      />

      {visibleMcpServers.length > 0 ? (
      <McpConfiguredServersSection
        servers={visibleMcpServers}
        statuses={props.mcpStatuses}
        managedOAuthUnavailable={props.managedOAuthAvailable === false}
        lastUpdatedAt={props.mcpLastUpdatedAt}
        selectedMcp={props.selectedMcp}
        busy={props.busy}
        logoutBusy={logoutBusy}
        logoutTarget={logoutTarget}
        togglingMcp={togglingMcp}
        displayName={displayName}
        resolveStatus={resolveStatus}
        supportsOauth={supportsOauth}
        onSelect={props.setSelectedMcp}
        onAuthorize={props.authorizeMcp}
        onRequestLogout={requestLogout}
        onRemove={(name) => {
          setRemoveTarget(name);
          setRemoveOpen(true);
        }}
        onToggleEnabled={props.setMcpEnabled}
        onToggleBusy={setTogglingMcp}
      />
      ) : null}

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
        onAddMcp={props.allowManageExtensions ? () => setAddMcpModalOpen(true) : undefined}
        onImportFromGithub={
          props.allowManageExtensions && props.previewClaudePlugin && props.installClaudePlugin
            ? () => setClaudeImportOpen(true)
            : undefined
        }
      />

      <AddMcpModal
        open={addMcpModalOpen}
        onClose={() => setAddMcpModalOpen(false)}
        onAdd={props.connectMcp}
        busy={props.busy}
        isRemoteWorkspace={props.isRemoteWorkspace}
      />

      <AddLibraryItemModal
        open={addAuthorableKind !== null}
        kind={addAuthorableKind}
        busy={props.busy}
        cloud={cloudSession.isSignedIn}
        canConfigureMcpConnections={isConnectAdminRole(cloudSession.activeOrganization?.role)}
        onClose={() => setAddAuthorableKind(null)}
        onCreate={handleCreateLibraryItem}
      />

      {props.allowManageExtensions && props.previewClaudePlugin && props.installClaudePlugin ? (
        <ClaudePluginImportModal
          open={claudeImportOpen}
          onClose={() => setClaudeImportOpen(false)}
          onPreview={props.previewClaudePlugin}
          onInstall={props.installClaudePlugin}
        />
      ) : null}

      {detailPanels}
    </section>
  );
}

const inventoryGroupOrder: ExtensionInventoryGroup[] = [
  "needs_signin",
  "needs_admin_setup",
  "ready",
  "available",
  "disabled",
];

function inventoryGroupLabel(group: ExtensionInventoryGroup) {
  switch (group) {
    case "needs_signin":
      return t("connect.group_needs_signin");
    case "needs_admin_setup":
      return t("connect.group_needs_admin_setup");
    case "ready":
      return t("connect.group_ready");
    case "available":
      return t("extensions.group_ready_to_set_up");
    case "disabled":
      return t("extensions.disabled_by_organization");
  }
}

function connectMcpInventoryGroup(entry: McpServerEntry, statuses: McpStatusMap): ExtensionInventoryGroup {
  return statuses[entry.id ?? entry.name]?.status === "connected" ? "ready" : "needs_signin";
}

type InventoryStateCounts = Record<Exclude<ExtensionInventoryState, "all">, number>;

export function countInventoryCardGroups(groups: ExtensionInventoryGroup[]): InventoryStateCounts {
  return {
    needs_signin: groups.filter((group) => group === "needs_signin").length,
    needs_admin_setup: groups.filter((group) => group === "needs_admin_setup").length,
    ready: groups.filter((group) => group === "ready").length,
  };
}

export function filterInventoryCardsByState<T extends { group: ExtensionInventoryGroup }>(
  cards: T[],
  state: Exclude<ExtensionInventoryState, "all">,
) {
  return cards.filter((card) => card.group === state);
}

export function ExtensionStateTabs(props: {
  state: ExtensionInventoryState;
  needsSigninCount: number;
  needsAdminSetupCount: number;
  readyCount: number;
  onChange: (state: ExtensionInventoryState) => void;
}) {
  const tabs = [
    { state: "all", label: t("extensions.state_all"), count: null, countClassName: "" },
    {
      state: "needs_signin",
      label: t("extensions.state_needs_signin"),
      count: props.needsSigninCount,
      countClassName: "bg-amber-3 text-amber-11",
    },
    {
      state: "needs_admin_setup",
      label: t("extensions.state_needs_admin_setup"),
      count: props.needsAdminSetupCount,
      countClassName: "bg-red-3 text-red-11",
    },
    {
      state: "ready",
      label: t("connect.group_ready"),
      count: props.readyCount,
      countClassName: "bg-gray-3 text-gray-11",
    },
  ] satisfies Array<{
    state: ExtensionInventoryState;
    label: string;
    count: number | null;
    countClassName: string;
  }>;

  return (
    <div className="flex flex-wrap gap-6 border-b border-dls-border" role="tablist" aria-label="Library state">
      {tabs.filter((tab) => tab.state === "all" || tab.count !== 0).map((tab) => {
        const active = props.state === tab.state;
        return (
          <button
            key={tab.state}
            type="button"
            role="tab"
            aria-selected={active}
            className={`-mb-px inline-flex items-center gap-2 border-b-2 px-0.5 pb-2.5 text-[13px] font-medium transition-colors ${
              active
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => props.onChange(tab.state)}
          >
            <span>{tab.label}</span>
            {tab.count === null ? null : (
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${tab.countClassName}`}>
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

type InventoryCard = {
  key: string;
  group: ExtensionInventoryGroup;
  node: ReactNode;
};

const orgConnectionSigninBoilerplate = "Available from your organization. Connect your own account to use it.";

function orgMcpCardDescription(item: ExtensionItem, state: ExtensionInventoryState) {
  const description = item.description?.trim() ?? "";
  if (state !== "needs_signin" || !description.includes(orgConnectionSigninBoilerplate)) {
    return description || "Shared by your organization.";
  }
  return description
    .replace(orgConnectionSigninBoilerplate, "")
    .replace(/\s+—\s*$/, "")
    .trim() || "Shared connection";
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
        <Button
          key={option.layout}
          variant={props.layout === option.layout ? "secondary" : "outline"}
          size="xs"
          aria-pressed={props.layout === option.layout}
          aria-label={option.label}
          title={option.label}
          onClick={() => props.onChange(option.layout)}
        >
          {option.icon}
        </Button>
      ))}
    </div>
  );
}

function McpQuickConnectSection(props: {
  skillCount: number;
  entries: McpDirectoryInfo[];
  installedSkills?: SkillItem[];
  installedCommands?: LibraryCommandItem[];
  installedAgents?: LibraryAgentItem[];
  availableConnectMcpServers?: McpServerEntry[];
  availableConnectMcpStatuses: McpStatusMap;
  loading: boolean;
  layout: ExtensionLayout;
  filter: ExtensionInventoryFilter;
  state: ExtensionInventoryState;
  onStateCountsChange: (counts: InventoryStateCounts) => void;
  installedPlugins?: CloudImportedPlugin[];
  orgMcpItems?: ExtensionItem[];
  organizationName?: string | null;
  busy: boolean;
  connectingName: string | null;
  isEntryHidden: (entry: McpDirectoryInfo) => boolean;
  isSkillHidden: (skill: SkillItem) => boolean;
  isPluginHidden: (plugin: CloudImportedPlugin) => boolean;
  disabledReasonForEntry: (entry: McpDirectoryInfo) => string | null;
  isConfigured: (entry: McpDirectoryInfo) => boolean;
  enablementForEntry?: (entry: McpDirectoryInfo) => { active: boolean; results: EnablementResult[] } | null;
  statusForEntry: (entry: McpDirectoryInfo) => { status: ReactMcpStatus } | undefined;
  onConnect: (entry: McpDirectoryInfo) => void;
  onDetail: (entry: McpDirectoryInfo) => void;
  onSkillDetail?: (skill: SkillItem) => void;
  onCommandDetail?: (command: LibraryCommandItem) => void;
  onAgentDetail?: (agent: LibraryAgentItem) => void;
  onConnectMcpDetail?: (entry: McpServerEntry) => void;
  onPluginDetail?: (plugin: CloudImportedPlugin) => void;
  onOrgMcpDetail?: (item: ExtensionItem) => void;
  orgMcpDisconnectingId: string | null;
  disconnectOrgMcp?: (connectionId: string) => void;
  filtersActive?: boolean;
}) {
  const orgMeta = props.organizationName?.trim()
    ? t("extensions.from_org", { org: props.organizationName.trim() })
    : t("extensions.surface_cloud");

  const cards: InventoryCard[] = [];

  for (const entry of props.entries) {
    const configured = props.isConfigured(entry);
    const enablement = props.enablementForEntry?.(entry);
    const connecting = props.connectingName === entry.name;
    const hidden = props.isEntryHidden(entry);
    const disabledReason = props.disabledReasonForEntry(entry);
    const entryUrl = typeof entry.url === "string" ? entry.url : undefined;
    const group: ExtensionInventoryGroup = disabledReason
      ? "disabled"
      : configured || enablement?.active
        ? "ready"
        : "available";
    cards.push({
      key: getMcpIdentityKey(entry),
      group,
      node: (
        <ExtensionCard
          layout={props.layout}
          name={entry.name}
          description={entry.description}
          iconSlug={entry.iconSlug}
          iconSrc={entry.iconSrc}
          url={entryUrl}
          taxonomy={taxonomyForDirectoryEntry(entry)}
          connected={configured}
          enablement={enablement?.results}
          connecting={connecting}
          hidden={hidden}
          preview={entry.preview}
          disabledReason={disabledReason}
          disabled={props.busy}
          meta={t("extensions.surface_this_device")}
          actionLabel={configured ? "View details" : t("mcp.tap_to_connect")}
          nextActionLabel={configured || disabledReason ? undefined : t("connect.row_action_connect")}
          onClick={() => props.onDetail(entry)}
        />
      ),
    });
  }

  for (const skill of props.installedSkills ?? []) {
    const hidden = props.isSkillHidden(skill);
    const fromOrg = skill.origin === "openwork-connect";
    cards.push({
      key: `skill:${skill.path}`,
      group: "ready",
      node: (
        <ExtensionCard
          layout={props.layout}
          name={skill.name}
          description={skill.description ?? "Installed skill"}
          taxonomy="skill"
          connected={true}
          connectedLabel={fromOrg ? t("connect.row_chip_ready") : undefined}
          hidden={hidden}
          meta={fromOrg ? orgMeta : t("extensions.surface_this_device")}
          actionLabel="View details"
          onClick={() => props.onSkillDetail?.(skill)}
        />
      ),
    });
  }

  for (const command of props.installedCommands ?? []) {
    cards.push({
      key: `command:${command.id}`,
      group: "ready",
      node: (
        <ExtensionCard
          layout={props.layout}
          name={`/${command.name}`}
          description={command.description ?? "Slash command"}
          taxonomy="command"
          connected={true}
          meta={t("extensions.surface_this_device")}
          actionLabel="View details"
          onClick={() => props.onCommandDetail?.(command)}
        />
      ),
    });
  }

  for (const agent of props.installedAgents ?? []) {
    cards.push({
      key: `agent:${agent.name}`,
      group: "ready",
      node: (
        <ExtensionCard
          layout={props.layout}
          name={agent.name}
          description={agent.description ?? "Session agent"}
          taxonomy="agent"
          connected={true}
          meta={t("extensions.surface_this_device")}
          actionLabel="View details"
          onClick={() => props.onAgentDetail?.(agent)}
        />
      ),
    });
  }

  for (const entry of props.availableConnectMcpServers ?? []) {
    const status = props.availableConnectMcpStatuses[entry.id ?? entry.name]?.status;
    const ready = status === "connected";
    cards.push({
      key: `connect-mcp:${entry.id ?? entry.name}`,
      group: connectMcpInventoryGroup(entry, props.availableConnectMcpStatuses),
      node: (
        <ExtensionCard
          layout={props.layout}
          name={entry.name}
          description={
            entry.pluginName
              ? `Provided by ${entry.pluginName}${entry.marketplaceName ? ` · ${entry.marketplaceName}` : ""}.`
              : entry.marketplaceName
                ? `Provided by ${entry.marketplaceName}.`
                : t("extensions.surface_cloud")
          }
          taxonomy="connection"
          connected={ready}
          connectedLabel={ready ? t("connect.row_chip_ready") : undefined}
          meta={orgMeta}
          actionLabel="View details"
          nextActionLabel={ready ? undefined : t("mcp.login_action")}
          onClick={() => props.onConnectMcpDetail?.(entry)}
        />
      ),
    });
  }

  for (const plugin of props.installedPlugins ?? []) {
    const hidden = props.isPluginHidden(plugin);
    const fileCount = plugin.files.length;
    cards.push({
      key: `plugin:${plugin.pluginId}`,
      group: "ready",
      node: (
        <ExtensionCard
          layout={props.layout}
          name={plugin.name}
          description={plugin.description ?? (fileCount === 1 ? "1 capability" : `${fileCount} capabilities`)}
          taxonomy="plugin"
          connected={true}
          hidden={hidden}
          meta={orgMeta}
          actionLabel="View details"
          onClick={() => props.onPluginDetail?.(plugin)}
        />
      ),
    });
  }

  for (const item of (props.orgMcpItems ?? []).filter(isOrgMcpConnectionItem)) {
    const connection = item.orgMcpConnection;
    const canDisconnect = canDisconnectNativeProviderAccount(connection);
    const disconnecting = props.orgMcpDisconnectingId === connection.id;
    const group = resolveExtensionInventoryGroup(item);
    cards.push({
      key: item.id,
      group,
      node: (
        <div className="space-y-2">
          <ExtensionCard
            layout={props.layout}
            name={item.name}
            description={orgMcpCardDescription(item, props.state)}
            taxonomy="connection"
            url={connection.url}
            connected={group === "ready"}
            connectedLabel={orgMcpConnectionActionLabel(connection)}
            beta
            meta={orgMeta}
            actionLabel={disconnecting ? t("mcp.org_connection_disconnecting_action") : "View details"}
            nextActionLabel={group === "needs_signin" ? t("mcp.login_action") : undefined}
            onClick={() => props.onOrgMcpDetail?.(item)}
          />
          {canDisconnect ? (
            <Button
              size="sm"
              variant="destructive"
              className="w-full"
              disabled={disconnecting}
              onClick={() => props.disconnectOrgMcp?.(connection.id)}
            >
              {disconnecting ? t("mcp.org_connection_disconnecting_action") : t("mcp.org_connection_disconnect_action")}
            </Button>
          ) : null}
        </div>
      ),
    });
  }

  const stateCounts = countInventoryCardGroups(cards.map((card) => card.group));
  useEffect(() => {
    props.onStateCountsChange(stateCounts);
  }, [props.onStateCountsChange, stateCounts.needs_signin, stateCounts.needs_admin_setup, stateCounts.ready]);

  const grouped = inventoryGroupOrder
    .map((group) => ({ group, cards: cards.filter((card) => card.group === group) }))
    .filter((entry) => entry.cards.length > 0);
  const stateCards = props.state === "all"
    ? []
    : filterInventoryCardsByState(cards, props.state);
  const hasCards = props.state === "all" ? grouped.length > 0 : stateCards.length > 0;
  const organizationName = props.organizationName?.trim() || "your organization";
  const stateCaption = props.state === "needs_signin"
    ? t("extensions.state_needs_signin_caption", { org: organizationName })
    : props.state === "needs_admin_setup"
      ? t("extensions.state_needs_admin_setup_caption", { org: organizationName })
      : null;
  const cardContainerClassName = props.layout === "list"
    ? "overflow-hidden rounded-xl border border-dls-border bg-dls-surface [&>div+div]:border-t [&>div+div]:border-dls-border/60"
    : "grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-3";

  return (
    <div className="space-y-6">
      {stateCaption ? <p className="text-sm text-dls-secondary">{stateCaption}</p> : null}
      {!hasCards && props.loading ? (
        <div className={props.layout === "list" ? "flex flex-col gap-2" : "grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-3"}>
          {[0, 1, 2].map((index) => (
            <Skeleton
              key={index}
              className={props.layout === "list" ? "h-[42px] rounded-lg" : "h-[104px] rounded-xl"}
            />
          ))}
        </div>
      ) : !hasCards ? (
        <div className="rounded-[10px] border border-dashed border-dls-border bg-dls-surface px-6 py-12 text-center">
          <p className="text-[15px] font-medium text-dls-text">
            {props.filtersActive ? t("extensions.empty_filtered_title") : t("extensions.empty_title")}
          </p>
          <p className="mt-2 text-[13px] text-dls-secondary">
            {props.filter === "connection"
              ? props.organizationName?.trim()
                ? t("extensions.empty_connections", { org: props.organizationName.trim() })
                : t("extensions.empty_connections_signed_out")
              : props.filtersActive
                ? t("extensions.empty_filtered_hint")
                : t("extensions.empty_hint")}
          </p>
        </div>
      ) : props.state === "all" ? (
        grouped.map(({ group, cards: groupCards }) => (
          <div key={group} className="space-y-4">
            <SettingsGroupHeader
              label={inventoryGroupLabel(group)}
              count={groupCards.length}
              hint={group === "available" ? t("extensions.group_ready_to_set_up_hint") : undefined}
            />
            {/* List mode: one quiet container per readiness group, rows divided by hairlines. */}
            <div className={cardContainerClassName}>
              {groupCards.map((card) => (
                <div key={card.key} data-inventory-group={card.group}>{card.node}</div>
              ))}
            </div>
          </div>
        ))
      ) : (
        <div className={cardContainerClassName}>
          {stateCards.map((card) => (
            <div key={card.key} data-inventory-group={card.group}>{card.node}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function McpConfiguredServersSection(props: {
  servers: McpServerEntry[];
  statuses: McpStatusMap;
  managedOAuthUnavailable: boolean;
  lastUpdatedAt: number | null;
  selectedMcp: string | null;
  busy: boolean;
  logoutBusy: boolean;
  logoutTarget: string | null;
  togglingMcp: string | null;
  displayName: (name: string) => string;
  resolveStatus: (entry: McpServerEntry) => ReactMcpStatus;
  supportsOauth: (entry: McpServerEntry) => boolean;
  onSelect: (name: string | null) => void;
  onAuthorize: (entry: McpServerEntry) => void;
  onRequestLogout: (name: string) => void;
  onRemove: (name: string) => void;
  onToggleEnabled?: (name: string, enabled: boolean) => Promise<void> | void;
  onToggleBusy: (value: SetStateAction<string | null>) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-widest text-dls-secondary">
          {t("extensions.mcp_servers_section")}
        </h3>
        {props.lastUpdatedAt ? (
          <span className="tabular-nums text-[11px] text-dls-secondary">
            {t("mcp.last_synced")} {formatRelativeTime(props.lastUpdatedAt)}
          </span>
        ) : null}
      </div>

      {props.managedOAuthUnavailable ? (
        <div
          data-testid="mcp-managed-oauth-unavailable"
          className="rounded-lg border border-amber-6 bg-amber-2 px-3 py-2 text-xs text-amber-11"
        >
          {t("mcp.managed_oauth_unavailable")}
        </div>
      ) : null}

      {props.servers.length ? (
        <div className="space-y-2">
          {props.servers.map((entry) => (
            <McpConfiguredServerRow
              key={entry.name}
              entry={entry}
              status={props.resolveStatus(entry)}
              errorInfo={readMcpErrorInfo(props.statuses[entry.name])}
              selected={props.selectedMcp === entry.name}
              busy={props.busy}
              logoutBusy={props.logoutBusy}
              logoutTarget={props.logoutTarget}
              togglingMcp={props.togglingMcp}
              displayName={props.displayName}
              supportsOauth={props.supportsOauth}
              onSelect={props.onSelect}
              onAuthorize={props.onAuthorize}
              onRequestLogout={props.onRequestLogout}
              onRemove={props.onRemove}
              onToggleEnabled={props.onToggleEnabled}
              onToggleBusy={props.onToggleBusy}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-dls-border px-5 py-10 text-center">
          <Unplug size={24} className="mx-auto mb-3 text-dls-secondary/30" />
          <div className="text-sm font-medium text-dls-secondary">{t("mcp.no_apps_yet")}</div>
          <div className="mt-1 text-xs text-dls-secondary/60">{t("mcp.no_apps_hint")}</div>
        </div>
      )}
    </div>
  );
}

function readMcpErrorInfo(status: McpStatusMap[string] | undefined) {
  if (!status || status.status !== "failed") return null;
  return "error" in status ? status.error : t("mcp.connection_failed");
}

function McpConfiguredServerRow(props: {
  entry: McpServerEntry;
  status: ReactMcpStatus;
  errorInfo: string | null;
  selected: boolean;
  busy: boolean;
  logoutBusy: boolean;
  logoutTarget: string | null;
  togglingMcp: string | null;
  displayName: (name: string) => string;
  supportsOauth: (entry: McpServerEntry) => boolean;
  onSelect: (name: string | null) => void;
  onAuthorize: (entry: McpServerEntry) => void;
  onRequestLogout: (name: string) => void;
  onRemove: (name: string) => void;
  onToggleEnabled?: (name: string, enabled: boolean) => Promise<void> | void;
  onToggleBusy: (value: SetStateAction<string | null>) => void;
}) {
  const Icon = serviceIcon(props.entry.name);
  return (
    <div className={`rounded-xl border transition-all ${props.selected ? "border-blue-7 bg-blue-2 shadow-sm" : "border-dls-border bg-dls-surface hover:bg-dls-hover"}`}>
      <button type="button" className="w-full px-4 py-3.5 text-left" onClick={() => props.onSelect(props.selected ? null : props.entry.name)}>
        <div className="flex items-center gap-3">
          <div className={`flex size-8 shrink-0 items-center justify-center rounded-lg border ${props.status === "connected" ? "border-green-6 bg-green-3" : serviceIconBg(props.entry.name)}`}>
            <Icon size={15} className={props.status === "connected" ? "text-green-11" : serviceColor(props.entry.name)} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-dls-text">{props.displayName(props.entry.name)}</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className={`size-2 rounded-full ${statusDot(props.status)}`} />
            <span className="text-[11px] text-dls-secondary">{friendlyStatus(props.status)}</span>
          </div>
          <div className={`transition-transform ${props.selected ? "rotate-180" : ""}`}>
            <ChevronDown size={14} className="text-dls-secondary/40" />
          </div>
        </div>
      </button>

      {props.selected ? <McpConfiguredServerDetails {...props} /> : null}
    </div>
  );
}

function McpConfiguredServerDetails(props: Parameters<typeof McpConfiguredServerRow>[0]) {
  return (
    <div className="animate-in fade-in slide-in-from-top-1 space-y-3 border-t border-blue-6/20 px-4 py-3 duration-200">
      <div className="flex items-center gap-4 text-xs">
        <span className="text-dls-secondary">{t("mcp.connection_type")}</span>
        <span className="text-dls-text">{props.entry.config.type === "remote" ? t("mcp.type_cloud") : t("mcp.type_local")}</span>
      </div>
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
          className="rounded-lg border border-amber-6 bg-amber-2 px-3 py-2 text-xs text-amber-11"
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

function McpConfiguredServerAuthActions(props: Parameters<typeof McpConfiguredServerRow>[0]) {
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

function McpAdvancedConfigSection(props: {
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
    <div className="overflow-hidden rounded-xl border border-dls-border bg-dls-surface">
      <button type="button" className="flex w-full items-center justify-between px-5 py-4 transition-colors hover:bg-dls-hover" onClick={props.onToggle}>
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
                  {t("mcp.add_modal_title")}
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
