/** @jsxImportSource react */
import {
  createContext,
  useCallback,
  useContext,
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
  /**
   * Show a restriction notice modal. Replaces any currently-shown notice.
   */
  show: (payload: RestrictionNoticePayload) => void;
  /**
   * Dismiss whichever notice is currently visible. Safe to call when none is shown.
   */
  dismiss: () => void;
};

const RestrictionNoticeContext = createContext<RestrictionNoticeController | undefined>(
  undefined,
);

type RestrictionNoticeProviderProps = {
  children: ReactNode;
};

/**
 * App-wide restriction notice surface ported from Solid. Owns one active
 * `RestrictionNoticeModal` and exposes `{ show, dismiss }` to callers via
 * `useRestrictionNotice()`. Call sites:
 *
 *   const notice = useRestrictionNotice();
 *   if (checkDesktopRestriction({ restriction: "blockMultipleWorkspaces" })) {
 *     notice.show({ title: "...", message: "..." });
 *     return;
 *   }
 *
 * The modal lives inside the provider so consumers don't need to render it;
 * this matches Solid's app.tsx wiring where `RestrictionNoticeModal` is a
 * single child of the root shell.
 */
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
  const context = useContext(RestrictionNoticeContext);
  if (!context) {
    throw new Error(
      "useRestrictionNotice must be used within a RestrictionNoticeProvider",
    );
  }
  return context;
}
