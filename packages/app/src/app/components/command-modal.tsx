import { Show } from "solid-js";

import { X } from "lucide-solid";
import { t, currentLocale } from "../../i18n";

import Button from "./button";
import TextInput from "./text-input";

export type CommandModalProps = {
  open: boolean;
  name: string;
  description: string;
  template: string;
  scope: "workspace" | "global";
  error?: string | null;
  onClose: () => void;
  onSave: () => void;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onTemplateChange: (value: string) => void;
  onScopeChange: (value: "workspace" | "global") => void;
};

export default function CommandModal(props: CommandModalProps) {
  const translate = (key: string) => t(key, currentLocale());

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 bg-gray-1/60 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="bg-gray-2 border border-gray-6/70 w-full max-w-xl rounded-2xl shadow-2xl overflow-hidden">
          <div class="p-6">
            <div class="flex items-start justify-between gap-4">
              <div>
                <h3 class="text-lg font-semibold text-gray-12">{translate("commands.modal_title")}</h3>
                <p class="text-sm text-gray-11 mt-1">{translate("commands.modal_description")}</p>
              </div>
              <Button variant="ghost" class="!p-2 rounded-full" onClick={props.onClose}>
                <X size={16} />
              </Button>
            </div>

            <div class="mt-6 space-y-4">
              <TextInput
                label={translate("commands.name_label")}
                value={props.name}
                onInput={(event) => props.onNameChange(event.currentTarget.value)}
                placeholder={translate("commands.name_placeholder")}
                hint={translate("commands.name_hint")}
              />

              <TextInput
                label={translate("commands.description_label")}
                value={props.description}
                onInput={(event) => props.onDescriptionChange(event.currentTarget.value)}
                placeholder={translate("commands.description_placeholder")}
              />

              <div class="grid grid-cols-2 gap-2">
                <button
                  class={`px-3 py-2 rounded-xl border text-sm transition-colors ${
                    props.scope === "workspace"
                      ? "bg-gray-12/10 text-gray-12 border-gray-6/20"
                      : "text-gray-11 border-gray-6 hover:text-gray-12"
                  }`}
                  onClick={() => props.onScopeChange("workspace")}
                  type="button"
                >
                  {translate("commands.workspace")}
                </button>
                <button
                  class={`px-3 py-2 rounded-xl border text-sm transition-colors ${
                    props.scope === "global"
                      ? "bg-gray-12/10 text-gray-12 border-gray-6/20"
                      : "text-gray-11 border-gray-6 hover:text-gray-12"
                  }`}
                  onClick={() => props.onScopeChange("global")}
                  type="button"
                >
                  {translate("commands.global")}
                </button>
              </div>

              <label class="block">
                <div class="mb-1 text-xs font-medium text-gray-11">{translate("commands.template_label")}</div>
                <textarea
                  class="w-full min-h-40 rounded-xl bg-gray-2/60 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-10 shadow-[0_0_0_1px_rgba(255,255,255,0.08)] focus:outline-none focus:ring-2 focus:ring-gray-6/20"
                  value={props.template}
                  onInput={(event) => props.onTemplateChange(event.currentTarget.value)}
                  placeholder={translate("commands.template_placeholder")}
                />
                <div class="mt-1 text-xs text-gray-10">{translate("commands.template_hint")}</div>
              </label>
            </div>

            <div class="mt-6 flex items-center justify-between gap-2">
              {/* Error message on the left */}
              <div class="flex-1">
                <Show when={props.error}>
                  <div class="text-sm text-red-11">{props.error}</div>
                </Show>
              </div>

              {/* Buttons on the right */}
              <div class="flex gap-2">
                <Button variant="outline" onClick={props.onClose}>
                  {translate("common.cancel")}
                </Button>
                <Button onClick={props.onSave}>{translate("common.save")}</Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
