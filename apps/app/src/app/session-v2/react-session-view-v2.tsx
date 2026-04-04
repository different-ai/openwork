import { createElement } from "react";

import type { SessionViewProps } from "../pages/session";

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
  const title =
    surface.getSessionById(surface.selectedSessionId)?.title?.trim() || "Session";

  const messages = surface.messages.map((message, index) => {
    const body = readMessageText(message.parts);
    return createElement(
      "div",
      {
        key: `${index}-${(message.info as { id?: string | number }).id ?? "msg"}`,
        className: "rounded-xl border border-dls-border bg-dls-surface px-4 py-3 text-sm text-dls-text",
      },
      body || "[Non-text message content]",
    );
  });

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
            `React Session V2 (flagged) · ${surface.selectedWorkspaceDisplay.displayName || surface.selectedWorkspaceDisplay.name}`,
          ),
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
      createElement(
        "div",
        { className: "min-h-0 flex-1 overflow-y-auto space-y-3" },
        messages.length > 0
          ? messages
          : createElement(
              "div",
              {
                className:
                  "rounded-xl border border-dls-border bg-dls-hover/40 px-4 py-6 text-center text-sm text-dls-secondary",
              },
              "No messages yet.",
            ),
      ),
    ),
  );
}
