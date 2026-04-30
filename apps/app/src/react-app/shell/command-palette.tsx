/** @jsxImportSource react */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Search, X } from "lucide-react";

import { t } from "../../i18n";

export type PaletteItem = {
  id: string;
  title: string;
  detail?: string;
  meta?: string;
  action: () => void;
};

type PaletteMode = "root" | "sessions";

export type SessionOption = {
  workspaceId: string;
  sessionId: string;
  title: string;
  workspaceTitle: string;
  updatedAt: number;
  searchText: string;
  isActive: boolean;
};

export type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
  /** Called when a session row is chosen. */
  onOpenSession: (workspaceId: string, sessionId: string) => void;
  /** Called when "New session" is chosen. */
  onCreateNewSession: () => void;
  /** Called when "Open settings" is chosen. Accepts an optional route to jump straight to a tab. */
  onOpenSettings: (route?: string) => void;
  /** Optional — open a URL in the user's browser. Falls back to window.open. */
  onOpenUrl?: (url: string) => void;
  /** Optional: sessions for the second mode. */
  sessions: SessionOption[];
};

/**
 * React command palette (Cmd/Ctrl+K).
 *
 * - Root mode: "New session", "Open settings", and a link into the Sessions submode.
 * - Sessions submode: fuzzy list of every session across workspaces.
 */
