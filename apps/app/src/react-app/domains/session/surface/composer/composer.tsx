/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import type { Agent } from "@opencode-ai/sdk/v2/client";
import { ArrowUp, Check, ChevronDown, ChevronRight, FileText, Paperclip, Plug, Settings, Square, Terminal, X, Zap } from "lucide-react";
import fuzzysort from "fuzzysort";
import type { ComposerAttachment, McpServerEntry, McpStatusMap, SkillCard, SlashCommandOption } from "../../../../../app/types";
import { currentLocale, t, type Language } from "../../../../../i18n";
import { LexicalPromptEditor } from "./editor";
import {
  ReactComposerNotice,
  type ReactComposerNotice as ReactComposerNoticeData,
} from "./notice";

type MentionItem = {
  id: string;
  kind: "agent" | "file";
  value: string;
  label: string;
};

type PastedTextChip = {
  id: string;
  label: string;
  text: string;
  lines: number;
};

type ToolMenuSection = "commands" | "skills" | "mcps";

type ComposerProps = {
  draft: string;
  mentions: Record<string, "agent" | "file">;
  onDraftChange: (value: string) => void;
  onSend: () => void | Promise<void>;
  onStop: () => void | Promise<void>;
  busy: boolean;
  disabled: boolean;
  statusLabel: string;
  modelLabel: string;
  onModelClick: () => void;
  attachments: ComposerAttachment[];
  onAttachFiles: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
  attachmentsEnabled: boolean;
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
  onOpenSettingsSection?: (section: ToolMenuSection) => void;
  recentFiles: string[];
  searchFiles: (query: string) => Promise<string[]>;
  onInsertMention: (kind: "agent" | "file", value: string) => void;
  notice: ReactComposerNoticeData | null;
  onNotice: (notice: ReactComposerNoticeData) => void;
  onPasteText: (text: string) => void;
  onUnsupportedFileLinks: (links: string[]) => void;
  pastedText: PastedTextChip[];
  onRevealPastedText: (id: string) => void;
  onRemovePastedText: (id: string) => void;
  isRemoteWorkspace: boolean;
  isSandboxWorkspace: boolean;
  onUploadInboxFiles?: ((files: File[]) => void | Promise<unknown>) | null;
  draftScopeKey?: string;
  compactTopSpacing?: boolean;
};

const FLUSH_PROMPT_EVENT = "openwork:flushPromptDraft";
const FOCUS_PROMPT_EVENT = "openwork:focusPrompt";
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const IMAGE_COMPRESS_MAX_PX = 2048;
const IMAGE_COMPRESS_QUALITY = 0.82;
const IMAGE_COMPRESS_TARGET_BYTES = 1_500_000;
const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const ACCEPTED_FILE_TYPES = [...ACCEPTED_IMAGE_TYPES, "application/pdf"];
const FILE_URL_RE = /^file:\/\//i;
const HTTP_URL_RE = /^https?:\/\//i;

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

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function isImageAttachment(attachment: ComposerAttachment) {
  return attachment.kind === "image" || attachment.mimeType.startsWith("image/");
}

const isSupportedAttachmentType = (mime: string) => ACCEPTED_FILE_TYPES.includes(mime);

async function compressImageFile(file: File): Promise<File> {
  if (file.type === "image/gif" || file.size <= IMAGE_COMPRESS_TARGET_BYTES) {
    return file;
  }

  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  const maxDim = Math.max(width, height);
  const scale = maxDim > IMAGE_COMPRESS_MAX_PX ? IMAGE_COMPRESS_MAX_PX / maxDim : 1;
  const targetW = Math.round(width * scale);
  const targetH = Math.round(height * scale);

  let blob: Blob | null = null;

  if (typeof OffscreenCanvas !== "undefined") {
    const offscreen = new OffscreenCanvas(targetW, targetH);
    const ctx = offscreen.getContext("2d");
    if (ctx) {
      ctx.drawImage(bitmap, 0, 0, targetW, targetH);
      blob = await offscreen.convertToBlob({
        type: "image/jpeg",
        quality: IMAGE_COMPRESS_QUALITY,
      });
    }
  }

  if (!blob) {
    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.drawImage(bitmap, 0, 0, targetW, targetH);
      blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", IMAGE_COMPRESS_QUALITY),
      );
    }
  }

  bitmap.close();

  if (!blob || blob.size >= file.size) {
    return file;
  }

  const stem = file.name.replace(/\.[^.]+$/, "") || "image";
  return new File([blob], `${stem}.jpg`, { type: "image/jpeg" });
}

