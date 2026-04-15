import { createContext, type ParentProps } from "solid-js";

import type { OpenworkServerStore } from "./openwork-server-store";

const OpenworkServerContext = createContext<OpenworkServerStore>();

export function OpenworkServerProvider(props: ParentProps<{ store: OpenworkServerStore }>) {
  return (
    <OpenworkServerContext.Provider value={props.store}>
      {props.children}
    </OpenworkServerContext.Provider>
  );
}