export function CommandPalette(props: CommandPaletteProps) {
  const [mode, setMode] = useState<PaletteMode>("root");
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!props.open) {
      setMode("root");
      setQuery("");
      setActiveIndex(0);
      return;
    }
    const id = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 10);
    return () => window.clearTimeout(id);
  }, [props.open]);

  const openUrl = (url: string) => {
    if (props.onOpenUrl) {
      props.onOpenUrl(url);
    } else if (typeof window !== "undefined") {
      window.open(url, "_blank", "noopener");
    }
  };

  const rootItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [
      {
        id: "new-session",
        title: t("session.cmd_new_session_title"),
        detail: t("session.cmd_new_session_detail"),
        meta: t("session.cmd_new_session_meta"),
        action: () => {
          props.onClose();
          props.onCreateNewSession();
        },
      },
      {
        id: "sessions",
        title: t("session.cmd_sessions_title"),
        detail: t("session.cmd_sessions_detail", undefined, {
          count: props.sessions.length.toLocaleString(),
        }),
        meta: t("session.cmd_sessions_meta"),
        action: () => {
          setMode("sessions");
          setQuery("");
          setActiveIndex(0);
          window.setTimeout(() => inputRef.current?.focus(), 0);
        },
      },
      {
        id: "open-settings",
        title: t("settings.tab_general"),
        detail: t("settings.tab_description_general"),
        meta: t("session.cmd_settings_meta"),
        action: () => {
          props.onClose();
          props.onOpenSettings();
        },
      },
      // Top-bar shortcuts — these used to be selectable via Cmd+K and were
      // missing after the React port. Each one mirrors one of the icons at
      // the bottom-right of the session surface (documentation / feedback)
      // plus every settings tab the user is likely to reach for.
      {
        id: "open-docs",
        title: t("session.support_docs"),
        meta: t("session.cmd_settings_meta"),
        action: () => {
          props.onClose();
          openUrl("https://openwork.dev/docs");
        },
      },
      {
        id: "open-feedback",
        title: t("session.support_feedback"),
        meta: t("session.cmd_settings_meta"),
        action: () => {
          props.onClose();
          openUrl("https://openwork.dev/feedback");
        },
      },
      {
        id: "settings-skills",
        title: t("settings.tab_skills"),
        detail: t("settings.tab_description_skills"),
        meta: t("session.cmd_settings_meta"),
        action: () => {
          props.onClose();
          props.onOpenSettings("/settings/skills");
        },
      },
      {
        id: "settings-extensions",
        title: t("settings.tab_extensions"),
        detail: t("settings.tab_description_extensions"),
        meta: t("session.cmd_settings_meta"),
        action: () => {
          props.onClose();
          props.onOpenSettings("/settings/extensions");
        },
      },
      {
        id: "settings-appearance",
        title: t("settings.tab_appearance"),
        detail: t("settings.tab_description_appearance"),
        meta: t("session.cmd_settings_meta"),
        action: () => {
          props.onClose();
          props.onOpenSettings("/settings/appearance");
        },
      },
      {
        id: "settings-recovery",
        title: t("settings.tab_recovery"),
        detail: t("settings.tab_description_recovery"),
        meta: t("session.cmd_settings_meta"),
        action: () => {
          props.onClose();
          props.onOpenSettings("/settings/recovery");
        },
      },
      {
        id: "settings-updates",
        title: t("settings.tab_updates"),
        detail: t("settings.tab_description_updates"),
        meta: t("session.cmd_settings_meta"),
        action: () => {
          props.onClose();
          props.onOpenSettings("/settings/updates");
        },
      },
    ];
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) =>
      `${item.title} ${item.detail ?? ""}`.toLowerCase().includes(q),
    );
  }, [props, query]);

  const sessionItems = useMemo<PaletteItem[]>(() => {
    const q = query.trim().toLowerCase();
    const candidates = q
      ? props.sessions.filter((item) => item.searchText.includes(q))
      : props.sessions;
    return candidates.slice(0, 80).map((item) => ({
      id: `session:${item.workspaceId}:${item.sessionId}`,
      title: item.title,
      detail: item.workspaceTitle,
      meta: item.isActive
        ? t("session.cmd_current_workspace")
        : t("session.cmd_switch"),
      action: () => {
        props.onClose();
        props.onOpenSession(item.workspaceId, item.sessionId);
      },
    }));
  }, [props, query]);

  const items = mode === "sessions" ? sessionItems : rootItems;

  useEffect(() => {
    if (activeIndex >= items.length) setActiveIndex(0);
  }, [activeIndex, items.length]);

  useEffect(() => {
    if (!props.open) return;
    const target = optionRefs.current[activeIndex];
    target?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, items.length, props.open]);

  const handleKey = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (mode !== "root") {
        setMode("root");
        setQuery("");
        setActiveIndex(0);
        window.setTimeout(() => inputRef.current?.focus(), 0);
        return;
      }
      props.onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (items.length === 0) return;
      setActiveIndex((current) => (current + 1) % items.length);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length === 0) return;
      setActiveIndex((current) => (current - 1 + items.length) % items.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = items[activeIndex];
      if (item) item.action();
      return;
    }
    if (event.key === "Backspace" && !query && mode !== "root") {
      event.preventDefault();
      setMode("root");
      setActiveIndex(0);
    }
  };

  if (!props.open) return null;

  const placeholder =
    mode === "sessions"
      ? t("session.palette_placeholder_sessions")
      : t("session.palette_placeholder_actions");

  const title =
    mode === "sessions"
      ? t("session.palette_title_sessions")
      : t("session.palette_title_actions");

  return (
    <div
      className="fixed inset-0 z-50 bg-gray-1/60 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto"
      onClick={props.onClose}
      onKeyDown={handleKey}
    >
      <div
        className="w-full max-w-2xl mt-12 rounded-2xl border border-dls-border bg-dls-surface shadow-2xl overflow-hidden"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-dls-border px-4 py-3 space-y-2">
          <div className="flex items-center gap-2">
            {mode !== "root" ? (
              <button
                type="button"
                className="h-8 px-2 rounded-md text-xs text-dls-secondary hover:text-dls-text hover:bg-dls-hover transition-colors"
                onClick={() => {
                  setMode("root");
                  setQuery("");
                  setActiveIndex(0);
                  window.setTimeout(() => inputRef.current?.focus(), 0);
                }}
              >
                {t("common.back")}
              </button>
            ) : null}
            <Search size={14} className="text-dls-secondary shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                setActiveIndex(0);
              }}
              placeholder={placeholder}
              className="min-w-0 flex-1 bg-transparent text-sm text-dls-text placeholder:text-dls-secondary focus:outline-none"
              aria-label={title}
            />
            <button
              type="button"
              className="h-8 w-8 rounded-md text-dls-secondary hover:text-dls-text hover:bg-dls-hover transition-colors flex items-center justify-center"
              onClick={props.onClose}
              aria-label={t("common.close")}
            >
              <X size={14} />
            </button>
          </div>
        </div>
        <div className="max-h-[60vh] overflow-y-auto py-2">
          {items.length === 0 ? (
            <div className="px-4 py-6 text-sm text-dls-secondary text-center">
              {t("session.palette_no_matches")}
            </div>
          ) : (
            <ul>
              {items.map((item, index) => (
                <li key={item.id}>
                  <button
                    ref={(element) => {
                      optionRefs.current[index] = element;
                    }}
                    type="button"
                    className={`w-full px-4 py-2.5 flex items-start gap-3 text-left transition-colors ${
                      index === activeIndex
                        ? "bg-dls-hover"
                        : "hover:bg-dls-hover/60"
                    }`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => item.action()}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-dls-text truncate">
                        {item.title}
                      </div>
                      {item.detail ? (
                        <div className="text-xs text-dls-secondary truncate">
                          {item.detail}
                        </div>
                      ) : null}
                    </div>
                    {item.meta ? (
                      <div className="text-[10px] uppercase tracking-wide text-dls-secondary shrink-0">
                        {item.meta}
                      </div>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="border-t border-dls-border px-4 py-2 text-[11px] text-dls-secondary flex items-center gap-3">
          <span>{t("session.palette_hint_navigate")}</span>
          <span>{t("session.palette_hint_run")}</span>
        </div>
      </div>
    </div>
  );
}
