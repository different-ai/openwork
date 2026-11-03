import { createContext, useContext, type ReactNode } from "react";

const UntrustedMarkdownContext = createContext(false);

/**
 * Marks every Markdown block below as untrusted prose (a task on another
 * computer): it renders with the `remote` profile, so no image, video or raw
 * HTML from that text can make the viewer's browser request a URL.
 */
export function UntrustedMarkdown({ children }: { children: ReactNode }) {
  return <UntrustedMarkdownContext.Provider value>{children}</UntrustedMarkdownContext.Provider>;
}

export function useUntrustedMarkdown(): boolean {
  return useContext(UntrustedMarkdownContext);
}
