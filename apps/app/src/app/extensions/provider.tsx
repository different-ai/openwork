import { createContext, useContext, type ParentProps } from "solid-js";

import type { ExtensionsStore } from "../context/extensions";

const ExtensionsContext = createContext<ExtensionsStore>();

export function ExtensionsProvider(props: ParentProps<{ store: ExtensionsStore }>) {
  return (
    <ExtensionsContext.Provider value={props.store}>
      {props.children}
    </ExtensionsContext.Provider>
  );
}

export function useExtensions() {
  const context = useContext(ExtensionsContext);
  if (!context) {
    throw new Error("useExtensions must be used within an ExtensionsProvider");
  }
  return context;
}
