/** @jsxImportSource react */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Agent } from "@opencode-ai/sdk/v2/client";
import { AppWindowMac, Cloud, Monitor, ArrowUp, Check, ChevronDown, ChevronRight, FileText, LoaderCircle, Paperclip, Plus, RefreshCw, Settings, Square, Terminal, X, Zap } from "lucide-react";
import fuzzysort from "fuzzysort";
import { toast } from "@/components/ui/sonner";
import type { CloudImportedPlugin, CloudImportedPluginFile } from "@/app/cloud/import-state";
import type { ComposerAttachment, McpServerEntry, McpStatus, McpStatusMap, ModelOption, ModelRef, SkillCard, SlashCommandOption } from "@/app/types";
import { t } from "@/i18n";
import { useComposerStateStore } from "../composer-state-store";
import {
  composerConfigureSectionForMenu,
  isLibraryCommand,
  slugifyLibraryItemName,
  type ComposerSettingsSection,
} from "@/react-app/domains/settings/library";
import { ModelSelect } from "@/components/model-select";
import { LexicalPromptEditor, syncAttachmentChipStatus, type LexicalPromptEditorHandle } from "./editor";
import { listRunningAppsForMention } from "./app-mentions";
import { COMPUTER_MENTIONS } from "./computer-mentions";
import type { ComposerMentionKind } from "./mention-encoding";
import {
  connectSkillSlashCommandOptions,
  getSlashCommandQuery,
  skillMenuSlashCommandName,
  skillSlashCommandName,
  type ComposerSlashCommandOption,
} from "./slash-command";
import { encodeConnectSkillToken } from "./connect-skill-token";
import { FILE_URL_RE, HTTP_URL_RE, type PastedTextChip } from "./pasted-text";
import { loadSessionConnectCapabilities } from "@/react-app/domains/connections/cloud-inventory-cache";
import { useOrgMcpConnections } from "@/react-app/domains/connections/use-org-mcp-connections";
import {
  composerConnectionSignIn,
  mergeComposerConnectionInventory,
} from "./composer-connections";
import { DevProfiler } from "@/react-app/shell/dev-profiler";

type MentionItem = {
  id: string;
  kind: ComposerMentionKind;
  value: string;
  label: string;
  description?: string;
};

type ToolMenuSection = "agents" | "commands" | "skills" | "connections" | "plugins" | `plugin:${string}`;

type ComposerProps = {
  draft: string;
  mentions: Record<string, ComposerMentionKind>;
  onDraftChange: (value: string) => void;
  onSend: () => void | Promise<void>;
  onSteer: () => void | Promise<void>;
  onQueue: () => void | Promise<void>;
  onStop: () => void | Promise<void>;
  busy: boolean;
  steering: boolean;
  submissionPreparing: boolean;
  queuedCount: number;
  disabled: boolean;
  modelUnavailable?: boolean;
  modelUnavailableMessage?: string | null;
  organizationModelsEmpty?: boolean;
  statusLabel: string;
  modelPickerOpen: boolean;
  selectedModel: ModelRef;
  modelOptions?: readonly ModelOption[];
  /** When set, the full model picker opened from here targets this session. */
  sessionId?: string;
  openWorkModelsEntitled?: boolean;
  openWorkModelsSyncing?: boolean;
  onRefreshOrganizationModels?: () => void | Promise<void>;
  onModelPickerOpenChange: (open: boolean) => void;
  onModelChange: (model: ModelRef, variant?: string | null) => void;
  attachments: ComposerAttachment[];
  onAttachFiles: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
  attachmentsEnabled: boolean;
  /** True while the draft's attachments are being compressed/uploaded during a send; chips show a spinner overlay. */
  attachmentsUploading?: boolean;
  attachmentsDisabledReason: string | null;
  modelVariantLabel: string;
  modelVariant: string | null;
  modelBehaviorOptions?: { value: string | null; label: string }[];
  onModelVariantChange: (value: string | null) => void;
  agentLabel: string;
  selectedAgent: string | null;
  listAgents: () => Promise<Agent[]>;
  onSelectAgent: (agent: string | null) => void;
  listCommands: () => Promise<SlashCommandOption[]>;
  listSkills?: () => Promise<SkillCard[]>;
  skills?: SkillCard[];
  listMcp?: () => Promise<{ servers: McpServerEntry[]; statuses: McpStatusMap; status: string | null }>;
  mcpServers?: McpServerEntry[];
  mcpStatus?: string | null;
  mcpStatuses?: McpStatusMap;
  listImportedPlugins?: () => Promise<CloudImportedPlugin[]>;
  importedPlugins?: CloudImportedPlugin[];
  onOpenSettingsSection?: (section: ComposerSettingsSection) => void;
  recentFiles: string[];
  searchFiles: (query: string) => Promise<string[]>;
  onInsertMention: (kind: ComposerMentionKind, value: string) => void;
  /** Sent-prompt history (oldest first) recalled with ArrowUp/ArrowDown (#2012). */
  inputHistory?: string[];
  onPasteText: (text: string) => void;
  onUnsupportedFileLinks: (links: string[]) => void;
  pastedText: PastedTextChip[];
  onExpandPastedText: (id: string) => void;
  onRemovePastedText: (id: string) => void;
  isRemoteWorkspace: boolean;
  isSandboxWorkspace: boolean;
  onUploadInboxFiles?: ((files: File[]) => void | Promise<unknown>) | null;
  draftScopeKey?: string;
  compactTopSpacing?: boolean;
  /** Render inline in a page (new-task hero): no sticky dock chrome or inner max-width, aligning with sibling content. */
  flush?: boolean;
  topAccessory?: ReactNode;
  runModeControl?: ReactNode;
};

const FLUSH_PROMPT_EVENT = "openwork:flushPromptDraft";
const FOCUS_PROMPT_EVENT = "openwork:focusPrompt";
const DEFAULT_AGENT_NAME = "openwork";

function isNonDefaultAgent(agent: Agent) {
  return agent.name !== DEFAULT_AGENT_NAME;
}

/**
 * Extract external file/URL drops from a clipboard. Only used when the user
 * drag-drops a file reference from another app (Finder / browser), which sets
 * the text/uri-list MIME type explicitly. Plain text pastes — even ones that
 * contain absolute paths like "/Users/..." — are NEVER treated as links here
 * because that intercepted real text pastes and made composer paste feel
 * broken. Plain text goes straight into the editor via Lexical's default.
 */
function parseClipboardUriList(clipboard: DataTransfer) {
  const raw = clipboard.getData("text/uri-list") ?? "";
  if (!raw.trim()) return [];
  const links: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!FILE_URL_RE.test(trimmed) && !HTTP_URL_RE.test(trimmed)) continue;
    const normalized = encodeURI(trimmed);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    links.push(normalized);
  }
  return links;
}

function isImageAttachment(attachment: ComposerAttachment) {
  return attachment.kind === "image" || attachment.mimeType.startsWith("image/");
}

function isLocalCapability(origin: SkillCard["origin"] | McpServerEntry["origin"]) {
  return origin !== "openwork-connect";
}

function formatPluginObjectType(type: string) {
  const normalized = type.trim().toLowerCase();
  if (!normalized) return "File";
  if (normalized === "mcp") return "MCP";
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}

function isToolMenuPluginsSection(section: ToolMenuSection) {
  return section === "plugins" || section.startsWith("plugin:");
}

function mcpEntryStatus(entry: McpServerEntry, statuses: McpStatusMap | undefined) {
  if (!statuses) return undefined;
  if (entry.id && statuses[entry.id]) return statuses[entry.id];
  return statuses[entry.name];
}

function toolMenuMcpStatusLabel(status: McpStatus | undefined) {
  if (!status) return null;
  switch (status.status) {
    case "connected":
      return t("mcp.friendly_status_ready");
    case "disabled":
      return t("mcp.friendly_status_paused");
    case "needs_auth":
      return t("mcp.friendly_status_needs_signin");
    case "reconnect_required":
      return t("mcp.friendly_status_reconnect_required");
    case "failed":
    case "needs_client_registration":
      return t("mcp.friendly_status_issue");
  }
}

type ToolMenuLayout = {
  left: number;
  bottom: number;
  width: number;
  maxHeight: number;
};

function measureToolMenuLayout(trigger: HTMLElement): ToolMenuLayout {
  const rect = trigger.getBoundingClientRect();
  const gap = 12;
  const width = Math.min(window.innerWidth - 40, 544);
  const header = trigger.closest("main")?.querySelector("header");
  const headerBottom = header instanceof HTMLElement ? header.getBoundingClientRect().bottom : 0;
  const ceiling = Math.max(headerBottom, 8);
  const maxHeight = Math.max(180, Math.min(520, rect.top - gap - ceiling));
  const left = Math.min(Math.max(16, rect.left), Math.max(16, window.innerWidth - width - 16));
  const bottom = window.innerHeight - rect.top + gap;
  return { left, bottom, width, maxHeight };
}

