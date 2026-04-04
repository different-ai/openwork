import { createElement } from "react";

import { DEFAULT_SESSION_TITLE, getDisplaySessionTitle } from "../lib/session-title";
import type { WorkspaceSessionGroup } from "../types";

type ReactSessionWorkspaceListV2Props = {
  groups: WorkspaceSessionGroup[];
  selectedWorkspaceId: string;
  selectedSessionId: string | null;
  sessionStatusById: Record<string, string>;
  onSelectWorkspace: (workspaceId: string) => Promise<boolean> | boolean | void;
  onOpenSession: (workspaceId: string, sessionId: string) => void;
};

const sessionTitle = (raw: string | null | undefined) =>
  getDisplaySessionTitle(raw ?? "", DEFAULT_SESSION_TITLE);

export default function ReactSessionWorkspaceListV2(
  props: ReactSessionWorkspaceListV2Props,
) {
  return createElement(
    "div",
    { className: "min-h-0 flex-1 overflow-auto space-y-3" },
    props.groups.map((group) => {
      const workspace = group.workspace;
      const isWorkspaceSelected = workspace.id === props.selectedWorkspaceId;
      return createElement(
        "section",
        {
          key: workspace.id,
          className: "rounded-xl border border-dls-border bg-dls-surface/60 p-2",
        },
        createElement(
          "button",
          {
            type: "button",
            className: `mb-2 flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs ${
              isWorkspaceSelected
                ? "bg-dls-active text-dls-text"
                : "text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
            }`,
            onClick: () => {
              void props.onSelectWorkspace(workspace.id);
            },
          },
          createElement(
            "span",
            { className: "truncate font-medium" },
            workspace.displayName || workspace.name || workspace.id,
          ),
          createElement(
            "span",
            { className: "ml-2 rounded border border-dls-border px-1.5 py-0.5 text-[10px]" },
            String(group.sessions.length),
          ),
        ),
        createElement(
          "div",
          { className: "space-y-1" },
          group.sessions.slice(0, 12).map((session) => {
            const selected = props.selectedSessionId === session.id;
            const status = props.sessionStatusById[session.id];
            return createElement(
              "button",
              {
                key: session.id,
                type: "button",
                className: `flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[12px] ${
                  selected
                    ? "bg-dls-active text-dls-text"
                    : "text-dls-secondary hover:bg-dls-hover hover:text-dls-text"
                }`,
                onClick: () => props.onOpenSession(workspace.id, session.id),
              },
              createElement("span", { className: "truncate" }, sessionTitle(session.title)),
              status && status !== "idle"
                ? createElement(
                    "span",
                    { className: "ml-2 rounded px-1.5 py-0.5 text-[10px] bg-dls-hover" },
                    status,
                  )
                : null,
            );
          }),
        ),
      );
    }),
  );
}
