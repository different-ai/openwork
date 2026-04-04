import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createEffect, onCleanup } from "solid-js";

import ReactSessionHeader, {
  type ReactSessionHeaderProps,
} from "./react-session-header";

export default function ReactSessionHeaderHost(props: ReactSessionHeaderProps) {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  createEffect(() => {
    if (!container) return;
    if (!root) {
      root = createRoot(container);
    }

    root.render(createElement(ReactSessionHeader, props));
  });

  onCleanup(() => {
    root?.unmount();
  });

  return <div ref={container} data-openwork-react-session-header="" />;
}
