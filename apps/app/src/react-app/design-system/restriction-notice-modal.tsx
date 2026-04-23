/** @jsxImportSource react */
import { X } from "lucide-react";

import { currentLocale, t } from "../../i18n";
import { Button } from "./button";

export type RestrictionNoticeModalProps = {
  open: boolean;
  title: string;
  message: string;
  onClose: () => void;
};

/**
 * React port of the Solid `RestrictionNoticeModal`
 * (`apps/app/src/app/components/restriction-notice-modal.tsx` on dev — added
 * as part of #1505 "enforce desktop restriction policies").
 *
 * Purposefully framework-free except for the design-system Button: this is
 * a thin, declarative surface driven by the cloud domain when an org gates
 * a feature (blockZenModel, disallowNonCloudModels, blockMultipleWorkspaces).
 */
export function RestrictionNoticeModal(props: RestrictionNoticeModalProps) {
  if (!props.open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="flex w-full max-w-[480px] flex-col overflow-hidden rounded-[24px] border border-dls-border bg-dls-surface shadow-[var(--dls-shell-shadow)]">
        <div className="flex items-start justify-between gap-4 border-b border-dls-border px-6 py-5">
          <div className="min-w-0">
            <h2 className="text-[20px] font-semibold tracking-[-0.3px] text-dls-text">
              {props.title}
            </h2>
          </div>
          <button
            type="button"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
            aria-label={t("common.close", currentLocale())}
            onClick={props.onClose}
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-6">
          <p className="text-[14px] leading-6 text-dls-secondary">
            {props.message}
          </p>
          <div className="mt-6 flex justify-end">
            <Button variant="primary" onClick={props.onClose}>
              {t("common.close", currentLocale())}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default RestrictionNoticeModal;
