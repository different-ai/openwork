import { createElement } from "react";
import { Search, X } from "lucide-react";

export type ReactSessionCommandPaletteItem = {
  id: string;
  title: string;
  detail?: string;
  meta?: string;
  action: () => void;
};

export type ReactSessionCommandPaletteProps = {
  mode: string;
  query: string;
  title: string;
  placeholder: string;
  items: ReactSessionCommandPaletteItem[];
  activeIndex: number;
  noMatchesLabel: string;
  backLabel: string;
  closeLabel: string;
  hintNavigateLabel: string;
  hintRunLabel: string;
  setInputRef?: (element: HTMLInputElement | null) => void;
  setOptionRef?: (index: number, element: HTMLButtonElement | null) => void;
  onClose: () => void;
  onBack: () => void;
  onQueryChange: (value: string) => void;
  onHoverIndex: (index: number) => void;
};

export default function ReactSessionCommandPalette(
  props: ReactSessionCommandPaletteProps,
) {
  return createElement(
    "div",
    {
      className:
        "fixed inset-0 z-50 bg-gray-1/60 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto",
      onClick: props.onClose,
    },
    createElement(
      "div",
      {
        className:
          "w-full max-w-2xl mt-12 rounded-2xl border border-dls-border bg-dls-surface shadow-2xl overflow-hidden",
        onClick: (event: any) => event.stopPropagation(),
      },
      createElement(
        "div",
        { className: "border-b border-dls-border px-4 py-3 space-y-2" },
        createElement(
          "div",
          { className: "flex items-center gap-2" },
          props.mode !== "root"
            ? createElement(
                "button",
                {
                  type: "button",
                  className:
                    "h-8 px-2 rounded-md text-xs text-dls-secondary hover:text-dls-text hover:bg-dls-hover transition-colors",
                  onClick: props.onBack,
                },
                props.backLabel,
              )
            : null,
          createElement(Search, { size: 14, className: "text-dls-secondary shrink-0" }),
          createElement("input", {
            ref: props.setInputRef,
            type: "text",
            value: props.query,
            onChange: (event: any) => props.onQueryChange(event.currentTarget.value),
            placeholder: props.placeholder,
            className:
              "min-w-0 flex-1 bg-transparent text-sm text-dls-text placeholder:text-dls-secondary focus:outline-none",
            "aria-label": props.title,
          }),
          createElement(
            "button",
            {
              type: "button",
              className:
                "h-8 w-8 flex items-center justify-center rounded-md text-dls-secondary hover:text-dls-text hover:bg-dls-hover transition-colors",
              onClick: props.onClose,
              "aria-label": props.closeLabel,
            },
            createElement(X, { size: 14 }),
          ),
        ),
        createElement("div", { className: "text-[11px] text-dls-secondary" }, props.title),
      ),
      createElement(
        "div",
        { className: "max-h-[56vh] overflow-y-auto p-2" },
        props.items.length > 0
          ? props.items.map((item, index) =>
              createElement(
                "button",
                {
                  key: item.id,
                  ref: (element: HTMLButtonElement | null) =>
                    props.setOptionRef?.(index, element),
                  type: "button",
                  className: `w-full text-left rounded-xl px-3 py-2.5 transition-colors ${
                    index === props.activeIndex
                      ? "bg-dls-active text-dls-text"
                      : "text-dls-text hover:bg-dls-hover"
                  }`,
                  onMouseEnter: () => props.onHoverIndex(index),
                  onClick: item.action,
                },
                createElement(
                  "div",
                  { className: "flex items-start justify-between gap-3" },
                  createElement(
                    "div",
                    { className: "min-w-0" },
                    createElement(
                      "div",
                      { className: "text-sm font-medium truncate" },
                      item.title,
                    ),
                    item.detail
                      ? createElement(
                          "div",
                          { className: "text-xs text-dls-secondary mt-1 truncate" },
                          item.detail,
                        )
                      : null,
                  ),
                  item.meta
                    ? createElement(
                        "span",
                        {
                          className:
                            "text-[10px] uppercase tracking-wide text-dls-secondary shrink-0",
                        },
                        item.meta,
                      )
                    : null,
                ),
              ),
            )
          : createElement(
              "div",
              { className: "px-3 py-6 text-sm text-dls-secondary text-center" },
              props.noMatchesLabel,
            ),
      ),
      createElement(
        "div",
        {
          className:
            "border-t border-dls-border px-3 py-2 text-[11px] text-dls-secondary flex items-center justify-between gap-2",
        },
        createElement("span", null, props.hintNavigateLabel),
        createElement("span", null, props.hintRunLabel),
      ),
    ),
  );
}