function pluginSlashCommandName(file: CloudImportedPluginFile) {
  const path = file.path.trim();
  if (file.objectType === "command") {
    const command = path.match(/^\.opencode\/(?:command|commands)\/(.+)\.md$/i)?.[1];
    return command?.trim() || null;
  }
  if (file.objectType === "skill") {
    const skill = path.match(/^\.opencode\/(?:skill|skills)\/(?:[^/]+\/)?([^/]+)\/SKILL\.md$/i)?.[1];
    return skill?.trim() || null;
  }
  return null;
}

export const ReactSessionComposer = memo(function ReactSessionComposer(props: ComposerProps) {
  let fileInput: HTMLInputElement | undefined;
  const orgMcp = useOrgMcpConnections();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [refreshingOrganizationModels, setRefreshingOrganizationModels] = useState(false);
  const [commands, setCommands] = useState<SlashCommandOption[]>([]);
  const [commandsLoading, setCommandsLoading] = useState(false);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skills, setSkills] = useState<SkillCard[]>(props.skills ?? []);
  const [importedPlugins, setImportedPlugins] = useState<CloudImportedPlugin[]>(props.importedPlugins ?? []);
  const [pluginsLoading, setPluginsLoading] = useState(false);
  const [slashOpen, setSlashOpen] = useState(false);
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  const [toolMenuLayout, setToolMenuLayout] = useState<ToolMenuLayout | null>(null);
  const [toolMenuSection, setToolMenuSection] = useState<ToolMenuSection>("commands");
  const [mentionItems, setMentionItems] = useState<MentionItem[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const menuItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const commandsCacheRef = useRef<SlashCommandOption[] | null>(null);
  const commandsRequestRef = useRef<Promise<SlashCommandOption[]> | null>(null);
  const skillsRequestRef = useRef<Promise<SkillCard[]> | null>(null);
  const commandsLoadVersionRef = useRef(0);
  const listCommandsRef = useRef(props.listCommands);
  const listSkillsRef = useRef(props.listSkills);
  const listImportedPluginsRef = useRef(props.listImportedPlugins);
  const listMcpRef = useRef(props.listMcp);
  const toolMenuLoadRef = useRef({
    openId: 0,
    commands: false,
    skills: false,
    plugins: false,
    mcps: false,
  });
  const [commandsLoaded, setCommandsLoaded] = useState(false);
  const [skillsLoaded, setSkillsLoaded] = useState(Boolean(props.skills?.length));
  const [pluginsLoaded, setPluginsLoaded] = useState(Boolean(props.importedPlugins?.length));
  const [mcpLoaded, setMcpLoaded] = useState(Boolean(props.mcpServers?.length));
  const [mcpLoading, setMcpLoading] = useState(false);
  const [agentMenuIndex, setAgentMenuIndex] = useState(0);
  const agentItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [dropzoneActive, setDropzoneActive] = useState(false);
  const toolMenuRef = useRef<HTMLDivElement | null>(null);
  const toolMenuPanelRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<LexicalPromptEditorHandle | null>(null);
  const agentMenuRef = useRef<HTMLDivElement | null>(null);
  // IME composition guard: while an IME composition is active, we must not
  // treat Enter as a submit. Three signals keep this reliable across WebKit,
  // Chrome, and Safari: event.isComposing, event.keyCode === 229, and the
  // compositionstart/compositionend events below.
  const imeComposingRef = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef(props.draft);
  useEffect(() => {
    draftRef.current = props.draft;
  }, [props.draft]);

  // Follow-up message UX (only relevant while the agent is busy):
  // - Enter (and the send button) queues the message until the agent finishes.
  // - Cmd/Ctrl+Enter sends immediately (the agent adjusts mid-task, aka "steer").
  // - Escape arms a "Hit Escape again to stop the agent" prompt for 3s;
  //   a second Escape within that window stops the agent.
  const [escapeArmed, setEscapeArmed] = useState(false);
  const escapeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disarmEscape = useCallback(() => {
    if (escapeTimerRef.current) {
      clearTimeout(escapeTimerRef.current);
      escapeTimerRef.current = null;
    }
    setEscapeArmed(false);
  }, []);

  // Reset the escape-to-stop prompt whenever the agent stops being busy.
  useEffect(() => {
    if (!props.busy) disarmEscape();
  }, [props.busy, disarmEscape]);

  useEffect(() => {
    if (props.steering && props.modelPickerOpen) {
      props.onModelPickerOpenChange(false);
    }
  }, [props.modelPickerOpen, props.onModelPickerOpenChange, props.steering]);

  const handleRefreshOrganizationModels = useCallback(async () => {
    if (!props.onRefreshOrganizationModels || refreshingOrganizationModels) return;

    setRefreshingOrganizationModels(true);
    try {
      await props.onRefreshOrganizationModels();
    } catch {
      toast.error(t("models.refresh_organization_models_failed"));
    } finally {
      setRefreshingOrganizationModels(false);
    }
  }, [props.onRefreshOrganizationModels, refreshingOrganizationModels]);

  // Input history recall (#2012): ArrowUp on an empty composer recalls the
  // previous sent prompt; repeated ArrowUp/ArrowDown walk the history.
  // Editing the recalled text exits recall mode, and ArrowDown past the
  // newest entry restores whatever was typed before recall started.
  const historyPosRef = useRef<number | null>(null);
  const historyExpectedRef = useRef<string | null>(null);
  const historyStashRef = useRef("");

  useEffect(() => {
    if (historyPosRef.current === null) return;
    if (props.draft !== historyExpectedRef.current) {
      historyPosRef.current = null;
      historyExpectedRef.current = null;
    }
  }, [props.draft]);

  useEffect(() => () => {
    if (escapeTimerRef.current) clearTimeout(escapeTimerRef.current);
  }, []);

  // Editor submit (Enter). While idle this sends normally; while busy
  // Enter queues until the agent finishes, and Cmd/Ctrl+Enter steers.
  const handleEditorSubmit = useCallback((options: { queue: boolean }) => {
    const hasContent = props.draft.trim().length > 0 || props.attachments.length > 0;
    if (!hasContent) return;
    if (props.submissionPreparing) return;
    if (props.busy) {
      if (options.queue) void props.onSteer();
      else void props.onQueue();
      return;
    }
    void props.onSend();
  }, [props.busy, props.draft, props.attachments, props.onSend, props.onSteer, props.onQueue, props.submissionPreparing]);

  const slashCommandQuery = getSlashCommandQuery(props.draft);
  const slashOpenNext = slashCommandQuery !== null;
  const slashQuery = slashCommandQuery ?? "";
  const mentionMatch = props.draft.match(/@([^\s@]*)$/);
  const mentionOpenNext = Boolean(mentionMatch);
  const mentionQuery = mentionMatch?.[1] ?? "";
  const nonDefaultAgents = useMemo(() => agents.filter(isNonDefaultAgent), [agents]);
  const showAgentPicker = props.selectedAgent !== null;

  useEffect(() => {
    setSlashOpen(slashOpenNext);
    setMenuIndex(0);
  }, [slashOpenNext, slashQuery]);

  useEffect(() => {
    setMentionOpen(mentionOpenNext);
    setMenuIndex(0);
  }, [mentionOpenNext, mentionQuery]);

  useEffect(() => {
    if (!agentMenuOpen && !(toolMenuOpen && toolMenuSection === "agents")) return;
    void props.listAgents().then(setAgents).catch(() => setAgents([]));
  }, [agentMenuOpen, toolMenuOpen, toolMenuSection, props.listAgents]);

  useEffect(() => {
    if (!showAgentPicker) setAgentMenuOpen(false);
  }, [showAgentPicker]);

  useEffect(() => {
    let cancelled = false;
    void props.listAgents().then((next) => {
      if (!cancelled) setAgents(next);
    }).catch(() => {
      if (!cancelled) setAgents([]);
    });
    return () => {
      cancelled = true;
    };
  }, [props.listAgents]);

  useEffect(() => {
    setSkills(props.skills ?? []);
  }, [props.skills]);

  useEffect(() => {
    setImportedPlugins(props.importedPlugins ?? []);
  }, [props.importedPlugins]);

  useEffect(() => {
    listCommandsRef.current = props.listCommands;
  }, [props.listCommands]);

  useEffect(() => {
    listSkillsRef.current = props.listSkills;
  }, [props.listSkills]);

  useEffect(() => {
    listImportedPluginsRef.current = props.listImportedPlugins;
  }, [props.listImportedPlugins]);

  useEffect(() => {
    listMcpRef.current = props.listMcp;
  }, [props.listMcp]);

  useEffect(() => {
    setAgentMenuIndex(0);
  }, [agentMenuOpen]);

  useEffect(() => {
    const target = agentItemRefs.current[agentMenuIndex];
    target?.scrollIntoView({ block: "nearest" });
  }, [agentMenuIndex, agentMenuOpen]);

  useEffect(() => {
    commandsLoadVersionRef.current += 1;
    commandsCacheRef.current = null;
    commandsRequestRef.current = null;
  }, [props.listCommands]);

  const loadCommands = useCallback(() => {
    if (commandsCacheRef.current !== null) {
      return Promise.resolve(commandsCacheRef.current);
    }
    if (commandsRequestRef.current) {
      return commandsRequestRef.current;
    }
    const version = commandsLoadVersionRef.current;
    const request = listCommandsRef.current().then((next) => {
      if (commandsLoadVersionRef.current === version) {
        commandsCacheRef.current = next;
      }
      return next;
    }).finally(() => {
      if (commandsLoadVersionRef.current === version) {
        commandsRequestRef.current = null;
      }
    });
    commandsRequestRef.current = request;
    return request;
  }, []);

  const loadSkills = useCallback(() => {
    if (skillsRequestRef.current) return skillsRequestRef.current;
    const listSkills = listSkillsRef.current;
    if (!listSkills) return Promise.resolve([]);
    const request = listSkills().finally(() => {
      if (skillsRequestRef.current === request) skillsRequestRef.current = null;
    });
    skillsRequestRef.current = request;
    return request;
  }, []);

  useEffect(() => {
    if (!toolMenuOpen) return;
    toolMenuLoadRef.current = {
      openId: toolMenuLoadRef.current.openId + 1,
      commands: false,
      skills: false,
      plugins: false,
      mcps: false,
    };
    setCommandsLoaded(false);
    setSkillsLoaded(Boolean(props.skills?.length));
    setPluginsLoaded(Boolean(props.importedPlugins?.length));
    setMcpLoaded(Boolean(props.mcpServers?.length));
  }, [toolMenuOpen]);

  useEffect(() => {
    if (!slashOpen && !toolMenuOpen) return;
    const openId = toolMenuLoadRef.current.openId;
    if (toolMenuOpen && toolMenuLoadRef.current.commands) return;
    if (toolMenuOpen) toolMenuLoadRef.current.commands = true;
    let cancelled = false;
    const cached = commandsCacheRef.current;
    if (cached !== null) {
      setCommands(cached);
      setCommandsLoading(false);
      if (toolMenuOpen && toolMenuLoadRef.current.openId === openId) setCommandsLoaded(true);
      return () => {
        cancelled = true;
      };
    }
    setCommandsLoading(true);
    void loadCommands()
      .then((next) => {
        if (!cancelled) {
          setCommands(next);
          if (toolMenuOpen && toolMenuLoadRef.current.openId === openId) setCommandsLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCommands([]);
          if (toolMenuOpen && toolMenuLoadRef.current.openId === openId) setCommandsLoaded(true);
        }
      })
      .finally(() => {
        if (!cancelled) setCommandsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slashOpen, toolMenuOpen, loadCommands]);

  useEffect(() => {
    if (!mentionOpen) return;
    let cancelled = false;
    setMentionItems(COMPUTER_MENTIONS);
    void Promise.all([props.listAgents(), props.searchFiles(mentionQuery), listRunningAppsForMention()]).then(([agentList, files, apps]) => {
      if (cancelled) return;
      const recent = props.recentFiles.slice(0, 8);
      const next: MentionItem[] = [
        ...COMPUTER_MENTIONS,
        ...agentList.map((agent) => ({ id: `agent:${agent.name}`, kind: "agent" as const, value: agent.name, label: agent.name })),
        ...recent.map((file) => ({ id: `file:${file}`, kind: "file" as const, value: file, label: file })),
        // Running macOS apps (Computer Use targets). Listed after recent files
        // so an empty "@" stays file-first; fuzzy search surfaces them as the
        // user types (e.g. "@mus" → Music).
        ...apps.map((appName) => ({ id: `app:${appName}`, kind: "app" as const, value: appName, label: appName })),
        ...files.filter((file) => !recent.includes(file)).map((file) => ({ id: `file:${file}`, kind: "file" as const, value: file, label: file })),
      ];
      setMentionItems(next);
    }).catch(() => {
      if (!cancelled) setMentionItems(COMPUTER_MENTIONS);
    });
    return () => {
      cancelled = true;
    };
  }, [mentionOpen, mentionQuery, props.listAgents, props.recentFiles, props.searchFiles]);

  useEffect(() => {
    if (!toolMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (toolMenuRef.current?.contains(target)) return;
      if (toolMenuPanelRef.current?.contains(target)) return;
      setToolMenuOpen(false);
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [toolMenuOpen]);

  useLayoutEffect(() => {
    if (!toolMenuOpen) {
      setToolMenuLayout(null);
      return;
    }
    const trigger = toolMenuRef.current;
    if (!trigger) return;
    const update = () => {
      setToolMenuLayout(measureToolMenuLayout(trigger));
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [toolMenuOpen]);

  useEffect(() => {
    if (!agentMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (agentMenuRef.current?.contains(target)) return;
      setAgentMenuOpen(false);
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [agentMenuOpen]);

  useEffect(() => {
    if (!toolMenuOpen) return;
    const openId = toolMenuLoadRef.current.openId;
    const listImportedPlugins = listImportedPluginsRef.current;
    if (listImportedPlugins && !toolMenuLoadRef.current.plugins) {
      let cancelled = false;
      toolMenuLoadRef.current.plugins = true;
      setPluginsLoading(true);
      void listImportedPlugins()
        .then((next) => {
          if (!cancelled && toolMenuLoadRef.current.openId === openId) {
            setImportedPlugins(next);
            setPluginsLoaded(true);
          }
        })
        .catch(() => {
          if (!cancelled && toolMenuLoadRef.current.openId === openId) {
            setImportedPlugins([]);
            setPluginsLoaded(true);
          }
        })
        .finally(() => {
          if (!cancelled && toolMenuLoadRef.current.openId === openId) setPluginsLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }
    return undefined;
  }, [toolMenuOpen]);

  useEffect(() => {
    if (!toolMenuOpen) return;
    const openId = toolMenuLoadRef.current.openId;
    const listMcp = listMcpRef.current;
    if (listMcp && !toolMenuLoadRef.current.mcps) {
      let cancelled = false;
      toolMenuLoadRef.current.mcps = true;
      setMcpLoading(true);
      void listMcp()
        .then(() => {
          if (!cancelled && toolMenuLoadRef.current.openId === openId) setMcpLoaded(true);
        })
        .catch(() => {
          if (!cancelled && toolMenuLoadRef.current.openId === openId) setMcpLoaded(true);
        })
        .finally(() => {
          if (!cancelled && toolMenuLoadRef.current.openId === openId) setMcpLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }
    if (!listMcp) setMcpLoaded(true);
    return undefined;
  }, [toolMenuOpen]);

  useEffect(() => {
    if (!toolMenuOpen) return;
    void orgMcp.refresh();
  }, [orgMcp.refresh, toolMenuOpen]);

  const connectingId = orgMcp.connectingId;
  const connectingIdRef = useRef(connectingId);
  useEffect(() => {
    const previous = connectingIdRef.current;
    connectingIdRef.current = connectingId;
    if (!previous || connectingId) return;
    void listMcpRef.current?.();
    void loadSessionConnectCapabilities();
  }, [connectingId]);

  useEffect(() => {
    if (!toolMenuOpen || !orgMcp.error) return;
    toast.warning(orgMcp.error);
  }, [orgMcp.error, toolMenuOpen]);

  useEffect(() => {
    if (!slashOpen && !toolMenuOpen) return;
    const openId = toolMenuLoadRef.current.openId;
    if ((slashOpen || toolMenuSection === "skills") && (!toolMenuOpen || !toolMenuLoadRef.current.skills)) {
      let cancelled = false;
      if (toolMenuOpen) toolMenuLoadRef.current.skills = true;
      setSkillsLoading(true);
      void loadSkills()
        .then((next) => {
          if (!cancelled && (!toolMenuOpen || toolMenuLoadRef.current.openId === openId)) {
            setSkills(next);
            setSkillsLoaded(true);
          }
        })
        .catch(() => {
          if (!cancelled && (!toolMenuOpen || toolMenuLoadRef.current.openId === openId)) {
            setSkills([]);
            setSkillsLoaded(true);
          }
        })
        .finally(() => {
          if (!cancelled && (!toolMenuOpen || toolMenuLoadRef.current.openId === openId)) setSkillsLoading(false);
        });
      return () => {
        cancelled = true;
        if (toolMenuOpen && toolMenuLoadRef.current.openId === openId) {
          toolMenuLoadRef.current.skills = false;
        }
      };
    }
    return undefined;
  }, [loadSkills, slashOpen, toolMenuOpen, toolMenuSection]);

  const slashItems = useMemo<ComposerSlashCommandOption[]>(
    () => [...commands, ...connectSkillSlashCommandOptions(skills)],
    [commands, skills],
  );
  const slashFiltered = useMemo(() => {
    if (!slashOpen) return [];
    if (!slashQuery) return slashItems.slice(0, 8);
    return fuzzysort.go(slashQuery, slashItems, { keys: ["name", "description"], limit: 8 }).map((entry) => entry.obj);
  }, [slashItems, slashOpen, slashQuery]);
  const mentionFiltered = useMemo(() => {
    if (!mentionOpen) return [];
    if (!mentionQuery) return mentionItems.slice(0, 8);
    return fuzzysort.go(mentionQuery, mentionItems, { keys: ["label"], limit: 8 }).map((entry) => entry.obj);
  }, [mentionItems, mentionOpen, mentionQuery]);
  const pastedTextTokens = useMemo(
    () => props.pastedText.map((item) => ({ label: item.label, lines: item.lines, text: item.text })),
    [props.pastedText],
  );

  const handleExpandPastedText = useCallback((label: string) => {
    const target = props.pastedText.find((item) => item.label === label);
    if (!target) return;
    props.onExpandPastedText(target.id);
  }, [props.onExpandPastedText, props.pastedText]);

  const activeMenu = slashOpen ? "slash" : mentionOpen ? "mention" : null;
  const activeItems = activeMenu === "slash" ? slashFiltered : activeMenu === "mention" ? mentionFiltered : [];
  const toolCommandItems = commands.filter(isLibraryCommand);
  const toolSkillItems = commands.filter((command) => command.source === "skill");
  const localCommandSkillNames = new Set(toolSkillItems.map((command) => command.name));
  const skillMenuItems: SkillCard[] = [
    ...toolSkillItems.map((command) => ({
      name: command.name,
      path: `command://${command.id}`,
      description: command.description,
      origin: "local" as const,
    })),
    ...skills.filter((skill) =>
      skill.origin === "openwork-connect" || !localCommandSkillNames.has(skill.name)
    ),
  ];
  const connectionInventory = useMemo(
    () => mergeComposerConnectionInventory({
      mcpServers: props.mcpServers ?? [],
      mcpStatuses: props.mcpStatuses,
      orgConnections: orgMcp.connections,
    }),
    [orgMcp.connections, props.mcpServers, props.mcpStatuses],
  );
  const activePlugin = toolMenuSection.startsWith("plugin:")
    ? importedPlugins.find((plugin) => `plugin:${plugin.pluginId}` === toolMenuSection) ?? null
    : null;
  const canSend = props.draft.trim().length > 0 || props.attachments.length > 0;

  const renderConnectionRows = () => {
    const servers = connectionInventory.servers;
    if (servers.length === 0) {
      return (
        <div className="px-3 py-2 text-xs text-gray-10">
          {(!mcpLoaded && mcpLoading) || (orgMcp.loading && !orgMcp.loaded)
            ? t("composer.loading_commands")
            : t("composer.no_connections_mcps")}
        </div>
      );
    }
    return (
      <div className="grid gap-1">
        {servers.map((server) => {
          const status = mcpEntryStatus(server, connectionInventory.statuses);
          const statusLabel = toolMenuMcpStatusLabel(status);
          const connection = orgMcp.connections.find((entry) => entry.id === server.orgMcpConnectionId);
          const signIn = composerConnectionSignIn({ server, status, connection });
          const connecting = Boolean(signIn && orgMcp.connectingId === signIn.connectionId);
          const source = [server.marketplaceName, server.pluginName].filter(Boolean).join(" · ");
          return (
            <div
              key={server.id ?? server.name}
              className="flex w-full items-start gap-3 rounded-[16px] px-3 py-2.5 text-gray-11"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1 truncate text-xs font-semibold text-gray-11">{server.name}</div>
                  {signIn ? (
                    <button
                      type="button"
                      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-gray-12 px-2 py-0.5 text-[10px] font-medium text-gray-1 transition-colors hover:bg-gray-11 disabled:opacity-60"
                      disabled={connecting}
                      onClick={() => {
                        void orgMcp.connect(signIn.connectionId, { forceFreshAuthorization: signIn.reconnect });
                      }}
                    >
                      {connecting ? <LoaderCircle size={10} className="animate-spin" /> : null}
                      {signIn.reconnect ? t("mcp.org_connection_reconnect_action") : t("mcp.org_connection_connect_action")}
                    </button>
                  ) : statusLabel ? (
                    <span className="shrink-0 rounded-full bg-gray-3 px-2 py-0.5 text-[10px] font-medium text-gray-11">
                      {statusLabel}
                    </span>
                  ) : isLocalCapability(server.origin) ? (
                    <span className="shrink-0 rounded-full bg-gray-3 px-2 py-0.5 text-[10px] font-medium text-gray-11">
                      {t("composer.source_local")}
                    </span>
                  ) : null}
                </div>
                {source ? <div className="truncate text-[10px] text-gray-9">{source}</div> : null}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  useEffect(() => {
    if (!toolMenuSection.startsWith("plugin:")) return;
    if (activePlugin || !pluginsLoaded) return;
    setToolMenuSection("plugins");
  }, [activePlugin, pluginsLoaded, toolMenuSection]);

  useEffect(() => {
    if (!activeItems.length) {
      setMenuIndex(0);
      return;
    }
    setMenuIndex((current) => Math.max(0, Math.min(current, activeItems.length - 1)));
  }, [activeItems.length]);

  useEffect(() => {
    menuItemRefs.current.length = activeItems.length;
    const target = menuItemRefs.current[menuIndex];
    target?.scrollIntoView({ block: "nearest" });
  }, [menuIndex, activeItems.length]);

  const applyCommandSelection = (command: ComposerSlashCommandOption, options?: { replaceSkillDraft?: boolean }) => {
    if (command.skill) {
      applySkillSelection(command.skill, options);
      return;
    }
    if (command.source === "skill") {
      applySkillSelection(command.name, options);
      return;
    }
    props.onDraftChange(`/${command.name} `);
    setSlashOpen(false);
    setToolMenuOpen(false);
  };

  const applySkillSelection = (input: string | SkillCard, options?: { replaceSkillDraft?: boolean }) => {
    const skill = typeof input === "string"
      ? { name: input, path: "", origin: "local" as const }
      : input;
    if (skill.origin === "openwork-connect") {
      const slug = skillSlashCommandName(skill);
      const token = encodeConnectSkillToken({
        slug,
        name: skill.name,
        marketplace: skill.marketplaceName ?? "assigned",
        capability: skill.connectCapabilityName ?? skill.name,
      });
      if (options?.replaceSkillDraft) {
        props.onDraftChange(`${token} `);
      } else {
        const editor = editorRef.current;
        if (editor) {
          editor.insertSkillAtSelection(slug, token);
        } else {
          const separator = props.draft.length > 0 && !/\s$/.test(props.draft) ? " " : "";
          props.onDraftChange(`${props.draft}${separator}${token} `);
        }
      }
      setSlashOpen(false);
      setToolMenuOpen(false);
      return;
    }
    const name = skill.name;
    if (options?.replaceSkillDraft) {
      props.onDraftChange(`[skill ${name}] `);
    } else {
      const editor = editorRef.current;
      if (editor) {
        editor.insertSkillAtSelection(name);
      } else {
        const separator = props.draft.length > 0 && !/\s$/.test(props.draft) ? " " : "";
        props.onDraftChange(`${props.draft}${separator}[skill ${name}] `);
      }
    }
    setSlashOpen(false);
    setToolMenuOpen(false);
  };

  const applyPluginFileSelection = (file: CloudImportedPluginFile) => {
    if (file.skillOrigin === "openwork-connect") {
      applySkillSelection({
        name: file.skillName ?? file.title,
        path: file.path,
        origin: "openwork-connect",
        marketplaceName: file.marketplaceName,
        pluginName: file.pluginName,
        connectCapabilityName: file.connectCapabilityName,
      });
      return;
    }
    if (file.objectType === "command") {
      applyCommandSelection({
        id: `plugin:${file.configObjectId}`,
        name: slugifyLibraryItemName(file.title, "command"),
        source: "command",
      });
      return;
    }
    if (file.objectType === "mcp" || file.objectType === "agent") return;
    const commandName = pluginSlashCommandName(file);
    if (commandName) {
      if (file.objectType === "skill") applySkillSelection(commandName);
      else applyCommandSelection({
        id: `plugin:${file.configObjectId}`,
        name: commandName,
        source: "command",
      });
      return;
    }
    props.onInsertMention("file", file.path);
    setToolMenuOpen(false);
  };

  const applyAgentSelection = (name: string | null) => {
    props.onSelectAgent(name);
    setAgentMenuOpen(false);
    setToolMenuOpen(false);
  };

  const openToolMenuSettings = () => {
    props.onOpenSettingsSection?.(composerConfigureSectionForMenu(toolMenuSection));
  };

  const acceptActiveItem = () => {
    if (!activeItems.length) return false;
    if (activeMenu === "slash") {
      const command = slashFiltered[menuIndex];
      if (!command) return false;
      applyCommandSelection(command, { replaceSkillDraft: true });
      return true;
    }
    if (activeMenu === "mention") {
      const item = mentionFiltered[menuIndex];
      if (!item) return false;
      props.onInsertMention(item.kind, item.value);
      setMentionOpen(false);
      return true;
    }
    return false;
  };

  const focusRequested = useComposerStateStore((state) => (
    Boolean(props.sessionId) && state.pendingFocusSessionId === props.sessionId
  ));
  useEffect(() => {
    if (!focusRequested || props.disabled) return;
    // Wait for the editor to mount and the creating menu to close. Keep the
    // request until this session is ready, even when its snapshot loads slowly.
    const frame = requestAnimationFrame(() => {
      if (useComposerStateStore.getState().pendingFocusSessionId !== props.sessionId) return;
      const editable = rootRef.current?.querySelector<HTMLElement>("[contenteditable='true']");
      if (!editable) return;
      editable.focus();
      useComposerStateStore.setState({ pendingFocusSessionId: null });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequested, props.disabled, props.sessionId]);

  // Listen for cross-app focus + draft flush events. The Solid shell uses
  // these from deep-link handlers, the command palette, and the browser
  // pagehide/beforeunload cycle so no in-flight draft is lost.
  useEffect(() => {
    const handleFocus = () => {
      const root = rootRef.current;
      if (!root) return;
      const editable = root.querySelector<HTMLElement>("[contenteditable='true']");
      editable?.focus();
    };
    const handleFlush = () => {
      // onDraftChange always runs synchronously on every keystroke, so this
      // listener is effectively a hook for the shell to signal "we're about
      // to unmount, commit any debounced state". Re-fire with the current
      // draft so downstream stores can checkpoint it.
      props.onDraftChange(draftRef.current);
    };
    window.addEventListener(FOCUS_PROMPT_EVENT, handleFocus);
    window.addEventListener(FLUSH_PROMPT_EVENT, handleFlush);
    window.addEventListener("beforeunload", handleFlush);
    window.addEventListener("pagehide", handleFlush);
    return () => {
      window.removeEventListener(FOCUS_PROMPT_EVENT, handleFocus);
      window.removeEventListener(FLUSH_PROMPT_EVENT, handleFlush);
      window.removeEventListener("beforeunload", handleFlush);
      window.removeEventListener("pagehide", handleFlush);
    };
  }, [props.onDraftChange]);

  const handleKeyDownCapture: React.KeyboardEventHandler<HTMLDivElement> = (event) => {
    // IME composition guard — block Enter while IME is mid-character.
    const imeActive =
      imeComposingRef.current ||
      (event.nativeEvent as KeyboardEvent).isComposing === true ||
      event.keyCode === 229;
    if (event.key === "Enter" && imeActive) {
      return;
    }
    // Escape-to-stop while the agent is busy. Only when no menu is open so
    // Escape can still close menus. First press arms a confirmation prompt
    // for 3s; a second Escape within that window stops the agent.
    const anyMenuOpen = agentMenuOpen || toolMenuOpen || Boolean(activeMenu);
    if (event.key === "Escape" && props.busy && !anyMenuOpen) {
      event.preventDefault();
      if (escapeArmed) {
        disarmEscape();
        void props.onStop();
      } else {
        setEscapeArmed(true);
        if (escapeTimerRef.current) clearTimeout(escapeTimerRef.current);
        escapeTimerRef.current = setTimeout(() => {
          setEscapeArmed(false);
          escapeTimerRef.current = null;
        }, 3000);
      }
      return;
    }
    if (agentMenuOpen) {
      const total = nonDefaultAgents.length + 1;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setAgentMenuIndex((current) => (current + 1) % total);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setAgentMenuIndex((current) => (current - 1 + total) % total);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const selected = agentMenuIndex === 0 ? null : nonDefaultAgents[agentMenuIndex - 1]?.name ?? null;
        props.onSelectAgent(selected);
        setAgentMenuOpen(false);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setAgentMenuOpen(false);
        return;
      }
    }

    if (toolMenuOpen && event.key === "Escape") {
      event.preventDefault();
      setToolMenuOpen(false);
      return;
    }

    // Input history recall (#2012). Only when no menu is consuming the
    // arrow keys and IME composition is not active.
    if (
      (event.key === "ArrowUp" || event.key === "ArrowDown") &&
      !imeActive &&
      !agentMenuOpen &&
      !toolMenuOpen &&
      (!activeMenu || !activeItems.length)
    ) {
      const history = props.inputHistory ?? [];
      const position = historyPosRef.current;
      if (event.key === "ArrowUp") {
        const startRecall = position === null && props.draft.trim() === "" && history.length > 0;
        const continueRecall = position !== null && position > 0;
        if (startRecall || continueRecall) {
          const nextPos = position === null ? history.length - 1 : position - 1;
          if (position === null) historyStashRef.current = props.draft;
          historyPosRef.current = nextPos;
          historyExpectedRef.current = history[nextPos];
          event.preventDefault();
          props.onDraftChange(history[nextPos]);
          return;
        }
      } else if (position !== null) {
        event.preventDefault();
        const nextPos = position + 1;
        if (nextPos >= history.length) {
          historyPosRef.current = null;
          historyExpectedRef.current = null;
          props.onDraftChange(historyStashRef.current);
        } else {
          historyPosRef.current = nextPos;
          historyExpectedRef.current = history[nextPos];
          props.onDraftChange(history[nextPos]);
        }
        return;
      }
    }

    if (!activeMenu || !activeItems.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setMenuIndex((current) => (current + 1) % activeItems.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setMenuIndex((current) => (current - 1 + activeItems.length) % activeItems.length);
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      void acceptActiveItem();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setSlashOpen(false);
      setMentionOpen(false);
    }
  };

  // Attachment chips are raw Lexical token DOM, so their uploading overlay is
  // synced by attribute whenever the uploading flag or the chip set changes.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    syncAttachmentChipStatus(root, props.attachmentsUploading ? "uploading" : "ready");
  }, [props.attachmentsUploading, props.attachments]);

  const addAttachments = async (inputFiles: File[]) => {
    if (!inputFiles.length) return;
    if (!props.attachmentsEnabled) {
      toast.warning(props.attachmentsDisabledReason ?? t("composer.attachments_unavailable"));
      return;
    }

    // No client-side size cap: oversized files are rejected upstream (upload
    // endpoint or provider) with their own errors instead of a composer rule.
    // Oversized images are compressed at send time (see image-compression.ts)
    // so the chip appears instantly instead of blocking on canvas work here.
    props.onAttachFiles(inputFiles);
  };

  const panelRoundedClass =
    mentionOpen || slashOpen
      ? "rounded-t-[18px] border-t-transparent"
      : "";

  const renderSlashMenu = () => {
    if (!slashOpen) return null;
    return (
      <div className="absolute bottom-full left-[-1px] right-[-1px] z-30">
          <div className="overflow-hidden rounded-t-[20px] border border-dls-border border-b-0 bg-dls-surface shadow-[var(--dls-shell-shadow)]">
            <div
              role="presentation"
              className="max-h-64 overflow-y-auto p-2"
              onMouseDown={(event) => event.preventDefault()}
          >
            {slashFiltered.length > 0 ? (
              <div className="grid gap-1">
                {slashFiltered.map((command, index) => (
                  <button
                    key={command.id}
                    ref={(element) => {
                      menuItemRefs.current[index] = element;
                    }}
                    type="button"
                    className={`flex w-full items-start gap-3 rounded-[16px] px-3 py-2.5 text-left transition-colors hover:bg-gray-2/70 ${activeMenu === "slash" && slashFiltered[menuIndex]?.id === command.id ? "bg-gray-3 text-gray-12" : "text-gray-11"}`}
                    onMouseEnter={() => setMenuIndex(index)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      applyCommandSelection(command, { replaceSkillDraft: true });
                    }}
                    onClick={(event) => {
                      if (event.detail === 0) applyCommandSelection(command, { replaceSkillDraft: true });
                    }}
                  >
                    <Terminal size={14} className="mt-0.5 shrink-0 text-gray-9" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-3">
                        <div className="truncate text-xs font-semibold">/{command.name}</div>
                        {command.source && command.source !== "command" ? (
                          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${command.source === "skill" ? "bg-violet-3/40 text-violet-11" : "bg-cyan-3/40 text-cyan-11"}`}>
                            {command.source === "skill" ? t("composer.skill_source") : t("composer.mcps_label")}
                          </span>
                        ) : null}
                      </div>
                      {command.description ? <div className="truncate text-xs text-gray-10">{command.description}</div> : null}
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="px-3 py-2 text-xs text-gray-10">
                {(!commandsLoaded && commandsLoading) || skillsLoading ? t("composer.loading_commands") : t("composer.no_commands")}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderMentionMenu = () => {
    if (!mentionOpen || mentionFiltered.length === 0) return null;
    return (
      <div className="absolute bottom-full left-[-1px] right-[-1px] z-30">
          <div className="overflow-hidden rounded-t-[20px] border border-dls-border border-b-0 bg-dls-surface shadow-[var(--dls-shell-shadow)]">
            <div
              role="presentation"
              className="max-h-64 overflow-y-auto p-2"
              onMouseDown={(event) => event.preventDefault()}
          >
            <div className="grid gap-1">
              {mentionFiltered.map((item, index) => (
                <button
                  key={item.id}
                  ref={(element) => {
                    menuItemRefs.current[index] = element;
                  }}
                  type="button"
                  className={`flex w-full items-start gap-3 rounded-[16px] px-3 py-2.5 text-left transition-colors hover:bg-gray-2/70 ${activeMenu === "mention" && mentionFiltered[menuIndex]?.id === item.id ? "bg-gray-3 text-gray-12" : "text-gray-11"}`}
                  onMouseEnter={() => setMenuIndex(index)}
                  onClick={() => {
                    props.onInsertMention(item.kind, item.value);
                    setMentionOpen(false);
                  }}
                >
                  {item.kind === "computer" ? (
                    item.value === "cloud" ? <Cloud size={14} className="mt-0.5 shrink-0 text-gray-9" /> : <Monitor size={14} className="mt-0.5 shrink-0 text-gray-9" />
                  ) : item.kind === "agent" ? (
                    <Zap size={14} className="mt-0.5 shrink-0 text-gray-9" />
                  ) : item.kind === "app" ? (
                    <AppWindowMac size={14} className="mt-0.5 shrink-0 text-gray-9" />
                  ) : (
                    <FileText size={14} className="mt-0.5 shrink-0 text-gray-9" />
                  )}
                  <div className="min-w-0">
                    <div className="truncate text-xs font-semibold">@{item.label}</div>
                    <div className="truncate text-xs text-gray-10">
                      {item.description ? item.description : item.kind === "agent"
                        ? t("composer.agent_label")
                        : item.kind === "app"
                          ? t("composer.app_kind")
                          : t("composer.file_kind")}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <DevProfiler id="SessionComposer">
    <div
      ref={rootRef}
      className={props.flush ? `relative ${toolMenuOpen ? "z-50" : "z-20"}` : `sticky bottom-0 ${toolMenuOpen ? "z-50" : "z-20"} bg-gradient-to-t from-dls-surface via-dls-surface/95 to-transparent px-4 pb-[max(0.5rem,calc(env(safe-area-inset-bottom)+var(--keyboard-inset,0px)))] max-lg:px-3 lg:px-8 ${props.compactTopSpacing ? "pt-0" : "pt-1"}`}
      style={{ contain: "layout style" }}
      onKeyDownCapture={handleKeyDownCapture}
      onCompositionStart={() => {
        imeComposingRef.current = true;
      }}
      onCompositionEnd={() => {
        imeComposingRef.current = false;
      }}
    >
      <div className={props.flush ? "" : "max-w-[800px] mx-auto"}>
        {/* Main composer panel */}
        <div
          className={`@container/composer relative overflow-visible rounded-[18px] border border-dls-border bg-dls-surface transition-all ${panelRoundedClass}`}
        >
          {props.topAccessory ? <div className="relative z-10">{props.topAccessory}</div> : null}

          {renderMentionMenu()}
          {renderSlashMenu()}

          {/*
            The pasted-text chip used to render twice — once inline inside
            the Lexical editor (via ComposerPastedTextNode) and again as a
            separate rail here above the composer. Keep only the inline
            chip; its pill already shows label + line count, and the user
            removes it with backspace like any other inline token.
          */}

          {dropzoneActive ? (
            <div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-[20px] border-2 border-dashed border-dls-accent bg-[color:color-mix(in_oklab,var(--dls-accent)_10%,transparent)]">
              <div className="rounded-2xl border border-dls-border bg-dls-surface/95 px-5 py-4 text-center backdrop-blur-sm">
                <div className="text-sm font-medium text-dls-text">{t("composer.attach_files")}</div>
                <div className="mt-1 text-xs text-dls-secondary">{t("composer.any_file_type_supported")}</div>
              </div>
            </div>
          ) : null}

          <div className="px-4 pt-3 pb-2">
            {/* Editor */}
            <LexicalPromptEditor
              ref={editorRef}
              value={props.draft}
              mentions={props.mentions}
              pastedText={pastedTextTokens}
              attachments={props.attachments.map((attachment) => ({
                id: attachment.id,
                name: attachment.name,
                kind: isImageAttachment(attachment) ? "image" : "file",
                previewUrl: attachment.previewUrl,
              }))}
              submitDisabled={props.disabled}
              placeholder={t("composer.placeholder")}
              onChange={props.onDraftChange}
              onSubmit={handleEditorSubmit}
              onExpandPastedText={handleExpandPastedText}
              onRemoveAttachment={props.onRemoveAttachment}
              onPasteText={props.onPasteText}
              onPaste={(event) => {
                // Paste policy:
                // 1. Actual files on the clipboard -> attach them.
                // 2. Explicit text/uri-list (drag from Finder / browser) -> insert links.
                // 3. Plain text -> DO NOTHING. Let Lexical's PlainTextPlugin
                //    handle the paste natively so newlines render correctly
                //    and no content is silently dropped. Previous behavior
                //    hijacked pastes that merely contained absolute paths
                //    like "/Users/..." or pastes longer than 10 lines, which
                //    was the root cause of "paste into composer is broken".
                const files = Array.from(event.clipboardData?.files ?? []);
                if (files.length) {
                  event.preventDefault();
                  void addAttachments(files);
                  return;
                }

                const uriList = event.clipboardData
                  ? parseClipboardUriList(event.clipboardData)
                  : [];
                if (uriList.length) {
                  event.preventDefault();
                  props.onUnsupportedFileLinks(uriList);
                  return;
                }

                const text = event.clipboardData?.getData("text/plain") ?? "";

                // Plain text paste display is owned by PasteChipPlugin inside
                // the Lexical editor: text collapses when it would exceed the
                // editor's current width and maximum height, unless the whole
                // string is a standalone HTTP(S) URL. Text that fits, or is
                // expanded from a chip, renders like normal text. Do NOT
                // duplicate that here.

                if (
                  text.trim() &&
                  (props.isRemoteWorkspace || props.isSandboxWorkspace) &&
                  /file:\/\/|(^|\s)\/(Users|home|var|etc|opt|tmp|private|Volumes|Applications)\//.test(text)
                ) {
                  const attachedFiles = props.attachments.map((attachment) => attachment.file);
                  toast.warning(t("composer.remote_worker_paste_warning"), {
                    action:
                      props.onUploadInboxFiles && attachedFiles.length > 0
                        ? {
                            label: t("composer.upload_to_shared_folder"),
                            onClick: () => void props.onUploadInboxFiles?.(attachedFiles),
                          }
                        : undefined,
                  });
                  // Intentionally no preventDefault — the notice is advisory,
                  // the paste still goes through the editor.
                }
              }}
              onDragOver={(event) => {
                if (event.dataTransfer?.files?.length) {
                  event.preventDefault();
                  if (!dropzoneActive) setDropzoneActive(true);
                }
              }}
              onDragLeave={(event) => {
                const nextTarget = event.relatedTarget;
                if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
                setDropzoneActive(false);
              }}
              onDrop={(event) => {
                const files = Array.from(event.dataTransfer?.files ?? []);
                setDropzoneActive(false);
                if (!files.length) return;
                event.preventDefault();
                void addAttachments(files);
              }}
            />

            {/* Respond to the pane width, including desktop split views. */}
            <div data-composer-toolbar className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1.5 gap-y-2 @min-[560px]/composer:flex">
              <div className="contents">
                <div className="col-start-1 row-start-2 flex shrink-0 items-center gap-1.5">
                <input
                  ref={(element) => {
                    fileInput = element ?? undefined;
                  }}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    const files = Array.from(event.currentTarget.files ?? []);
                    if (files.length) void addAttachments(files);
                    event.currentTarget.value = "";
                  }}
                />
                <div
                  ref={toolMenuRef}
                  className="relative"
                  onMouseDown={(event) => {
                    const target = event.target;
                    if (target instanceof Element && target.closest("button")) event.preventDefault();
                  }}
                >
                  <button
                    type="button"
                    className={`inline-flex h-9 max-h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors ${toolMenuOpen ? "bg-gray-3 text-gray-12" : "text-gray-10 hover:bg-gray-3"}`}
                    onClick={() => {
                      setMentionOpen(false);
                      setMentionItems([]);
                      setSlashOpen(false);
                      setToolMenuOpen((value) => !value);
                    }}
                    aria-expanded={toolMenuOpen}
                    aria-haspopup="dialog"
                    title={t("composer.tools_label")}
                  >
                    <Plus size={16} />
                  </button>
                  {toolMenuOpen && toolMenuLayout
                    ? createPortal(
                    <div
                      ref={toolMenuPanelRef}
                      className="fixed z-[200] flex overflow-hidden rounded-[22px] border border-dls-border bg-dls-surface shadow-[var(--dls-shell-shadow)]"
                      style={{
                        left: toolMenuLayout.left,
                        bottom: toolMenuLayout.bottom,
                        width: toolMenuLayout.width,
                        height: toolMenuLayout.maxHeight,
                        maxHeight: toolMenuLayout.maxHeight,
                      }}
                    >
                      <div className="flex h-full min-h-0 min-w-0 w-full">
                        <div className="flex h-full w-[168px] shrink-0 flex-col overflow-y-auto border-r border-dls-border bg-gray-2/30 p-2 sm:w-[192px]">
                          {([
                            ["agents", t("composer.agents_label")],
                            ["commands", t("dashboard.commands")],
                            ["skills", t("dashboard.skills")],
                            ["connections", t("composer.connections_mcps_label")],
                            ["plugins", t("extensions.filter_plugins")],
                          ] as const).map(([section, label]) => {
                            const active = section === "plugins"
                              ? isToolMenuPluginsSection(toolMenuSection)
                              : toolMenuSection === section;
                            return (
                            <button
                              key={section}
                              type="button"
                              className={`mb-1 flex w-full items-center justify-between rounded-[16px] px-3 py-2.5 text-left text-sm transition-colors ${active ? "bg-gray-3 text-gray-12" : "text-gray-11 hover:bg-gray-2"}`}
                              onClick={() => setToolMenuSection(section)}
                            >
                              <span className="truncate">{label}</span>
                              <ChevronRight size={14} className="shrink-0 text-gray-9" />
                            </button>
                            );
                          })}
                        </div>
                        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                          <div className="mb-2 flex shrink-0 justify-end border-b border-dls-border px-3 pb-2 pt-2">
                            <button
                              type="button"
                              className="inline-flex items-center gap-1.5 rounded-full border border-dls-border px-3 py-1.5 text-[12px] font-medium text-gray-11 transition-colors hover:bg-gray-2"
                              onClick={() => {
                                setToolMenuOpen(false);
                                openToolMenuSettings();
                              }}
                            >
                              <Settings size={12} />
                              {t("composer.configure")}
                            </button>
                          </div>
                          <div className="min-h-0 flex-1 overflow-y-auto p-2">
                          {toolMenuSection === "agents" ? (
                            <div className="grid gap-1">
                              <button
                                type="button"
                                className={`flex w-full items-start gap-3 rounded-[16px] px-3 py-2.5 text-left transition-colors hover:bg-gray-2/70 ${props.selectedAgent === null ? "bg-gray-2 text-gray-12" : "text-gray-11"}`}
                                onClick={() => applyAgentSelection(null)}
                              >
                                <Zap size={14} className="mt-0.5 shrink-0 text-gray-9" />
                                <div className="min-w-0 flex-1 truncate text-xs font-semibold">{t("composer.default_agent")}</div>
                                {props.selectedAgent === null ? <Check size={14} className="mt-0.5 shrink-0 text-gray-10" /> : null}
                              </button>
                              {nonDefaultAgents.map((agent) => {
                                const active = props.selectedAgent === agent.name;
                                return (
                                  <button
                                    key={agent.name}
                                    type="button"
                                    className={`flex w-full items-start gap-3 rounded-[16px] px-3 py-2.5 text-left transition-colors hover:bg-gray-2/70 ${active ? "bg-gray-2 text-gray-12" : "text-gray-11"}`}
                                    onClick={() => applyAgentSelection(agent.name)}
                                  >
                                    <Zap size={14} className="mt-0.5 shrink-0 text-gray-9" />
                                    <div className="min-w-0 flex-1">
                                      <div className="truncate text-xs font-semibold">{agent.name.charAt(0).toUpperCase() + agent.name.slice(1)}</div>
                                      {agent.description ? <div className="truncate text-xs text-gray-10">{agent.description}</div> : null}
                                    </div>
                                    {active ? <Check size={14} className="mt-0.5 shrink-0 text-gray-10" /> : null}
                                  </button>
                                );
                              })}
                            </div>
                          ) : null}
                          {toolMenuSection === "commands" ? (
                            toolCommandItems.length > 0 ? (
                              <div className="grid gap-1">
                                {toolCommandItems.map((command) => (
                                  <button
                                    key={command.id}
                                    type="button"
                                    className="flex w-full items-start gap-3 rounded-[16px] px-3 py-2.5 text-left text-gray-11 transition-colors hover:bg-gray-2/70"
                                    onClick={() => applyCommandSelection(command)}
                                  >
                                    <Terminal size={14} className="mt-0.5 shrink-0 text-gray-9" />
                                    <div className="min-w-0">
                                      <div className="truncate text-xs font-semibold text-gray-11">/{command.name}</div>
                                      {command.description ? <div className="truncate text-xs text-gray-10">{command.description}</div> : null}
                                    </div>
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <div className="px-3 py-2 text-xs text-gray-10">
                                {!commandsLoaded && commandsLoading ? t("composer.loading_commands") : t("composer.no_commands")}
                              </div>
                            )
                          ) : null}
                          {toolMenuSection === "skills" ? (
                            skillMenuItems.length > 0 ? (
                              <div className="grid gap-1">
                                {skillMenuItems.map((skill) => (
                                  <button
                                    key={`${skill.origin ?? "local"}:${skill.path || skill.name}`}
                                    type="button"
                                    className="flex min-w-0 w-full items-start gap-3 rounded-[16px] px-3 py-2.5 text-left text-gray-11 transition-colors hover:bg-gray-2/70"
                                    onClick={() => applySkillSelection(skill)}
                                  >
                                    <Zap size={14} className="mt-0.5 shrink-0 text-gray-9" />
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center justify-between gap-3">
                                        <div className="min-w-0 flex-1 truncate text-xs font-semibold text-gray-11">
                                          /{skillMenuSlashCommandName(skill)}
                                        </div>
                                        {isLocalCapability(skill.origin) ? (
                                          <span className="shrink-0 rounded-full bg-gray-3 px-2 py-0.5 text-[10px] font-medium text-gray-11">
                                            {t("composer.source_local")}
                                          </span>
                                        ) : null}
                                      </div>
                                      {skill.description ? <div className="truncate text-xs text-gray-10">{skill.description}</div> : null}
                                      {skill.origin === "openwork-connect" ? (
                                        <div className="truncate text-[10px] text-gray-9">
                                          {[skill.marketplaceName, skill.pluginName].filter(Boolean).join(" · ")}
                                        </div>
                                      ) : null}
                                    </div>
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <div className="px-3 py-2 text-xs text-gray-10">
                                {(!skillsLoaded && skillsLoading) || (!commandsLoaded && commandsLoading) ? t("composer.loading_commands") : t("context_panel.no_skills")}
                              </div>
                            )
                          ) : null}
                          {toolMenuSection === "connections" ? renderConnectionRows() : null}
                          {toolMenuSection === "plugins" ? (
                            importedPlugins.length > 0 ? (
                              <div className="grid gap-1">
                                {importedPlugins.map((plugin) => (
                                  <button
                                    key={plugin.pluginId}
                                    type="button"
                                    className="flex w-full items-start gap-3 rounded-[16px] px-3 py-2.5 text-left text-gray-11 transition-colors hover:bg-gray-2/70"
                                    onClick={() => setToolMenuSection(`plugin:${plugin.pluginId}`)}
                                  >
                                    <div className="min-w-0 flex-1">
                                      <div className="truncate text-xs font-semibold text-gray-11">{plugin.name}</div>
                                      {plugin.description ? (
                                        <div className="truncate text-xs text-gray-10">{plugin.description}</div>
                                      ) : null}
                                    </div>
                                    <ChevronRight size={14} className="mt-0.5 shrink-0 text-gray-9" />
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <div className="px-3 py-2 text-xs text-gray-10">
                                {!pluginsLoaded && pluginsLoading ? t("composer.loading_commands") : t("composer.no_plugins")}
                              </div>
                            )
                          ) : null}
                          {activePlugin ? (
                            activePlugin.files.length > 0 ? (
                              <div className="grid gap-1">
                                {activePlugin.files.map((file) => (
                                  <button
                                    key={`${file.configObjectId}:${file.path}`}
                                    type="button"
                                    className="flex w-full items-start gap-3 rounded-[16px] px-3 py-2.5 text-left text-gray-11 transition-colors hover:bg-gray-2/70"
                                    onClick={() => applyPluginFileSelection(file)}
                                  >
                                    <FileText size={14} className="mt-0.5 shrink-0 text-gray-9" />
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center justify-between gap-3">
                                        <div className="truncate text-xs font-semibold text-gray-11">{file.title}</div>
                                        <span className="shrink-0 rounded-full bg-gray-3 px-2 py-0.5 text-[10px] font-medium text-gray-11">
                                          {formatPluginObjectType(file.objectType)}
                                        </span>
                                      </div>
                                    </div>
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <div className="px-3 py-2 text-xs text-gray-10">{t("composer.no_plugin_files")}</div>
                            )
                          ) : toolMenuSection.startsWith("plugin:") ? (
                            <div className="px-3 py-2 text-xs text-gray-10">
                              {!pluginsLoaded && pluginsLoading ? t("composer.loading_commands") : t("composer.plugin_files_unavailable")}
                            </div>
                          ) : null}
                          </div>
                        </div>
                      </div>
                    </div>,
                    document.body,
                  ) : null}
                </div>
                {props.runModeControl}
                <button
                  type="button"
                  className={`inline-flex h-9 max-h-9 w-9 shrink-0 items-center justify-center rounded-md text-gray-10 transition-colors hover:bg-gray-3 ${
                    !props.attachmentsEnabled ? "cursor-not-allowed opacity-60" : ""
                  }`}
                  onClick={() => {
                    if (!props.attachmentsEnabled) return;
                    fileInput?.click();
                  }}
                  disabled={!props.attachmentsEnabled}
                  title={props.attachmentsDisabledReason ?? t("composer.attach_files")}
                >
                  <Paperclip size={16} />
                </button>

                </div>

                <div data-composer-settings className="col-span-2 row-start-1 flex min-w-0 flex-wrap items-center gap-1 border-b border-dls-border pb-2 @min-[560px]/composer:flex-1 @min-[560px]/composer:border-0 @min-[560px]/composer:pb-0">
                {/* Agent picker (#2101/#1971). Only shown once a non-default
                    agent is selected. Switching back to Default agent lives in
                    this menu and in the + tools menu. */}
                <div ref={agentMenuRef} className={showAgentPicker ? "relative min-w-0 max-w-full shrink-0" : "hidden"}>
                  <button
                    type="button"
                    className="flex h-9 max-h-9 max-w-full items-center gap-1 rounded-md px-1.5 text-[12px] font-medium text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12"
                    onClick={() => setAgentMenuOpen((value) => !value)}
                    disabled={props.busy}
                    aria-expanded={agentMenuOpen}
                    title={t("composer.agent_label")}
                  >
                    <span className="max-w-[140px] truncate">{props.agentLabel}</span>
                    <ChevronDown size={13} />
                  </button>
                  {agentMenuOpen ? (
                    <div className="absolute left-0 bottom-full z-40 mb-2 w-64 overflow-hidden rounded-[18px] border border-dls-border bg-dls-surface shadow-[var(--dls-shell-shadow)]">
                      <div className="border-b border-dls-border px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-gray-10">
                        {t("composer.agent_label")}
                      </div>
                      <div
                        role="presentation"
                        className="max-h-64 space-y-1 overflow-y-auto p-2"
                        onMouseDown={(event) => event.preventDefault()}
                      >
                        <button
                          ref={(element) => {
                            agentItemRefs.current[0] = element;
                          }}
                          type="button"
                          className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition-colors ${!props.selectedAgent || agentMenuIndex === 0 ? "bg-gray-2 text-gray-12" : "text-gray-11 hover:bg-gray-2/70"}`}
                          onMouseEnter={() => setAgentMenuIndex(0)}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            applyAgentSelection(null);
                          }}
                        >
                          <span>{t("composer.default_agent")}</span>
                          {!props.selectedAgent ? <Check size={14} className="text-gray-10" /> : null}
                        </button>
                        {nonDefaultAgents.map((agent, index) => {
                          const active = props.selectedAgent === agent.name;
                          return (
                            <button
                              key={agent.name}
                              ref={(element) => {
                                agentItemRefs.current[index + 1] = element;
                              }}
                              type="button"
                              className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition-colors ${active || agentMenuIndex === index + 1 ? "bg-gray-2 text-gray-12" : "text-gray-11 hover:bg-gray-2/70"}`}
                              onMouseEnter={() => setAgentMenuIndex(index + 1)}
                              onMouseDown={(event) => {
                                event.preventDefault();
                                applyAgentSelection(agent.name);
                              }}
                            >
                              <span className="truncate">{agent.name.charAt(0).toUpperCase() + agent.name.slice(1)}</span>
                              {active ? <Check size={14} className="text-gray-10" /> : null}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>

                <ModelSelect
                  open={props.modelPickerOpen}
                  value={props.selectedModel}
                  hideValue={props.organizationModelsEmpty}
                  onOpenChange={props.onModelPickerOpenChange}
                  onChange={(model, variant) => {
                    if (!props.steering) props.onModelChange(model, variant);
                  }}
                  disabled={props.steering}
                  sessionId={props.sessionId}
                  openWorkModelsEntitled={props.openWorkModelsEntitled}
                  openWorkModelsSyncing={props.openWorkModelsSyncing}
                  fallbackOptions={props.modelOptions}
                  behaviorValue={props.modelVariant}
                  behaviorLabel={props.modelVariantLabel}
                  behaviorOptions={props.modelBehaviorOptions}
                  onBehaviorChange={(value) => {
                    if (!props.steering) props.onModelVariantChange(value);
                  }}
                />
                {props.modelUnavailable ? props.onRefreshOrganizationModels ? (
                  <button
                    type="button"
                    className="inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-full border border-red-5 bg-red-2 px-2.5 text-[11px] font-medium text-red-11 transition-colors hover:border-red-6 hover:bg-red-3 disabled:cursor-wait disabled:opacity-70 sm:max-w-80"
                    onClick={() => void handleRefreshOrganizationModels()}
                    disabled={refreshingOrganizationModels}
                    title={t("models.refresh_organization_models")}
                  >
                    <span className="min-w-0 truncate">
                      {props.modelUnavailableMessage ?? t("models.model_unavailable_short")}
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-1">
                      <RefreshCw size={11} className={refreshingOrganizationModels ? "animate-spin" : ""} />
                      {refreshingOrganizationModels ? t("models.refreshing_organization_models") : t("models.retry_organization_models")}
                    </span>
                  </button>
                ) : (
                  <span className="min-w-0 max-w-full truncate text-xs font-medium text-red-10">
                    {props.modelUnavailableMessage ?? t("models.model_unavailable_short")}
                  </span>
                ) : null}
                </div>

              </div>

              {/*
                Action area: one circular control.
                - Idle: send arrow.
                - Busy: stop icon in that same slot (Enter still queues;
                  Cmd/Ctrl+Enter still steers).
              */}
              <div data-composer-actions className="col-start-2 row-start-2 ml-auto flex shrink-0 items-center gap-1.5">
                {props.busy && escapeArmed ? (
                  <span className="self-center pr-1 text-[12px] font-medium text-gray-10 hidden @min-[720px]/composer:inline">
                    {t("composer.escape_to_stop")}
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={
                    props.busy
                      ? props.onStop
                      : !canSend || props.submissionPreparing
                        ? undefined
                        : props.onSend
                  }
                  disabled={
                    props.disabled
                    || (!props.busy && (!canSend || props.submissionPreparing))
                  }
                  aria-label={
                    props.busy
                      ? t("composer.stop")
                      : props.submissionPreparing
                        ? "Preparing connected service tools…"
                        : t("composer.run_task")
                  }
                  className={`inline-flex h-9 max-h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors ${
                    props.busy
                      ? "bg-[var(--dls-accent)] text-[var(--dls-accent-fg)] hover:bg-[var(--dls-accent-hover)]"
                      : !canSend || props.disabled || props.submissionPreparing
                        ? "bg-gray-4 text-gray-10"
                        : "bg-[var(--dls-accent)] text-[var(--dls-accent-fg)] hover:bg-[var(--dls-accent-hover)]"
                  }`}
                  title={
                    props.busy
                      ? t("composer.stop")
                      : props.submissionPreparing
                        ? "Preparing connected service tools…"
                        : t("composer.run_task")
                  }
                >
                  {props.busy ? (
                    <Square size={12} fill="currentColor" />
                  ) : props.submissionPreparing ? (
                    <LoaderCircle size={15} className="animate-spin" />
                  ) : (
                    <ArrowUp size={15} />
                  )}
                  <span className="sr-only">
                    {props.busy
                      ? t("composer.stop")
                      : props.submissionPreparing
                        ? "Preparing connected service tools…"
                        : t("composer.run_task")}
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
    </DevProfiler>
  );
});