function formatMcpStatusLabel(status: McpServerStatus | undefined, locale: Language) {
  switch (status) {
    case "connected":
      return t("mcp.friendly_status_ready", locale);
    case "needs_auth":
    case "needs_client_registration":
      return t("mcp.friendly_status_needs_signin", locale);
    case "disabled":
      return t("mcp.friendly_status_paused", locale);
    case "disconnected":
      return t("mcp.friendly_status_offline", locale);
    case "failed":
    default:
      return t("mcp.friendly_status_issue", locale);
  }
}

type McpServerStatus = "connected" | "needs_auth" | "needs_client_registration" | "failed" | "disabled" | "disconnected";

function toReactMcpStatus(name: string, entry: McpServerEntry, statuses: McpStatusMap): McpServerStatus {
  const configured = statuses[name];
  if (configured?.status === "connected") return "connected";
  if (configured?.status === "needs_auth") return "needs_auth";
  if (configured?.status === "needs_client_registration") return "needs_client_registration";
  if (configured?.status === "failed") return "failed";
  if (configured?.status === "disabled" || entry.config.enabled === false || entry.config.enabled === undefined && entry.config.type === "local" && entry.config.command?.length === 0) {
    return entry.config.enabled === false ? "disabled" : configured?.status === "disabled" ? "disabled" : "disconnected";
  }
  return "disconnected";
}

function mcpStatusBadgeClass(status: McpServerStatus) {
  switch (status) {
    case "connected":
      return "bg-green-3 text-green-11";
    case "needs_auth":
    case "needs_client_registration":
      return "bg-amber-3 text-amber-11";
    case "disabled":
    case "disconnected":
      return "bg-gray-3 text-gray-11";
    default:
      return "bg-red-3 text-red-11";
  }
}

