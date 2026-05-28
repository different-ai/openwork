/** @jsxImportSource react */
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { t } from "@/i18n";

const RESET_CONFIRM_PLACEHOLDER = "{resetWord}";
const RESET_CONFIRM_WORD = "RESET";

export type ResetModalProps = {
  open: boolean;
  mode: "onboarding" | "all";
  text: string;
  busy: boolean;
  canReset: boolean;
  hasActiveRuns: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onTextChange: (value: string) => void;
};

export function ResetModal(props: ResetModalProps) {
  const resetConfirmationHint = () => {
    const template = t("settings.reset_confirmation_hint");
    const parts = template.split(RESET_CONFIRM_PLACEHOLDER);
    if (parts.length === 1) return template;
    const [beforeReset, afterReset] = parts;
    return (
      <>
        {beforeReset}
        <span className="font-mono">{RESET_CONFIRM_WORD}</span>
        {afterReset}
      </>
    );
  };

  return (
    <AlertDialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <AlertDialogContent className="w-full max-w-xl overflow-hidden sm:max-w-xl">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {props.mode === "onboarding"
              ? t("settings.reset_onboarding_title")
              : t("settings.reset_app_data_title")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {resetConfirmationHint()}
          </AlertDialogDescription>
        </AlertDialogHeader>

          <div className="mt-6 space-y-4">
            <div className="rounded-xl bg-gray-1/20 border border-gray-6 p-3 text-xs text-gray-11">
              {props.mode === "onboarding"
                ? t("settings.reset_onboarding_warning")
                : t("settings.reset_app_data_warning")}
            </div>

            {props.hasActiveRuns ? (
              <div className="text-xs text-red-11">
                {t("settings.reset_stop_active_runs")}
              </div>
            ) : null}

            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-dls-text">
                {t("settings.reset_confirmation_label")}
              </span>
              <input
                type="text"
                placeholder={t("settings.reset_confirmation_placeholder")}
                value={props.text}
                onChange={(event) => props.onTextChange(event.currentTarget.value)}
                disabled={props.busy}
                className="w-full rounded-xl border border-dls-border bg-dls-surface px-4 py-3 text-[14px] text-dls-text placeholder:text-dls-secondary focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.12)] disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={props.busy}>
              {t("settings.reset_cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={props.onConfirm}
              disabled={!props.canReset}
            >
              {t("settings.reset_confirm_button")}
            </AlertDialogAction>
          </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
