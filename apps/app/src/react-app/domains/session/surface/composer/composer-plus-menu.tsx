/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  BookOpen,
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  CornerDownLeft,
  FileText,
  LoaderCircle,
  Paperclip,
  Plug,
  Plus,
  Puzzle,
  Settings,
  Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandGroup, CommandGroupLabel, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { isMacPlatform } from "@/app/utils";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { composerHighlightSegments } from "./composer-search";
import { composerConnectorLogoUrls } from "./composer-connector-logos";
import { loadComposerPlusMenuRecents, recordComposerPlusMenuRecent } from "./composer-plus-menu-recents";
import {
  buildPlusMenuModel,
  plusMenuParentView,
  type PlusMenuConnector,
  type PlusMenuGroupId,
  type PlusMenuInput,
  type PlusMenuItem,
  type PlusMenuSection,
  type PlusMenuView,
} from "./composer-plus-menu-model";

export type ComposerPlusMenuPick = Exclude<PlusMenuItem, { kind: "attach" | "section" | "manage" | "plugin" }>;

type ComposerPlusMenuProps = Omit<PlusMenuInput, "view" | "query" | "recentIds"> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  loading: boolean;
  attachmentsEnabled: boolean;
  attachmentsDisabledReason: string | null;
  onAttach: () => void;
  onPick: (item: ComposerPlusMenuPick) => void;
  onConnect: (connector: PlusMenuConnector) => void;
  onManage: (section: PlusMenuSection) => void;
  onQueryChange?: (query: string) => void;
  /** Where focus returns when the menu closes. */
  returnFocus: () => HTMLElement | null;
};

const SECTION_ICONS: Record<PlusMenuSection, typeof BookOpen> = {
  skills: BookOpen,
  connectors: Plug,
  plugins: Puzzle,
  "agents-commands": Bot,
};

function sectionLabel(section: PlusMenuSection): string {
  switch (section) {
    case "skills":
      return t("composer.plus_skills");
    case "connectors":
      return t("composer.plus_connectors");
    case "plugins":
      return t("composer.plus_plugins");
    case "agents-commands":
      return t("composer.plus_agents_commands");
  }
}

function manageLabel(section: PlusMenuSection): string {
  switch (section) {
    case "skills":
      return t("composer.plus_manage_skills");
    case "connectors":
      return t("composer.plus_manage_connectors");
    case "plugins":
      return t("composer.plus_manage_plugins");
    case "agents-commands":
      return t("composer.plus_manage_agents_commands");
  }
}

function groupLabel(id: PlusMenuGroupId): string | null {
  switch (id) {
    case "recent":
      return t("composer.plus_recent");
    case "browse":
      return t("composer.plus_browse");
    case "connectors":
      return t("composer.plus_connectors");
    case "skills":
      return t("composer.plus_skills");
    case "plugins":
      return t("composer.plus_plugins");
    case "agents":
      return t("composer.plus_agents");
    case "commands":
      return t("composer.plus_commands");
    case "files":
      return t("composer.plus_files");
    case "attach":
    case "plugin-files":
    case "manage":
      return null;
  }
}

