import { createContext, useContext, type ReactNode } from "react";

const UntrustedMarkdownContext = createContext(false);

export function UntrustedMarkdown({ children }: { children: ReactNode }) {
  return <UntrustedMarkdownContext.Provider value>{children}</UntrustedMarkdownContext.Provider>;
}

export function useUntrustedMarkdown(): boolean {
  return useContext(UntrustedMarkdownContext);
}
