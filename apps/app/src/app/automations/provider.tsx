import { createContext, useContext, type ParentProps } from "solid-js";

import type { AutomationsStore } from "../context/automations";

const AutomationsContext = createContext<AutomationsStore>();

export function AutomationsProvider(props: ParentProps<{ store: AutomationsStore }>) {
  return (
    <AutomationsContext.Provider value={props.store}>
      {props.children}
    </AutomationsContext.Provider>
  );
}

export function useAutomations() {
  const context = useContext(AutomationsContext);
  if (!context) {
    throw new Error("useAutomations must be used within an AutomationsProvider");
  }
  return context;
}
