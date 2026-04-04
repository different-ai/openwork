import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createEffect, onCleanup } from "solid-js";

import ReactSessionTodoPanel, {
  type ReactSessionTodoPanelProps,
} from "./react-session-todo-panel";

export default function ReactSessionTodoPanelHost(props: ReactSessionTodoPanelProps) {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  createEffect(() => {
    const snapshot: ReactSessionTodoPanelProps = {
      items: props.items,
      expanded: props.expanded,
      label: props.label,
      onToggleExpanded: props.onToggleExpanded,
    };

    if (!container) return;
    if (!root) {
      root = createRoot(container);
    }

    root.render(createElement(ReactSessionTodoPanel, snapshot));
  });

  onCleanup(() => {
    const currentRoot = root;
    root = undefined;
    if (!currentRoot) return;
    queueMicrotask(() => {
      currentRoot.unmount();
    });
  });

  return <div ref={container} data-openwork-react-session-todos="" />;
}
