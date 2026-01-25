import { Show } from "solid-js";

import { X } from "lucide-solid";
import type { WorkspaceCommand } from "../types";
import { t, currentLocale } from "../../i18n";

import Button from "./button";
import TextInput from "./text-input";

export type CommandRunModalProps = {
  open: boolean;
  command: WorkspaceCommand | null;
  details: string;
  onDetailsChange: (value: string) => void;
  onClose: () => void;
  onRun: () => void;
};

export default function CommandRunModal(props: CommandRunModalProps) {
  const translate = (key: string) => t(key, currentLocale());
  const name = () => props.command?.name ?? "";
  const description = () => props.command?.description ?? "";

  return (
    <Show when={props.open && props.command}>
      <div class="fixed inset-0 z-50 bg-gray-1/60 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="bg-gray-2 border border-gray-6/70 w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden">
          <div class="p-6">
            <div class="flex items-start justify-between gap-4">
              <div>
                <h3 class="text-lg font-semibold text-gray-12">{translate("commands.run_modal_title")}</h3>
                <p class="text-sm text-gray-11 mt-1">{translate("commands.run_modal_description")}</p>
              </div>
              <Button variant="ghost" class="!p-2 rounded-full" onClick={props.onClose}>
                <X size={16} />
              </Button>
            </div>

            <div class="mt-6 space-y-4">
              <div class="rounded-xl border border-gray-6/50 bg-gray-2/40 px-4 py-3">
                <div class="text-xs text-gray-10 uppercase tracking-wide">{translate("commands.command_label")}</div>
                <div class="text-sm font-medium text-gray-12 mt-1">/{name()}</div>
                <Show when={description()}>
                  <div class="text-xs text-gray-10 mt-1">{description()}</div>
                </Show>
              </div>

              <TextInput
                label={translate("commands.details_label")}
                value={props.details}
                onInput={(event) => props.onDetailsChange(event.currentTarget.value)}
                placeholder={translate("commands.details_placeholder")}
                hint={translate("commands.details_hint")}
              />
            </div>

            <div class="mt-6 flex justify-end gap-2">
              <Button variant="outline" onClick={props.onClose}>
                {translate("common.cancel")}
              </Button>
              <Button onClick={props.onRun}>{translate("commands.run_modal_run")}</Button>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
