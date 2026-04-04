import { createElement } from "react";
import { Check, ListTodo, Minimize2 } from "lucide-react";

import type { TodoItem } from "../types";

export type ReactSessionTodoPanelProps = {
  items: TodoItem[];
  expanded: boolean;
  label: string;
  onToggleExpanded: () => void;
};

export default function ReactSessionTodoPanel(props: ReactSessionTodoPanelProps) {
  return createElement(
    "div",
    { className: "mx-auto w-full max-w-[800px] px-4" },
    createElement(
      "div",
      {
        className:
          "rounded-t-[20px] border border-b-0 border-dls-border bg-dls-surface shadow-[var(--dls-card-shadow)]",
      },
      createElement(
        "button",
        {
          type: "button",
          className:
            "flex w-full items-center justify-between rounded-t-[20px] px-4 py-3 text-xs text-gray-9 transition-colors hover:bg-gray-2/50",
          onClick: props.onToggleExpanded,
        },
        createElement(
          "div",
          { className: "flex items-center gap-2" },
          createElement(ListTodo, { size: 14, className: "text-gray-8" }),
          createElement("span", { className: "text-gray-11 font-medium" }, props.label),
        ),
        createElement(Minimize2, {
          size: 12,
          className: `text-gray-8 transition-transform ${props.expanded ? "" : "rotate-180"}`,
        }),
      ),
      props.expanded
        ? createElement(
            "div",
            {
              className:
                "max-h-60 overflow-auto border-t border-dls-border px-4 pb-3 space-y-2.5",
            },
            props.items.map((todo, index) => {
              const done = todo.status === "completed";
              const cancelled = todo.status === "cancelled";
              const active = todo.status === "in_progress";
              return createElement(
                "div",
                { key: todo.id, className: "flex items-start gap-2.5 pt-2.5 first:pt-2.5" },
                createElement(
                  "div",
                  { className: "flex items-center gap-1.5 pt-0.5" },
                  createElement(
                    "div",
                    {
                      className: `h-4.5 w-4.5 rounded-full border flex items-center justify-center ${
                        done
                          ? "border-green-6 bg-green-2 text-green-11"
                          : active
                            ? "border-amber-6 bg-amber-2 text-amber-11"
                            : cancelled
                              ? "border-gray-6 bg-gray-2 text-gray-8"
                              : "border-gray-6 bg-gray-1 text-gray-8"
                      }`,
                    },
                    done ? createElement(Check, { size: 10 }) : null,
                    !done && active
                      ? createElement("span", {
                          className: "h-1.5 w-1.5 rounded-full bg-amber-9",
                        })
                      : null,
                  ),
                ),
                createElement(
                  "div",
                  {
                    className: `flex-1 text-sm leading-relaxed ${
                      cancelled ? "text-gray-9 line-through" : "text-gray-12"
                    }`,
                  },
                  createElement("span", { className: "text-gray-9 mr-1.5" }, `${index + 1}.`),
                  todo.content,
                ),
              );
            }),
          )
        : null,
    ),
  );
}
