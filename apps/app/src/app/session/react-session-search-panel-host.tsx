import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createEffect, onCleanup } from "solid-js";

import ReactSessionSearchPanel, {
  type ReactSessionSearchPanelProps,
} from "./react-session-search-panel";

export default function ReactSessionSearchPanelHost(props: ReactSessionSearchPanelProps) {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  createEffect(() => {
    const snapshot: ReactSessionSearchPanelProps = {
      query: props.query,
      positionLabel: props.positionLabel,
      hasHits: props.hasHits,
      placeholder: props.placeholder,
      prevLabel: props.prevLabel,
      nextLabel: props.nextLabel,
      closeLabel: props.closeLabel,
      setInputRef: props.setInputRef,
      onQueryChange: props.onQueryChange,
      onMovePrev: props.onMovePrev,
      onMoveNext: props.onMoveNext,
      onClose: props.onClose,
      onSubmitStep: props.onSubmitStep,
    };

    if (!container) return;
    if (!root) {
      root = createRoot(container);
    }

    root.render(createElement(ReactSessionSearchPanel, snapshot));
  });

  onCleanup(() => {
    const currentRoot = root;
    root = undefined;
    if (!currentRoot) return;
    queueMicrotask(() => {
      currentRoot.unmount();
    });
  });

  return <div ref={container} data-openwork-react-session-search="" />;
}
