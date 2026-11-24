/** @jsxImportSource react */
import {
  createContext,
  useCallback,
  use,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { RestrictionNoticeModal } from "../../design-system/restriction-notice-modal";

export type RestrictionNoticePayload = {
  title: string;
  message: string;
};

export type RestrictionNoticeController = {
  show: (payload: RestrictionNoticePayload) => void;
  dismiss: () => void;
};

const RestrictionNoticeContext = createContext<RestrictionNoticeController | undefined>(
  undefined,
);

type RestrictionNoticeProviderProps = {
  children: ReactNode;
};

export function RestrictionNoticeProvider({ children }: RestrictionNoticeProviderProps) {
  const [notice, setNotice] = useState<RestrictionNoticePayload | null>(null);

  const show = useCallback((payload: RestrictionNoticePayload) => {
    setNotice(payload);
  }, []);

  const dismiss = useCallback(() => {
    setNotice(null);
  }, []);

  const value = useMemo<RestrictionNoticeController>(
    () => ({ show, dismiss }),
    [dismiss, show],
  );

  return (
    <RestrictionNoticeContext.Provider value={value}>
      {children}
      <RestrictionNoticeModal
        open={notice !== null}
        title={notice?.title ?? "Restriction"}
        message={notice?.message ?? ""}
        onClose={dismiss}
      />
    </RestrictionNoticeContext.Provider>
  );
}

export function useRestrictionNotice(): RestrictionNoticeController {
  const context = use(RestrictionNoticeContext);
  if (!context) {
    throw new Error(
      "useRestrictionNotice must be used within a RestrictionNoticeProvider",
    );
  }
  return context;
}
