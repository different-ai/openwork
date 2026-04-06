import { createEffect, onCleanup, onMount } from "solid-js";
import { createElement, Fragment, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";

type ReactIslandProps<T extends object> = {
  component: ComponentType<T>;
  props: T;
  class?: string;
  instanceKey?: string;
};

export function ReactIsland<T extends object>(props: ReactIslandProps<T>) {
  let container: HTMLDivElement | undefined;
  let root: Root | null = null;
  const queryClient = new QueryClient();

  const render = () => {
    if (!root) return;
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(Fragment, { key: props.instanceKey }, createElement(props.component, props.props)),
      ),
    );
  };

  onMount(() => {
    if (!container) return;
    root = createRoot(container);
    render();
  });

  createEffect(() => {
    props.props;
    props.instanceKey;
    render();
  });

  onCleanup(() => {
    root?.unmount();
    root = null;
  });

  return <div ref={container} class={props.class} />;
}
