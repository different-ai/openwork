import { Show } from "solid-js";
import { X } from "lucide-solid";

import { currentLocale, t } from "../../i18n";
import Button from "./button";

export type RestrictionNoticeModalProps = {
  open: boolean;
  title: string;
  message: string;
  onClose: () => void;
};

export default function RestrictionNoticeModal(props: RestrictionNoticeModalProps) {
  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
        <div class="flex w-full max-w-[480px] flex-col overflow-hidden rounded-[24px] border border-dls-border bg-dls-surface shadow-[var(--dls-shell-shadow)]">
          <div class="flex items-start justify-between gap-4 border-b border-dls-border px-6 py-5">
            <div class="min-w-0">
              <h2 class="text-[20px] font-semibold tracking-[-0.3px] text-dls-text">{props.title}</h2>
            </div>
            <button
              type="button"
              class="inline-flex h-9 w-9 items-center justify-center rounded-full text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
              aria-label={t("common.close", currentLocale())}
              onClick={props.onClose}
            >
              <X size={18} />
            </button>
          </div>

          <div class="px-6 py-6">
            <p class="text-[14px] leading-6 text-dls-secondary">{props.message}</p>
            <div class="mt-6 flex justify-end">
              <Button variant="primary" onClick={props.onClose}>
                {t("common.close", currentLocale())}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
