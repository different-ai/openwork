import { createElement, useMemo, useState } from "react";

import type { SessionViewProps } from "../pages/session";
import ReactSessionCommandPalette from "../session/react-session-command-palette";
import ReactSessionSearchPanel from "../session/react-session-search-panel";
import ReactSessionTodoPanel from "../session/react-session-todo-panel";
import ReactSessionWorkspaceListV2 from "./react-session-workspace-list-v2";

type ReactSessionViewV2Props = {
  legacySurface: SessionViewProps;
};

const readMessageText = (parts: SessionViewProps["messages"][number]["parts"]) => {
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.type !== "text") continue;
    const text = typeof (part as { text?: unknown }).text === "string"
      ? (part as { text: string }).text.trim()
      : "";
    if (!text) continue;
    chunks.push(text);
  }
  return chunks.join("\n").trim();
};

export default function ReactSessionViewV2(props: ReactSessionViewV2Props) {
  const surface = props.legacySurface;
  const [prompt, setPrompt] = useState(surface.prompt || "");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [todoExpanded, setTodoExpanded] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);

  const title =
    surface.getSessionById(surface.selectedSessionId)?.title?.trim() || "Session";
  const workspaceLabel =
    surface.selectedWorkspaceDisplay.displayName ||
    surface.selectedWorkspaceDisplay.name ||
    "Workspace";

  const messageItems = useMemo(
    () =>
      surface.messages.map((message, index) => {
        const id = String((message.info as { id?: string | number }).id ?? index);
        return {
          id,
          role: message.info.role,
          body: readMessageText(message.parts),
        };
      }),
    [surface.messages],
  );

  const searchHits = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();
    if (!needle) return [];
    return messageItems
      .filter((message) => message.body.toLowerCase().includes(needle))
      .map((message) => message.id);
  }, [messageItems, searchQuery]);

  const activeSearchId = searchHits.length
    ? searchHits[Math.max(0, Math.min(searchIndex, searchHits.length - 1))]
    : null;

  const paletteItems = useMemo(() => {
    const base = [
      {
        id: "settings",
        title: "Open settings",
        meta: "app",
        action: () => {
          setPaletteOpen(false);
          surface.toggleSettings();
        },
      },
      {
        id: "search",
        title: "Search conversation",
        meta: "session",
        action: () => {
          setPaletteOpen(false);
          setSearchOpen(true);
        },
      },
      ...surface.workspaceSessionGroups.flatMap((group) =>
        group.sessions.slice(0, 6).map((session) => ({
          id: `session-${session.id}`,
          title: session.title?.trim() || "Untitled session",
          detail: group.workspace.displayName || group.workspace.name || group.workspace.id,
          meta: "session",
          action: () => {
            setPaletteOpen(false);
            surface.setView("session", session.id);
          },
        })),
      ),
    ];

    const needle = paletteQuery.trim().toLowerCase();
    if (!needle) return base;
    return base.filter((item) =>
      [item.title, (item as { detail?: string }).detail ?? "", item.meta ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [paletteQuery, surface]);

  const moveSearchHit = (direction: -1 | 1) => {
    if (!searchHits.length) return;
    setSearchIndex((current) => {
      const next = current + direction;
      if (next < 0) return searchHits.length - 1;
      if (next >= searchHits.length) return 0;
      return next;
    });
  };

  const sendPrompt = async () => {
    const text = prompt.trim();
    if (!text || surface.busy) return;
    setPrompt("");
    surface.setPrompt(text);
    surface.selectSession(surface.selectedSessionId || "");
  };

  const messageCards = messageItems.map((message) =>
    createElement(
      "div",
      {
        key: message.id,
        className: `rounded-xl border px-4 py-3 text-sm ${
          message.id === activeSearchId
            ? "border-blue-8 bg-blue-2/20"
            : "border-dls-border bg-dls-surface"
        }`,
      },
      createElement(
        "div",
        { className: "mb-1 text-[11px] uppercase tracking-wide text-dls-secondary" },
        message.role,
      ),
      message.body || "[Non-text message content]",
    ),
  );

  return createElement(
    "div",
    {
      className:
        "h-[100dvh] min-h-screen w-full overflow-hidden bg-[var(--dls-app-bg)] p-3 md:p-4 text-gray-12 font-sans",
    },
    createElement(
      "div",
      {
        className:
          "mx-auto flex h-full w-full max-w-[1200px] flex-col gap-3 rounded-[24px] border border-dls-border bg-dls-surface p-4 shadow-[var(--dls-shell-shadow)]",
      },
      createElement(
        "div",
        { className: "flex items-center justify-between border-b border-dls-border pb-3" },
        createElement(
          "div",
          { className: "min-w-0" },
          createElement("h1", { className: "truncate text-base font-semibold text-dls-text" }, title),
          createElement(
            "p",
            { className: "truncate text-xs text-dls-secondary" },
            `React Session V2 (flagged) · ${workspaceLabel}`,
          ),
        ),
        createElement("div", { className: "flex items-center gap-2" },
          createElement(
            "button",
            {
              type: "button",
              className:
                "rounded-md border border-dls-border px-3 py-1.5 text-xs text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text",
              onClick: () => setSearchOpen((current) => !current),
            },
            "Search",
          ),
          createElement(
            "button",
            {
              type: "button",
              className:
                "rounded-md border border-dls-border px-3 py-1.5 text-xs text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text",
              onClick: () => setPaletteOpen(true),
            },
            "Actions",
          ),
          createElement(
            "button",
            {
              type: "button",
              className:
                "rounded-md border border-dls-border px-3 py-1.5 text-xs text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text",
              onClick: surface.toggleSettings,
            },
            "Settings",
          ),
        ),
      ),
      createElement(
        "div",
        { className: "min-h-0 flex-1 grid grid-cols-12 gap-3" },
        createElement(
          "aside",
          { className: "col-span-4 min-h-0 rounded-xl border border-dls-border bg-dls-sidebar p-2.5" },
          createElement(ReactSessionWorkspaceListV2, {
            groups: surface.workspaceSessionGroups,
            selectedWorkspaceId: surface.selectedWorkspaceId,
            selectedSessionId: surface.selectedSessionId,
            sessionStatusById: surface.sessionStatusById,
            onSelectWorkspace: surface.selectWorkspace,
            onOpenSession: (sessionId: string) => surface.setView("session", sessionId),
          }),
        ),
        createElement(
          "section",
          { className: "col-span-8 min-h-0 flex flex-col overflow-hidden rounded-xl border border-dls-border bg-dls-surface" },
          searchOpen
            ? createElement(ReactSessionSearchPanel, {
                query: searchQuery,
                positionLabel: searchHits.length
                  ? `${Math.min(searchIndex + 1, searchHits.length)} / ${searchHits.length}`
                  : "0 / 0",
                hasHits: searchHits.length > 0,
                placeholder: "Search this conversation",
                prevLabel: "Prev",
                nextLabel: "Next",
                closeLabel: "Close search",
                onQueryChange: (value: string) => {
                  setSearchQuery(value);
                  setSearchIndex(0);
                },
                onMovePrev: () => moveSearchHit(-1),
                onMoveNext: () => moveSearchHit(1),
                onClose: () => setSearchOpen(false),
                onSubmitStep: moveSearchHit,
              })
            : null,
          createElement(
            "div",
            { className: "min-h-0 flex-1 overflow-y-auto space-y-3 p-3" },
            messageCards.length > 0
              ? messageCards
              : createElement(
                  "div",
                  {
                    className:
                      "rounded-xl border border-dls-border bg-dls-hover/40 px-4 py-6 text-center text-sm text-dls-secondary",
                  },
                  "No messages yet.",
                ),
          ),
          surface.todos.length > 0
            ? createElement(ReactSessionTodoPanel, {
                items: surface.todos,
                expanded: todoExpanded,
                label: `${surface.todos.length} task${surface.todos.length === 1 ? "" : "s"}`,
                onToggleExpanded: () => setTodoExpanded((current) => !current),
              })
            : null,
          createElement(
            "div",
            { className: "border-t border-dls-border p-3" },
            createElement(
              "div",
              { className: "flex items-end gap-2" },
              createElement("textarea", {
                value: prompt,
                onChange: (event: any) => setPrompt(event.currentTarget.value),
                className:
                  "min-h-[64px] flex-1 resize-y rounded-md border border-dls-border bg-dls-surface px-3 py-2 text-sm text-dls-text focus:outline-none",
                placeholder: "Ask OpenWork anything...",
              }),
              createElement(
                "button",
                {
                  type: "button",
                  className:
                    "rounded-md border border-dls-border px-3 py-2 text-xs text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text disabled:opacity-60",
                  disabled: surface.busy || !prompt.trim(),
                  onClick: () => {
                    void sendPrompt();
                  },
                },
                surface.busy ? "Sending..." : "Send",
              ),
            ),
          ),
        ),
      ),
      paletteOpen
        ? createElement(ReactSessionCommandPalette, {
            mode: "root",
            query: paletteQuery,
            title: "Session actions",
            placeholder: "Search actions",
            items: paletteItems,
            activeIndex: Math.max(0, Math.min(paletteIndex, Math.max(0, paletteItems.length - 1))),
            noMatchesLabel: "No matching actions",
            backLabel: "Back",
            closeLabel: "Close quick actions",
            hintNavigateLabel: "Use arrows to navigate",
            hintRunLabel: "Press Enter to run",
            onClose: () => setPaletteOpen(false),
            onBack: () => {},
            onQueryChange: setPaletteQuery,
            onHoverIndex: setPaletteIndex,
          })
        : null,
    ),
  );
}
