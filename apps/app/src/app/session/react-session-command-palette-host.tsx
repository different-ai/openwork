import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createEffect, onCleanup } from "solid-js";

import ReactSessionCommandPalette, {
  type ReactSessionCommandPaletteProps,
} from "./react-session-command-palette";

export default function ReactSessionCommandPaletteHost(
  props: ReactSessionCommandPaletteProps,
) {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  createEffect(() => {
    const snapshot: ReactSessionCommandPaletteProps = {
      mode: props.mode,
      query: props.query,
      title: props.title,
      placeholder: props.placeholder,
      items: props.items,
      activeIndex: props.activeIndex,
      noMatchesLabel: props.noMatchesLabel,
      backLabel: props.backLabel,
      closeLabel: props.closeLabel,
      hintNavigateLabel: props.hintNavigateLabel,
      hintRunLabel: props.hintRunLabel,
      setInputRef: props.setInputRef,
      setOptionRef: props.setOptionRef,
      onClose: props.onClose,
      onBack: props.onBack,
      onQueryChange: props.onQueryChange,
      onHoverIndex: props.onHoverIndex,
    };

    if (!container) return;
    if (!root) {
      root = createRoot(container);
    }

    root.render(createElement(ReactSessionCommandPalette, snapshot));
  });

  onCleanup(() => {
    root?.unmount();
  });

  return <div ref={container} data-openwork-react-session-command-palette="" />;
}