function HighlightedLabel(props: { label: string; highlights: number[] }) {
  return (
    <>
      {composerHighlightSegments(props.label, props.highlights).map((segment, index) =>
        segment.match ? (
          <span key={index} data-plus-menu-match="" className="font-semibold text-gray-12">
            {segment.text}
          </span>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

function ConnectorLogo(props: { connector: PlusMenuConnector }) {
  const urls = useMemo(
    () => composerConnectorLogoUrls({ name: props.connector.name, serviceUrl: props.connector.serviceUrl }),
    [props.connector.name, props.connector.serviceUrl],
  );
  const [failed, setFailed] = useState(0);
  const url = urls[failed];
  if (!url) return <Plug className="size-4 text-gray-10" aria-hidden="true" />;
  return (
    <img
      src={url}
      alt=""
      className="size-4 object-contain"
      decoding="async"
      onError={() => setFailed((current) => current + 1)}
    />
  );
}

function ItemIcon(props: { item: PlusMenuItem }) {
  const { item } = props;
  const iconClass = "size-4 text-gray-10";
  switch (item.kind) {
    case "attach":
      return <Paperclip className={iconClass} aria-hidden="true" />;
    case "section": {
      const Icon = SECTION_ICONS[item.section];
      return <Icon className={iconClass} aria-hidden="true" />;
    }
    case "skill":
      return <BookOpen className={iconClass} aria-hidden="true" />;
    case "connector":
      return <ConnectorLogo connector={item.connector} />;
    case "plugin":
      return <Puzzle className={iconClass} aria-hidden="true" />;
    case "agent":
      return <Bot className={iconClass} aria-hidden="true" />;
    case "command":
      return <Terminal className={iconClass} aria-hidden="true" />;
    case "plugin-file":
    case "file":
      return <FileText className={iconClass} aria-hidden="true" />;
    case "manage":
      return <Settings className={iconClass} aria-hidden="true" />;
  }
}

function itemText(item: PlusMenuItem): ReactNode {
  switch (item.kind) {
    case "attach":
      return t("composer.plus_attach");
    case "section":
      return sectionLabel(item.section);
    case "manage":
      return manageLabel(item.section);
    case "command":
      return (
        <>
          <span className="text-gray-9">/</span>
          <HighlightedLabel label={item.label} highlights={item.highlights} />
        </>
      );
    default:
      return <HighlightedLabel label={item.label} highlights={item.highlights} />;
  }
}

function itemTitle(item: PlusMenuItem): string | undefined {
  if (item.kind === "file") return item.path;
  if (item.kind === "skill") return item.skill.description || undefined;
  if (item.kind === "agent") return item.agent.description || undefined;
  if (item.kind === "command") return item.command.description || undefined;
  return undefined;
}

export function ComposerPlusMenu(props: ComposerPlusMenuProps) {
  const [view, setView] = useState<PlusMenuView>({ kind: "root" });
  const [query, setQuery] = useState("");
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const attachShortcut = isMacPlatform() ? "⌘U" : "Ctrl+U";

  useEffect(() => {
    if (!props.open) return;
    setRecentIds(loadComposerPlusMenuRecents());
  }, [props.open]);

  const { onQueryChange } = props;
  useEffect(() => {
    onQueryChange?.(view.kind === "root" ? query : "");
  }, [onQueryChange, query, view.kind]);

  const model = useMemo(
    () =>
      buildPlusMenuModel({
        view,
        query,
        recentIds,
        skills: props.skills,
        connectors: props.connectors,
        plugins: props.plugins,
        agents: props.agents,
        commands: props.commands,
        files: props.files,
      }),
    [view, query, recentIds, props.skills, props.connectors, props.plugins, props.agents, props.commands, props.files],
  );
  const itemIds = useMemo(() => model.groups.flatMap((group) => group.items.map((item) => item.id)), [model]);

  const reset = () => {
    setView({ kind: "root" });
    setQuery("");
  };

  const close = () => {
    props.onOpenChange(false);
    reset();
  };

  const navigate = (next: PlusMenuView) => {
    setView(next);
    setQuery("");
    inputRef.current?.focus();
  };

  const goBack = () => {
    const parent = plusMenuParentView(viewRef.current);
    if (!parent) return false;
    navigate(parent);
    return true;
  };

  const attach = () => {
    close();
    props.onAttach();
  };

  const choose = (item: PlusMenuItem) => {
    switch (item.kind) {
      case "attach":
        attach();
        return;
      case "section":
        navigate({ kind: "section", section: item.section });
        return;
      case "plugin":
        navigate({ kind: "plugin", pluginId: item.plugin.pluginId });
        return;
      case "manage":
        close();
        props.onManage(item.section);
        return;
      default:
        if (item.kind !== "agent") setRecentIds(recordComposerPlusMenuRecent(item.id));
        close();
        props.onPick(item);
    }
  };

  const sectionEmpty = view.kind !== "root" && !query && model.groups.every((group) => group.id === "manage");
  const searchPlaceholder = view.kind === "root"
    ? t("composer.plus_search_placeholder")
    : view.kind === "section"
      ? t("composer.plus_search_in", { section: sectionLabel(view.section).toLowerCase() })
      : t("composer.plus_search_in", {
          section: props.plugins.find((plugin) => plugin.pluginId === view.pluginId)?.name ?? sectionLabel("plugins").toLowerCase(),
        });

  const renderTrailing = (item: PlusMenuItem) => {
    const enterHint = (
      <CornerDownLeft className="hidden size-3.5 shrink-0 text-gray-9 group-data-[highlighted]:block" aria-hidden="true" />
    );
    switch (item.kind) {
      case "attach":
        return <kbd className="shrink-0 font-sans text-xs text-gray-9">{attachShortcut}</kbd>;
      case "section":
        return (
          <span className="flex shrink-0 items-center gap-1 text-xs text-gray-9">
            {item.count > 0 ? item.count : null}
            <ChevronRight className="size-3.5" aria-hidden="true" />
          </span>
        );
      case "plugin":
        return <ChevronRight className="size-3.5 shrink-0 text-gray-9" aria-hidden="true" />;
      case "agent":
        return item.agent.selected ? <Check className="size-3.5 shrink-0 text-gray-10" aria-label={t("composer.plus_selected")} /> : enterHint;
      case "connector": {
        const { connector } = item;
        if (connector.signIn) {
          return (
            <Button
              size="xs"
              variant="outline"
              className="shrink-0"
              disabled={connector.connecting}
              aria-label={t("composer.plus_connect_named", { name: connector.name })}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                props.onConnect(connector);
              }}
            >
              {connector.connecting ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
              {connector.signIn.reconnect ? t("mcp.org_connection_reconnect_action") : t("composer.plus_connect")}
            </Button>
          );
        }
        if (connector.note) return <span className="shrink-0 text-xs text-gray-9">{connector.note}</span>;
        return enterHint;
      }
      default:
        return enterHint;
    }
  };

  return (
    <Popover
      open={props.open}
      onOpenChange={(nextOpen, details) => {
        if (!nextOpen && details.reason === "escape-key" && plusMenuParentView(viewRef.current)) {
          details.cancel();
          goBack();
          return;
        }
        props.onOpenChange(nextOpen);
        if (!nextOpen) reset();
      }}
    >
      <PopoverTrigger
        type="button"
        data-composer-plus-trigger=""
        title={t("composer.plus_label")}
        aria-label={t("composer.plus_label")}
        className={cn(
          "inline-flex h-9 max-h-9 w-9 shrink-0 items-center justify-center rounded-md outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/30",
          props.open ? "bg-gray-3 text-gray-12" : "text-gray-10 hover:bg-gray-3",
        )}
      >
        <Plus size={16} />
      </PopoverTrigger>
      <PopoverContent
        data-composer-plus-menu=""
        side="top"
        align="start"
        sideOffset={8}
        initialFocus={inputRef}
        finalFocus={() => props.returnFocus() ?? true}
        className="flex max-h-[min(var(--available-height),28rem)] w-[380px] max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden rounded-[14px] bg-popover p-0 shadow-[var(--dls-shell-shadow)] ring-0 data-open:animate-none data-closed:animate-none dark:ring-0"
      >
        {/* Without `items`, Base UI keeps its old highlight index when rows reorder. */}
        <Command mode="none" items={itemIds} value={query} onValueChange={(value) => setQuery(value)}>
          <div className="flex h-11 shrink-0 items-center gap-1 border-b border-gray-3 px-1.5">
            {view.kind !== "root" ? (
              <button
                type="button"
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-gray-10 outline-none transition-colors hover:bg-gray-3 hover:text-gray-12 focus-visible:ring-3 focus-visible:ring-ring/30"
                aria-label={t("composer.plus_back")}
                title={t("composer.plus_back")}
                onClick={() => goBack()}
              >
                <ChevronLeft className="size-4" aria-hidden="true" />
              </button>
            ) : null}
            <div className="min-w-0 flex-1">
              <CommandInput
                ref={inputRef}
                autoFocus={false}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className="h-9 text-[13px] sm:text-[13px]"
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "u") {
                    event.preventDefault();
                    attach();
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    if (!goBack()) close();
                    return;
                  }
                  if (event.key === "Backspace" && !event.currentTarget.value && goBack()) {
                    event.preventDefault();
                  }
                }}
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
            {model.noMatches ? (
              <p role="status" className="px-4 pb-1 pt-3 text-[13px] text-gray-10">
                {t("composer.plus_no_matches", { query: query.trim() })}
              </p>
            ) : null}
            {sectionEmpty ? (
              <p role="status" className="px-4 pb-1 pt-3 text-[13px] text-gray-10">
                {props.loading ? t("composer.plus_loading") : t("composer.plus_section_empty")}
              </p>
            ) : null}
            <CommandList className="not-empty:p-1.5">
              {model.groups.map((group, index) => {
                const label = groupLabel(group.id);
                return (
                  <CommandGroup
                    key={group.id}
                    className={cn(index > 0 && "mt-1 border-t border-gray-3 pt-1")}
                  >
                    {label ? (
                      <CommandGroupLabel className="px-2 pb-1 pt-1.5 text-xs font-medium text-gray-10">{label}</CommandGroupLabel>
                    ) : null}
                    {group.items.map((item) => (
                      <CommandItem
                        key={item.id}
                        value={item.id}
                        data-plus-menu-item={item.kind}
                        title={item.kind === "attach" && !props.attachmentsEnabled ? props.attachmentsDisabledReason ?? undefined : itemTitle(item)}
                        className="group min-h-8 gap-2.5 rounded-lg px-2 py-0 text-[13px] text-gray-11 data-highlighted:bg-gray-3 data-highlighted:text-gray-12"
                        onClick={() => choose(item)}
                      >
                        <span className="flex size-4 shrink-0 items-center justify-center">
                          <ItemIcon item={item} />
                        </span>
                        <span className="min-w-0 flex-1 truncate">{itemText(item)}</span>
                        {renderTrailing(item)}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                );
              })}
            </CommandList>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
