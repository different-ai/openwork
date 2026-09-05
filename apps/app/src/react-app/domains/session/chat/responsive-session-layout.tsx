/** @jsxImportSource react */
import type { Ref } from "react";

export type NarrowSessionPane = "chat" | "split" | "panel";

export type NarrowPaneOption = {
  id: NarrowSessionPane;
  label: string;
};

export const NARROW_PANE_MIN_TARGET_PX = 44;

export function shouldShowNarrowPaneSwitcher(
  narrow: boolean,
  hasSplit: boolean,
  hasPanel: boolean,
) {
  return narrow && (hasSplit || hasPanel);
}

export function availableNarrowPane(
  pane: NarrowSessionPane,
  hasSplit: boolean,
  hasPanel: boolean,
): NarrowSessionPane {
  if (pane === "split" && !hasSplit) return "chat";
  if (pane === "panel" && !hasPanel) return "chat";
  return pane;
}

export function NarrowPaneSwitcher(props: {
  activePane: NarrowSessionPane;
  options: NarrowPaneOption[];
  navigationRef?: Ref<HTMLElement>;
  onSelect: (pane: NarrowSessionPane) => void;
}) {
  const selectRelativePane = (currentIndex: number, key: string) => {
    const lastIndex = props.options.length - 1;
    const nextIndex = key === "ArrowRight"
      ? currentIndex === lastIndex ? 0 : currentIndex + 1
      : key === "ArrowLeft"
        ? currentIndex === 0 ? lastIndex : currentIndex - 1
        : key === "Home"
          ? 0
          : key === "End"
            ? lastIndex
            : null;
    if (nextIndex === null) return false;
    const nextPane = props.options[nextIndex];
    if (!nextPane) return false;
    props.onSelect(nextPane.id);
    return true;
  };

  return (
    <nav
      ref={props.navigationRef}
      className="grid shrink-0 border-b border-border bg-dls-surface px-1"
      style={{ gridTemplateColumns: `repeat(${props.options.length}, minmax(0, 1fr))` }}
      role="tablist"
      aria-label="Visible session pane"
      data-narrow-pane-switcher
    >
      {props.options.map((option, index) => {
        const active = option.id === props.activePane;
        return (
          <button
            key={option.id}
            id={`narrow-session-tab-${option.id}`}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={`narrow-session-pane-${option.id}`}
            tabIndex={active ? 0 : -1}
            data-narrow-pane={option.id}
            className={`min-w-0 truncate border-b-2 px-2 text-xs font-medium transition-colors ${
              active
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            style={{ minHeight: NARROW_PANE_MIN_TARGET_PX }}
            onClick={() => props.onSelect(option.id)}
            onKeyDown={(event) => {
              if (!selectRelativePane(index, event.key)) return;
              event.preventDefault();
            }}
          >
            {option.label}
          </button>
        );
      })}
    </nav>
  );
}
