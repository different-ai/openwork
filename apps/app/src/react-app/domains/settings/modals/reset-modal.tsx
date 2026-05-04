/** @jsxImportSource react */
import type { ReactNode } from "react";
import { X } from "lucide-react";

import { t, type Language } from "../../../../i18n";

const RESET_CONFIRM_PLACEHOLDER = "{resetWord}";
const RESET_CONFIRM_WORD = "RESET";

const buttonBaseClass =
  "inline-flex items-center justify-center rounded-full px-4 py-2 text-[13px] font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.18)] disabled:cursor-not-allowed disabled:opacity-60";
const outlineButtonClass = `${buttonBaseClass} border border-dls-border bg-dls-surface text-dls-text hover:bg-[var(--dls-hover)]`;
const dangerButtonClass = `${buttonBaseClass} bg-red-9 text-white hover:bg-red-10`;
const ghostIconButtonClass =
  "inline-flex h-8 w-8 items-center justify-center rounded-full text-gray-10 transition-colors hover:bg-[var(--dls-hover)] disabled:cursor-not-allowed disabled:opacity-60";

export type ResetModalProps = {
  open: boolean;
  mode: "onboarding" | "all";
  text: string;
  busy: boolean;
  canReset: boolean;
  hasActiveRuns: boolean;
  language: Language;
  onClose: () => void;
  onConfirm: () => void;
  onTextChange: (value: string) => void;
};

export function ResetModal(props: ResetModalProps) {
  const translate = (key: string) => t(key, props.language);

  const resetConfirmationHint = (): ReactNode => {
    const template = translate("settings.reset_confirmation_hint");
    const parts = template.split(RESET_CONFIRM_PLACEHOLDER);
    if (parts.length === 1) return template;
    const nodes: ReactNode[] = [];
    parts.forEach((part, index) => {
      nodes.push(<span key={`part-${index}`}>{part}</span>);
      if (index < parts.length - 1) {
        nodes.push(
          <span key={`word-${index}`} className="font-mono">
            {RESET_CONFIRM_WORD}
          </span>,
        );
      }
    });
    return nodes;
  };

  if (!props.open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-gray-1/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-gray-2 border border-gray-6/70 w-full max-w-xl rounded-2xl shadow-2xl overflow-hidden">
        <div className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-lg font-semibold text-gray-12">
                {props.mode === "onboarding"
                  ? translate("settings.reset_onboarding_title")
                  : translate("settings.reset_app_data_title")}
              </h3>
              <p className="text-sm text-gray-11 mt-1">
                {resetConfirmationHint()}
              </p>
            </div>
            <button
              type="button"
              className={ghostIconButtonClass}
              onClick={props.onClose}
              disabled={props.busy}
            >
              <X size={16} />
            </button>
          </div>

          <div className="mt-6 space-y-4">
            <div className="rounded-xl bg-gray-1/20 border border-gray-6 p-3 text-xs text-gray-11">
              {props.mode === "onboarding"
                ? translate("settings.reset_onboarding_warning")
                : translate("settings.reset_app_data_warning")}
            </div>

            {props.hasActiveRuns ? (
              <div className="text-xs text-red-11">
                {translate("settings.reset_stop_active_runs")}
              </div>
            ) : null}

            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-dls-text">
                {translate("settings.reset_confirmation_label")}
              </span>
              <input
                type="text"
                placeholder={translate("settings.reset_confirmation_placeholder")}
                value={props.text}
                onChange={(event) => props.onTextChange(event.currentTarget.value)}
                disabled={props.busy}
                className="w-full rounded-xl border border-dls-border bg-dls-surface px-4 py-3 text-[14px] text-dls-text placeholder:text-dls-secondary focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.12)] disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>
          </div>

          <div className="mt-6 flex justify-end gap-2">
            <button
              type="button"
              className={outlineButtonClass}
              onClick={props.onClose}
              disabled={props.busy}
            >
              {translate("settings.reset_cancel")}
            </button>
            <button
              type="button"
              className={dangerButtonClass}
              onClick={props.onConfirm}
              disabled={!props.canReset}
            >
              {translate("settings.reset_confirm_button")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
