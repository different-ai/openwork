import { createContext, useContext } from "react";

const PanelSessionContext = createContext<(chatSessionId: string) => string>((chatSessionId) => chatSessionId);

export const PanelSessionProvider = PanelSessionContext.Provider;

export function usePanelSessionFor(chatSessionId: string): string {
  return useContext(PanelSessionContext)(chatSessionId);
}