export function ReactSessionComposer(props: ComposerProps) {
  let fileInput: HTMLInputElement | undefined;
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [variantMenuOpen, setVariantMenuOpen] = useState(false);
  const [commands, setCommands] = useState<SlashCommandOption[]>([]);
  const [commandsLoading, setCommandsLoading] = useState(false);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skills, setSkills] = useState<SkillCard[]>(props.skills ?? []);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpServers, setMcpServers] = useState<McpServerEntry[]>(props.mcpServers ?? []);
  const [mcpStatus, setMcpStatus] = useState<string | null>(props.mcpStatus ?? null);
  const [mcpStatuses, setMcpStatuses] = useState<McpStatusMap>(props.mcpStatuses ?? {});
  const [slashOpen, setSlashOpen] = useState(false);
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  const [toolMenuSection, setToolMenuSection] = useState<ToolMenuSection>("commands");
  const [mentionItems, setMentionItems] = useState<MentionItem[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const menuItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [agentMenuIndex, setAgentMenuIndex] = useState(0);
  const agentItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [dropzoneActive, setDropzoneActive] = useState(false);
  const toolMenuRef = useRef<HTMLDivElement | null>(null);
  const variantMenuRef = useRef<HTMLDivElement | null>(null);
  const agentMenuRef = useRef<HTMLDivElement | null>(null);
  // IME composition guard: while an IME composition is active, we must not
  // treat Enter as a submit. Three signals keep this reliable across WebKit,
  // Chrome, and Safari: event.isComposing, event.keyCode === 229, and the
  // compositionstart/compositionend events below.
  const imeComposingRef = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const locale = currentLocale();
  const draftRef = useRef(props.draft);
  useEffect(() => {
    draftRef.current = props.draft;
  }, [props.draft]);

  const slashMatch = props.draft.match(/^\/(\S*)$/);
  const slashQuery = slashMatch?.[1] ?? "";
  const mentionMatch = props.draft.match(/@([^\s@]*)$/);
  const mentionQuery = mentionMatch?.[1] ?? "";

  useEffect(() => {
    setSlashOpen(Boolean(slashMatch));
    setMenuIndex(0);
  }, [slashMatch]);

  useEffect(() => {
    setMentionOpen(Boolean(mentionMatch));
    setMenuIndex(0);
  }, [mentionMatch]);

  useEffect(() => {
    if (!agentMenuOpen) return;
    void props.listAgents().then(setAgents).catch(() => setAgents([]));
  }, [agentMenuOpen, props.listAgents]);

  useEffect(() => {
    setSkills(props.skills ?? []);
  }, [props.skills]);

  useEffect(() => {
    setMcpServers(props.mcpServers ?? []);
    setMcpStatus(props.mcpStatus ?? null);
    setMcpStatuses(props.mcpStatuses ?? {});
  }, [props.mcpServers, props.mcpStatus, props.mcpStatuses]);

  useEffect(() => {
    setAgentMenuIndex(0);
  }, [agentMenuOpen]);

  useEffect(() => {
    const target = agentItemRefs.current[agentMenuIndex];
    target?.scrollIntoView({ block: "nearest" });
  }, [agentMenuIndex, agentMenuOpen]);

  useEffect(() => {
    if (!slashOpen && !toolMenuOpen) return;
    let cancelled = false;
    setCommandsLoading(true);
    void props.listCommands()
      .then((next) => {
        if (!cancelled) setCommands(next);
      })
      .catch(() => {
        if (!cancelled) setCommands([]);
      })
      .finally(() => {
        if (!cancelled) setCommandsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [slashOpen, toolMenuOpen, props.listCommands]);

  useEffect(() => {
    if (!mentionOpen) return;
    let cancelled = false;
    void Promise.all([props.listAgents(), props.searchFiles(mentionQuery)]).then(([agentList, files]) => {
      if (cancelled) return;
      const recent = props.recentFiles.slice(0, 8);
      const next: MentionItem[] = [
        ...agentList.map((agent) => ({ id: `agent:${agent.name}`, kind: "agent" as const, value: agent.name, label: agent.name })),
        ...recent.map((file) => ({ id: `file:${file}`, kind: "file" as const, value: file, label: file })),
        ...files.filter((file) => !recent.includes(file)).map((file) => ({ id: `file:${file}`, kind: "file" as const, value: file, label: file })),
      ];
      setMentionItems(next);
    }).catch(() => {
      if (!cancelled) setMentionItems([]);
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
      setToolMenuOpen(false);
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [toolMenuOpen]);

  useEffect(() => {
    if (!variantMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (variantMenuRef.current?.contains(target)) return;
      setVariantMenuOpen(false);
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [variantMenuOpen]);

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
    if (toolMenuSection === "skills" && props.listSkills) {
      let cancelled = false;
      setSkillsLoading(true);
      void props.listSkills()
        .then((next) => {
          if (!cancelled) setSkills(next);
        })
        .catch(() => {
          if (!cancelled) setSkills([]);
        })
        .finally(() => {
          if (!cancelled) setSkillsLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }
    if (toolMenuSection === "mcps" && props.listMcp) {
      let cancelled = false;
      setMcpLoading(true);
      void props.listMcp()
        .then((next) => {
          if (cancelled) return;
          setMcpServers(next.servers);
          setMcpStatuses(next.statuses);
          setMcpStatus(next.status);
        })
        .catch(() => {
          if (cancelled) return;
          setMcpServers([]);
          setMcpStatuses({});
        })
        .finally(() => {
          if (!cancelled) setMcpLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }
    return undefined;
  }, [toolMenuOpen, toolMenuSection, props.listSkills, props.listMcp]);

  const slashFiltered = !slashOpen
    ? []
    : slashQuery
      ? fuzzysort.go(slashQuery, commands, { keys: ["name", "description"] }).map((entry) => entry.obj).slice(0, 8)
      : commands.slice(0, 8);
  const mentionFiltered = !mentionOpen
    ? []
    : mentionQuery
      ? fuzzysort.go(mentionQuery, mentionItems, { keys: ["label"] }).map((entry) => entry.obj).slice(0, 8)
      : mentionItems.slice(0, 8);

  const activeMenu = slashOpen ? "slash" : mentionOpen ? "mention" : null;
  const activeItems = activeMenu === "slash" ? slashFiltered : activeMenu === "mention" ? mentionFiltered : [];
  const toolCommandItems = commands.filter((command) => !command.source || command.source === "command");
  const toolSkillItems = commands.filter((command) => command.source === "skill");
  const toolMcpItems = commands.filter((command) => command.source === "mcp");
  const canSend = props.draft.trim().length > 0 || props.attachments.length > 0;

  useEffect(() => {
    if (!activeItems.length) {
      setMenuIndex(0);
      return;
    }
    setMenuIndex((current) => Math.max(0, Math.min(current, activeItems.length - 1)));
  }, [activeItems.length]);

  useEffect(() => {
    const target = menuItemRefs.current[menuIndex];
    target?.scrollIntoView({ block: "nearest" });
  }, [menuIndex, activeItems.length]);

  const applyCommandSelection = (command: SlashCommandOption) => {
    props.onDraftChange(`/${command.name} `);
    setSlashOpen(false);
    setToolMenuOpen(false);
  };

  const acceptActiveItem = () => {
    if (!activeItems.length) return false;
    if (activeMenu === "slash") {
      const command = slashFiltered[menuIndex];
      if (!command) return false;
      props.onDraftChange(`/${command.name} `);
      setSlashOpen(false);
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
    if (agentMenuOpen) {
      const total = agents.length + 1;
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
        const selected = agentMenuIndex === 0 ? null : agents[agentMenuIndex - 1]?.name ?? null;
        props.onSelectAgent(selected);
        setAgentMenuOpen(false);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setAgentMenuOpen(false);
        setVariantMenuOpen(false);
        return;
      }
    }

    if (toolMenuOpen && event.key === "Escape") {
      event.preventDefault();
      setToolMenuOpen(false);
      return;
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

  const addAttachments = async (inputFiles: File[]) => {
    if (!inputFiles.length) return;
    if (!props.attachmentsEnabled) {
      props.onNotice({
        title: props.attachmentsDisabledReason ?? t("composer.attachments_unavailable", locale),
        tone: "warning",
      });
      return;
    }

    const accepted: File[] = [];
    const unsupported: string[] = [];
    const oversize: string[] = [];

    for (const original of inputFiles) {
      if (!isSupportedAttachmentType(original.type)) {
        unsupported.push(original.name || t("composer.file_kind", locale));
        continue;
      }
      const processed = original.type.startsWith("image/") ? await compressImageFile(original) : original;
      if (processed.size > MAX_ATTACHMENT_BYTES) {
        oversize.push(processed.name || original.name);
        continue;
      }
      accepted.push(processed);
    }

    if (accepted.length) {
      props.onAttachFiles(accepted);
      props.onNotice({
        title:
          accepted.length === 1
            ? t("composer.uploaded_single_file", locale, { name: accepted[0]?.name ?? t("composer.file_kind", locale) })
            : t("composer.uploaded_multiple_files", locale, { count: accepted.length }),
        tone: "success",
      });
    }

    if (oversize.length) {
      props.onNotice({
        title:
          oversize.length === 1
            ? t("composer.file_exceeds_limit", locale, { name: oversize[0] })
            : `${oversize.length} files exceed the 8MB limit.`,
        tone: "warning",
      });
    }

    if (unsupported.length) {
      props.onNotice({
        title:
          unsupported.length === 1
            ? `${unsupported[0]} · ${t("composer.unsupported_attachment_type", locale)}`
            : `${unsupported.length} ${t("composer.unsupported_attachment_type", locale).toLowerCase()}`,
        tone: "warning",
      });
    }
  };

  const activeMcpItems = mcpServers.map((entry) => ({
    entry,
    status: toReactMcpStatus(entry.name, entry, mcpStatuses),
  }));

  const panelRoundedClass =
    mentionOpen || slashOpen
      ? "rounded-t-[18px] border-t-transparent"
      : "shadow-[var(--dls-shell-shadow)]";

  const renderSlashMenu = () => {
    if (!slashOpen) return null;
    return (
      <div className="absolute bottom-full left-[-1px] right-[-1px] z-30">
        <div className="overflow-hidden rounded-t-[20px] border border-dls-border border-b-0 bg-dls-surface shadow-[var(--dls-shell-shadow)]">
          <div
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
                    onClick={() => applyCommandSelection(command)}
                  >
                    <Terminal size={14} className="mt-0.5 shrink-0 text-gray-9" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-3">
                        <div className="truncate text-xs font-semibold">/{command.name}</div>
                        {command.source && command.source !== "command" ? (
                          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${command.source === "skill" ? "bg-violet-3/40 text-violet-11" : "bg-cyan-3/40 text-cyan-11"}`}>
                            {command.source === "skill" ? t("composer.skill_source", locale) : t("composer.mcps_label", locale)}
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
                {commandsLoading ? t("composer.loading_commands", locale) : t("composer.no_commands", locale)}
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
                  {item.kind === "agent" ? (
                    <Zap size={14} className="mt-0.5 shrink-0 text-gray-9" />
                  ) : (
                    <FileText size={14} className="mt-0.5 shrink-0 text-gray-9" />
                  )}
                  <div className="min-w-0">
                    <div className="truncate text-xs font-semibold">@{item.label}</div>
                    <div className="truncate text-xs text-gray-10">
                      {item.kind === "agent"
                        ? t("composer.agent_label", locale)
                        : t("composer.file_kind", locale)}
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
    <div
      ref={rootRef}
      className={`sticky bottom-0 z-20 bg-gradient-to-t from-dls-surface via-dls-surface/95 to-transparent px-4 md:px-8 pb-5 ${props.compactTopSpacing ? "pt-0" : "pt-3"}`}
      style={{ contain: "layout style" }}
      onKeyDownCapture={handleKeyDownCapture}
      onCompositionStart={() => {
        imeComposingRef.current = true;
      }}
      onCompositionEnd={() => {
        imeComposingRef.current = false;
      }}
    >
      <div className="max-w-[800px] mx-auto">
        {/* Main composer panel */}
        <div
          className={`relative overflow-visible rounded-[24px] border border-dls-border bg-dls-surface transition-all ${panelRoundedClass}`}
        >
          <ReactComposerNotice notice={props.notice} />

          {renderMentionMenu()}
          {renderSlashMenu()}

          {props.attachments.length > 0 ? (
            <div className="mx-5 mt-5 flex flex-wrap gap-2 md:mx-6">
              {props.attachments.map((attachment) => (
                <div key={attachment.id} className="flex items-center gap-2 rounded-2xl border border-gray-6 bg-gray-2 px-3 py-2 text-xs text-gray-10">
                  {isImageAttachment(attachment) && attachment.previewUrl ? (
                    <div className="h-10 w-10 overflow-hidden rounded-xl border border-gray-6 bg-gray-1">
                      <img src={attachment.previewUrl} alt={attachment.name} decoding="async" className="h-full w-full object-cover" />
                    </div>
                  ) : (
                    <FileText size={14} className="text-gray-9" />
                  )}
                  <div className="max-w-[160px] min-w-0">
                    <div className="truncate text-[12px] font-medium text-gray-11">{attachment.name}</div>
                    <div className="flex items-center gap-1.5 text-[11px] text-gray-10">
                      <span>{isImageAttachment(attachment) ? t("composer.image_kind", locale) : t("composer.file_kind", locale)}</span>
                      <span>·</span>
                      <span>{formatBytes(attachment.size)}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded-full text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12"
                    onClick={() => props.onRemoveAttachment(attachment.id)}
                    title={t("action.remove", locale)}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}

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
                <div className="text-sm font-medium text-dls-text">{t("composer.attach_files", locale)}</div>
                <div className="mt-1 text-xs text-dls-secondary">Images and PDFs are supported.</div>
              </div>
            </div>
          ) : null}

          <div className="px-4 pt-3 pb-2">
            {/* Editor */}
            <LexicalPromptEditor
              value={props.draft}
              mentions={props.mentions}
              pastedText={props.pastedText.map((item) => ({ label: item.label, lines: item.lines }))}
              disabled={props.disabled}
              placeholder={t("composer.placeholder", locale)}
              onChange={props.onDraftChange}
              onSubmit={props.onSend}
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
                  props.onNotice({
                    title: t("composer.inserted_links_unsupported", locale),
                    tone: "info",
                  });
                  return;
                }

                const text = event.clipboardData?.getData("text/plain") ?? "";
                if (
                  text.trim() &&
                  (props.isRemoteWorkspace || props.isSandboxWorkspace) &&
                  /file:\/\/|(^|\s)\/(Users|home|var|etc|opt|tmp|private|Volumes|Applications)\//.test(text)
                ) {
                  const attachedFiles = props.attachments.map((attachment) => attachment.file);
                  props.onNotice({
                    title: t("composer.remote_worker_paste_warning", locale),
                    tone: "warning",
                    actionLabel:
                      props.onUploadInboxFiles && attachedFiles.length > 0
                        ? t("composer.upload_to_shared_folder", locale)
                        : undefined,
                    onAction:
                      props.onUploadInboxFiles && attachedFiles.length > 0
                        ? () => void props.onUploadInboxFiles?.(attachedFiles)
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

            {/* Action row — attach/inbox/tools on the left, send on the right */}
            <div className="mt-2 flex items-end justify-between gap-2">
              <div className="flex items-center gap-1.5">
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
                <button
                  type="button"
                  className={`inline-flex h-9 max-h-9 w-9 items-center justify-center rounded-md text-gray-10 transition-colors hover:bg-gray-3 ${
                    !props.attachmentsEnabled ? "cursor-not-allowed opacity-60" : ""
                  }`}
                  onClick={() => {
                    if (!props.attachmentsEnabled) return;
                    fileInput?.click();
                  }}
                  disabled={!props.attachmentsEnabled}
                  title={props.attachmentsDisabledReason ?? t("composer.attach_files", locale)}
                >
                  <Paperclip size={16} />
                </button>
                <div ref={toolMenuRef} className="relative">
                  <button
                    type="button"
                    className={`inline-flex h-9 max-h-9 w-9 items-center justify-center rounded-md transition-colors ${toolMenuOpen ? "bg-gray-3 text-gray-12" : "text-gray-10 hover:bg-gray-3"}`}
                    onClick={() => {
                      setMentionOpen(false);
                      setMentionItems([]);
                      setSlashOpen(false);
                      setToolMenuOpen((value) => !value);
                    }}
                    aria-expanded={toolMenuOpen}
                    aria-haspopup="dialog"
                    title={t("composer.tools_label", locale)}
                  >
                    <Plug size={16} />
                  </button>
                  {toolMenuOpen ? (
                    <div className="absolute bottom-full left-0 z-40 mb-3 w-[min(calc(100vw-2.5rem),34rem)] overflow-hidden rounded-[22px] border border-dls-border bg-dls-surface shadow-[var(--dls-shell-shadow)]">
                      <div className="grid grid-cols-[152px_minmax(0,1fr)] sm:grid-cols-[176px_minmax(0,1fr)]">
                        <div className="border-r border-dls-border bg-gray-2/30 p-2">
                          {([
                            ["commands", t("dashboard.commands", locale)],
                            ["skills", t("dashboard.skills", locale)],
                            ["mcps", t("composer.mcps_label", locale)],
                          ] as const).map(([section, label]) => (
                            <button
                              key={section}
                              type="button"
                              className={`mb-1 flex w-full items-center justify-between rounded-[16px] px-3 py-2.5 text-left text-sm transition-colors ${toolMenuSection === section ? "bg-gray-3 text-gray-12" : "text-gray-11 hover:bg-gray-2"}`}
                              onClick={() => setToolMenuSection(section)}
                            >
                              <span className="truncate">{label}</span>
                              <ChevronRight size={14} className="shrink-0 text-gray-9" />
                            </button>
                          ))}
                        </div>
                        <div className="max-h-72 overflow-y-auto p-2">
                          <div className="mb-2 flex justify-end border-b border-dls-border px-1 pb-2">
                            <button
                              type="button"
                              className="inline-flex items-center gap-1.5 rounded-full border border-dls-border px-3 py-1.5 text-[12px] font-medium text-gray-11 transition-colors hover:bg-gray-2"
                              onClick={() => {
                                setToolMenuOpen(false);
                                props.onOpenSettingsSection?.(toolMenuSection);
                              }}
                            >
                              <Settings size={12} />
                              {t("composer.configure", locale)}
                            </button>
                          </div>
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
                                {commandsLoading ? t("composer.loading_commands", locale) : t("composer.no_commands", locale)}
                              </div>
                            )
                          ) : null}
                          {toolMenuSection === "skills" ? (
                            (skills.length > 0 || toolSkillItems.length > 0) ? (
                              <div className="grid gap-1">
                                {[...toolSkillItems, ...skills.filter((skill) => !toolSkillItems.some((command) => command.name === skill.name)).map((skill) => ({ id: `skill:${skill.name}`, name: skill.name, description: skill.description, source: "skill" as const }))].map((command) => (
                                  <button
                                    key={command.id}
                                    type="button"
                                    className="flex w-full items-start gap-3 rounded-[16px] px-3 py-2.5 text-left text-gray-11 transition-colors hover:bg-gray-2/70"
                                    onClick={() => applyCommandSelection(command)}
                                  >
                                    <Zap size={14} className="mt-0.5 shrink-0 text-gray-9" />
                                    <div className="min-w-0">
                                      <div className="truncate text-xs font-semibold text-gray-11">/{command.name}</div>
                                      {command.description ? <div className="truncate text-xs text-gray-10">{command.description}</div> : null}
                                    </div>
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <div className="px-3 py-2 text-xs text-gray-10">
                                {skillsLoading || commandsLoading ? t("composer.loading_commands", locale) : t("context_panel.no_skills", locale)}
                              </div>
                            )
                          ) : null}
                          {toolMenuSection === "mcps" ? (
                            activeMcpItems.length > 0 ? (
                              <div className="grid gap-1">
                                {activeMcpItems.map(({ entry, status }) => (
                                  <div key={entry.name} className="flex items-start gap-3 rounded-[16px] px-3 py-2.5 text-gray-11">
                                    <Plug size={14} className="mt-0.5 shrink-0 text-gray-9" />
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center justify-between gap-3">
                                        <div className="truncate text-xs font-semibold text-gray-11">{entry.name}</div>
                                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${mcpStatusBadgeClass(status)}`}>
                                          {formatMcpStatusLabel(status, locale)}
                                        </span>
                                      </div>
                                      <div className="truncate text-xs text-gray-10">{entry.config.type === "remote" ? entry.config.url ?? entry.config.command?.join(" ") ?? "Remote MCP" : entry.config.command?.join(" ") ?? "Local MCP"}</div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="px-3 py-2 text-xs text-gray-10">
                                {mcpLoading ? t("composer.loading_commands", locale) : (mcpStatus ?? t("context_panel.no_mcp", locale))}
                              </div>
                            )
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>

              {/*
                Send is ALWAYS reachable — even during streaming — so the
                user can queue a follow-up prompt without stopping the run.
                When busy AND the draft is empty, only Stop is visible (the
                Send button would be a no-op). When busy AND there's a
                draft, both buttons show so the user can either queue the
                next turn or cancel the current one.
              */}
              <div className="ml-auto flex shrink-0 items-end gap-1.5">
                {props.busy ? (
                  <button
                    type="button"
                    onClick={props.onStop}
                    className="inline-flex h-9 max-h-9 items-center gap-2 rounded-full bg-gray-12 px-4 text-[13px] font-medium text-gray-1 transition-colors hover:bg-gray-11"
                    title={t("composer.stop", locale)}
                  >
                    <Square size={12} fill="currentColor" />
                    <span>{t("composer.stop", locale)}</span>
                  </button>
                ) : null}
                {!props.busy || canSend ? (
                  <button
                    type="button"
                    onClick={props.onSend}
                    disabled={props.disabled || !canSend}
                    className={`inline-flex h-9 max-h-9 items-center gap-2 rounded-full px-4 text-[13px] font-medium transition-colors ${
                      !canSend || props.disabled
                        ? "bg-gray-4 text-gray-10"
                        : "bg-[var(--dls-accent)] text-white hover:bg-[var(--dls-accent-hover)]"
                    }`}
                    title={props.busy ? t("composer.run_task", locale) : t("composer.run_task", locale)}
                  >
                    <ArrowUp size={15} />
                    <span>{t("composer.run_task", locale)}</span>
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>

        {/* Below-panel control strip: agent + model + behavior variant */}
        <div className="mt-1 flex items-center justify-between px-1">
          <div className="flex flex-wrap items-center gap-1.5 text-gray-10 sm:gap-2.5">
            <div ref={agentMenuRef} className="relative">
              <button
                type="button"
                className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] font-medium text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12"
                onClick={() => setAgentMenuOpen((value) => !value)}
                disabled={props.busy}
                aria-expanded={agentMenuOpen}
                title={t("composer.agent_label", locale)}
              >
                <span className="max-w-[140px] truncate">{props.agentLabel}</span>
                <ChevronDown size={13} />
              </button>
              {agentMenuOpen ? (
                <div className="absolute left-0 bottom-full z-40 mb-2 w-64 overflow-hidden rounded-[18px] border border-dls-border bg-dls-surface shadow-[var(--dls-shell-shadow)]">
                  <div className="border-b border-dls-border px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-gray-10">
                    {t("composer.agent_label", locale)}
                  </div>
                  <div
                    className="space-y-1 p-2 max-h-64 overflow-y-auto"
                    onMouseDown={(event) => event.preventDefault()}
                  >
                    <button
                      ref={(element) => {
                        agentItemRefs.current[0] = element;
                      }}
                      type="button"
                      className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition-colors ${!props.selectedAgent ? "bg-gray-2 text-gray-12" : "text-gray-11 hover:bg-gray-2/70"}`}
                      onMouseEnter={() => setAgentMenuIndex(0)}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        props.onSelectAgent(null);
                        setAgentMenuOpen(false);
                      }}
                    >
                      <span>{t("composer.default_agent", locale)}</span>
                      {!props.selectedAgent ? <Check size={14} className="text-gray-10" /> : null}
                    </button>
                    {agents.map((agent, index) => {
                      const active = props.selectedAgent === agent.name;
                      return (
                        <button
                          key={agent.name}
                          ref={(element) => {
                            agentItemRefs.current[index + 1] = element;
                          }}
                          type="button"
                          className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition-colors ${active ? "bg-gray-2 text-gray-12" : "text-gray-11 hover:bg-gray-2/70"}`}
                          onMouseEnter={() => setAgentMenuIndex(index + 1)}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            props.onSelectAgent(agent.name);
                            setAgentMenuOpen(false);
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

            <button
              type="button"
              className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-[12px] font-medium text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12"
              onClick={props.onModelClick}
              disabled={props.busy}
            >
              <span className="truncate leading-tight">{props.modelLabel}</span>
              <ChevronDown size={13} className="shrink-0 ml-0.5" />
            </button>

            {props.modelBehaviorOptions?.length ? (
              <div ref={variantMenuRef} className="relative">
                <button
                  type="button"
                  className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] font-medium text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setVariantMenuOpen((value) => !value);
                  }}
                  disabled={props.busy}
                  aria-expanded={variantMenuOpen}
                >
                  <span className="truncate leading-tight">
                    {/* Pill label is the summary resolved by session-route:
                        if modelVariant is null it already carries the
                        provider-default preset's label (e.g. "Balanced"). */}
                    {props.modelVariantLabel ||
                      (props.modelBehaviorOptions.find((option) => option.value === props.modelVariant)?.label ?? "") ||
                      t("settings.default_label")}
                  </span>
                  <ChevronDown size={13} className="shrink-0 ml-0.5" />
                </button>
                {variantMenuOpen ? (
                  <div className="absolute left-0 bottom-full z-40 mb-2 w-48 overflow-hidden rounded-[18px] border border-dls-border bg-dls-surface shadow-[var(--dls-shell-shadow)]">
                    <div className="border-b border-dls-border px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-gray-10">
                      {t("composer.behavior_label", locale)}
                    </div>
                    <div className="space-y-1 p-2">
                      {props.modelBehaviorOptions.map((option) => {
                        // Highlight the row whose label matches the pill. When
                        // modelVariant is null but the provider-default is
                        // e.g. "medium", the "medium" row should render as
                        // selected — user sees the actual active mode.
                        const isActive =
                          props.modelVariant === option.value ||
                          (props.modelVariant == null && option.label === props.modelVariantLabel);
                        return (
                          <button
                            key={option.value ?? "default"}
                            type="button"
                            className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition-colors ${
                              isActive ? "bg-gray-2 text-gray-12" : "text-gray-11 hover:bg-gray-2/70"
                            }`}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              props.onModelVariantChange(option.value);
                              setVariantMenuOpen(false);
                            }}
                          >
                            <span>{option.label}</span>
                            {isActive ? <Check size={14} className="text-gray-10" /> : null}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          {props.statusLabel ? (
            <div className="ml-3 hidden text-[11px] text-dls-secondary sm:block">{props.statusLabel}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
