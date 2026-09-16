import * as React from "react";
import { currentLocale } from "@/i18n";
import {
  createSessionReferenceIndex,
  type SessionReference,
  type SessionReferenceIdentity,
  type SessionReferenceInventory,
} from "./session-reference";

export type { SessionReference, SessionReferenceIdentity, SessionReferenceInventory } from "./session-reference";

export type SessionReferences = {
  resolve: (rawHrefOrId: string) => SessionReference | undefined;
  openReference: (reference: SessionReferenceIdentity) => void;
};

export type SessionReferenceProviderProps = {
  inventories: readonly SessionReferenceInventory[];
  isReferenceCurrent?: (reference: SessionReferenceIdentity) => boolean;
  onOpenReference: (reference: SessionReference) => void;
  children: React.ReactNode;
};

const SessionReferenceContext = React.createContext<SessionReferences | undefined>(undefined);

export function SessionReferenceProvider({
  inventories,
  isReferenceCurrent,
  onOpenReference,
  children,
}: SessionReferenceProviderProps) {
  const locale = currentLocale();
  const nextIndex = React.useMemo(() => createSessionReferenceIndex(inventories), [inventories, locale]);
  const retainedIndex = React.useRef(nextIndex);
  if (retainedIndex.current.revision !== nextIndex.revision) retainedIndex.current = nextIndex;
  const index = retainedIndex.current;
  const latest = React.useRef({ index, isReferenceCurrent, onOpenReference });
  React.useLayoutEffect(() => {
    latest.current = { index, isReferenceCurrent, onOpenReference };
  }, [index, isReferenceCurrent, onOpenReference]);
  React.useLayoutEffect(() => () => {
    latest.current = { ...latest.current, isReferenceCurrent: () => false };
  }, []);
  const openReference = React.useCallback((reference: SessionReferenceIdentity) => {
    const current = latest.current;
    const resolved = current.index.get(reference);
    if (!resolved || (current.isReferenceCurrent && !current.isReferenceCurrent(resolved))) return;
    current.onOpenReference(resolved);
  }, []);
  const value = React.useMemo<SessionReferences>(() => ({
    resolve: (rawHrefOrId) => {
      const reference = index.resolve(rawHrefOrId);
      return reference && (!isReferenceCurrent || isReferenceCurrent(reference)) ? reference : undefined;
    },
    openReference,
  }), [index, isReferenceCurrent, openReference]);
  return <SessionReferenceContext.Provider value={value}>{children}</SessionReferenceContext.Provider>;
}

export function useSessionReferencesMaybe(): SessionReferences | undefined {
  return React.useContext(SessionReferenceContext);
}
