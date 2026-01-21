import { Match, Show, Switch } from "solid-js";
import { useI18n } from "../i18n";

import { X } from "lucide-solid";

import Button from "./Button";
import TextInput from "./TextInput";

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

export default function ResetModal(props: ResetModalProps) {
  const [t] = useI18n();
  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="bg-zinc-900 border border-zinc-800/70 w-full max-w-xl rounded-2xl shadow-2xl overflow-hidden">
          <div class="p-6">
            <div class="flex items-start justify-between gap-4">
              <div>
                <h3 class="text-lg font-semibold text-white">
                  <Switch>
                    <Match when={props.mode === "onboarding"}>{t("components.reset_modal.title_onboarding")}</Match>
                    <Match when={true}>{t("components.reset_modal.title_app_data")}</Match>
                  </Switch>
                </h3>
                <p class="text-sm text-zinc-400 mt-1">
                  {t("components.reset_modal.desc_prefix")} <span class="font-mono">RESET</span> {t("components.reset_modal.desc_suffix")}
                </p>
              </div>
              <Button
                variant="ghost"
                class="!p-2 rounded-full"
                onClick={props.onClose}
                disabled={props.busy}
              >
                <X size={16} />
              </Button>
            </div>

            <div class="mt-6 space-y-4">
              <div class="rounded-xl bg-black/20 border border-zinc-800 p-3 text-xs text-zinc-400">
                <Switch>
                  <Match when={props.mode === "onboarding"}>
                    {t("components.reset_modal.explanation_onboarding")}
                  </Match>
                  <Match when={true}>{t("components.reset_modal.explanation_app_data")}</Match>
                </Switch>
              </div>

              <Show when={props.hasActiveRuns}>
                <div class="text-xs text-red-300">{t("components.reset_modal.active_runs_warning")}</div>
              </Show>

              <TextInput
                label={t("components.reset_modal.confirmation_label")}
                placeholder={t("components.reset_modal.placeholder")}
                value={props.text}
                onInput={(e) => props.onTextChange(e.currentTarget.value)}
                disabled={props.busy}
              />
            </div>

            <div class="mt-6 flex justify-end gap-2">
              <Button variant="outline" onClick={props.onClose} disabled={props.busy}>
                {t("components.reset_modal.actions.cancel")}
              </Button>
              <Button variant="danger" onClick={props.onConfirm} disabled={!props.canReset}>
                {t("components.reset_modal.actions.confirm")}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
