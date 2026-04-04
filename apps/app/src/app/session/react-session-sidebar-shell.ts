import { Fragment, createElement } from "react";

import { SolidSlot } from "../shell/solid-slot";

export type ReactSessionSidebarShellProps = {
  leftSidebarWidth: number;
  showUpdatePill: boolean;
  updatePillLabel: string;
  updatePillTitle: string;
  updateVersion?: string | null;
  onUpdatePillClick: () => void;
  onStartResize: (event: any) => void;
  renderSidebar: () => any;
};

export default function ReactSessionSidebarShell(
  props: ReactSessionSidebarShellProps,
) {
  return createElement(
    Fragment,
    null,
    createElement(
      "aside",
      {
        className:
          "relative hidden md:flex shrink-0 flex-col overflow-hidden rounded-[24px] border border-dls-border bg-dls-sidebar p-2.5",
        style: {
          width: `${props.leftSidebarWidth}px`,
          minWidth: `${props.leftSidebarWidth}px`,
        },
      },
      createElement(
        "div",
        { className: "shrink-0" },
        props.showUpdatePill
          ? createElement(
              "button",
              {
                type: "button",
                className:
                  "group relative mb-3 flex w-full items-center gap-1.5 rounded-xl border border-dls-border px-3.5 py-2 text-xs font-medium transition-colors",
                onClick: props.onUpdatePillClick,
                title: props.updatePillTitle,
                "aria-label": props.updatePillTitle,
              },
              createElement(
                "span",
                { className: "min-w-0 flex-1 truncate whitespace-nowrap text-left" },
                props.updatePillLabel,
              ),
              props.updateVersion
                ? createElement(
                    "span",
                    {
                      className:
                        "ml-auto shrink-0 font-mono text-[10px] text-dls-secondary",
                    },
                    `v${props.updateVersion}`,
                  )
                : null,
            )
          : null,
      ),
      createElement(
        "div",
        { className: "flex min-h-0 flex-1" },
        createElement(SolidSlot, {
          slotId: "session-sidebar-shell-slot",
          renderContent: props.renderSidebar,
        }),
      ),
      createElement("div", {
        className:
          "absolute right-0 top-3 hidden h-[calc(100%-24px)] w-2 translate-x-1/2 cursor-col-resize rounded-full bg-transparent transition-colors hover:bg-gray-6/40 md:block",
        onPointerDown: props.onStartResize as any,
        title: "Resize workspace column",
        "aria-label": "Resize workspace column",
      }),
    ),
  );
}
