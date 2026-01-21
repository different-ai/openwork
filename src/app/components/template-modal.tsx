import { Show } from "solid-js";

import { X } from "lucide-solid";
import { t, currentLocale } from "../../i18n";

import Button from "./button";
import TextInput from "./text-input";

export type TemplateModalProps = {
  open: boolean;
  title: string;
  description: string;
  prompt: string;
  scope: "workspace" | "global";
  onClose: () => void;
  onSave: () => void;
  onTitleChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onPromptChange: (value: string) => void;
  onScopeChange: (value: "workspace" | "global") => void;
};

export default function TemplateModal(props: TemplateModalProps) {
  const translate = (key: string) => t(key, currentLocale());

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 bg-gray-1/60 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="bg-gray-2 border border-gray-6/70 w-full max-w-xl rounded-2xl shadow-2xl overflow-hidden">
          <div class="p-6">
            <div class="flex items-start justify-between gap-4">
              <div>
                <h3 class="text-lg font-semibold text-gray-12">{translate("templates.modal_title")}</h3>
                <p class="text-sm text-gray-11 mt-1">{translate("templates.modal_description")}</p>
              </div>
              <Button variant="ghost" class="!p-2 rounded-full" onClick={props.onClose}>
                <X size={16} />
              </Button>
            </div>

            <div class="mt-6 space-y-4">
              <TextInput
                label={translate("templates.title_label")}
                value={props.title}
                onInput={(e) => props.onTitleChange(e.currentTarget.value)}
                placeholder={translate("templates.title_placeholder")}
              />

              <TextInput
                label={translate("templates.description_label")}
                value={props.description}
                onInput={(e) => props.onDescriptionChange(e.currentTarget.value)}
                placeholder={translate("templates.description_placeholder")}
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
                  {translate("templates.workspace")}
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
                  {translate("templates.global")}
                </button>
              </div>

              <label class="block">
                <div class="mb-1 text-xs font-medium text-gray-11">{translate("templates.prompt_label")}</div>
                <textarea
                  class="w-full min-h-40 rounded-xl bg-gray-2/60 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-10 shadow-[0_0_0_1px_rgba(255,255,255,0.08)] focus:outline-none focus:ring-2 focus:ring-gray-6/20"
                  value={props.prompt}
                  onInput={(e) => props.onPromptChange(e.currentTarget.value)}
                  placeholder={translate("templates.prompt_placeholder")}
                />
                <div class="mt-1 text-xs text-gray-10">{translate("templates.prompt_hint")}</div>
              </label>
            </div>

            <div class="mt-6 flex justify-end gap-2">
              <Button variant="outline" onClick={props.onClose}>
                {translate("common.cancel")}
              </Button>
              <Button onClick={props.onSave}>{translate("common.save")}</Button>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
