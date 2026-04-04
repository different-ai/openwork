import { createElement } from "react";
import { Search, X } from "lucide-react";

export type ReactSessionSearchPanelProps = {
  query: string;
  positionLabel: string;
  hasHits: boolean;
  placeholder: string;
  prevLabel: string;
  nextLabel: string;
  closeLabel: string;
  setInputRef?: (element: HTMLInputElement | null) => void;
  onQueryChange: (value: string) => void;
  onMovePrev: () => void;
  onMoveNext: () => void;
  onClose: () => void;
  onSubmitStep: (direction: -1 | 1) => void;
};

export default function ReactSessionSearchPanel(props: ReactSessionSearchPanelProps) {
  return createElement(
    "div",
    { className: "border-b border-dls-border bg-dls-sidebar/70 px-4 py-2 md:px-6" },
    createElement(
      "div",
      {
        className:
          "mx-auto flex w-full max-w-[800px] items-center gap-2 rounded-[16px] border border-dls-border bg-dls-surface px-3 py-2 shadow-[var(--dls-card-shadow)]",
      },
      createElement(Search, { size: 14, className: "text-gray-9" }),
      createElement("input", {
        ref: props.setInputRef,
        type: "text",
        value: props.query,
        onChange: (event: any) => props.onQueryChange(event.currentTarget.value),
        onKeyDown: (event: any) => {
          if (event.key === "Enter") {
            event.preventDefault();
            props.onSubmitStep(event.shiftKey ? -1 : 1);
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            props.onClose();
          }
        },
        className:
          "min-w-0 flex-1 bg-transparent text-sm text-gray-11 placeholder:text-gray-9 focus:outline-none",
        placeholder: props.placeholder,
        "aria-label": props.placeholder,
      }),
      createElement(
        "span",
        { className: "text-[11px] text-gray-10 tabular-nums" },
        props.positionLabel,
      ),
      createElement(
        "button",
        {
          type: "button",
          className:
            "rounded-md border border-dls-border px-2 py-1 text-[11px] text-gray-10 transition-colors hover:bg-gray-2 hover:text-gray-12 disabled:opacity-60",
          disabled: !props.hasHits,
          onClick: props.onMovePrev,
          "aria-label": props.prevLabel,
        },
        props.prevLabel,
      ),
      createElement(
        "button",
        {
          type: "button",
          className:
            "rounded-md border border-dls-border px-2 py-1 text-[11px] text-gray-10 transition-colors hover:bg-gray-2 hover:text-gray-12 disabled:opacity-60",
          disabled: !props.hasHits,
          onClick: props.onMoveNext,
          "aria-label": props.nextLabel,
        },
        props.nextLabel,
      ),
      createElement(
        "button",
        {
          type: "button",
          className:
            "flex h-7 w-7 items-center justify-center rounded-md text-gray-10 transition-colors hover:bg-gray-2 hover:text-gray-12",
          onClick: props.onClose,
          "aria-label": props.closeLabel,
        },
        createElement(X, { size: 14 }),
      ),
    ),
  );
}
