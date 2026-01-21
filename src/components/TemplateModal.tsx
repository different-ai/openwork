import { Show } from "solid-js";
import { useI18n } from "../i18n";

import { X } from "lucide-solid";

import Button from "./Button";
import TextInput from "./TextInput";

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
  const [t] = useI18n();
  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="bg-zinc-900 border border-zinc-800/70 w-full max-w-xl rounded-2xl shadow-2xl overflow-hidden">
          <div class="p-6">
            <div class="flex items-start justify-between gap-4">
              <div>
                <h3 class="text-lg font-semibold text-white">{t("components.template_modal.title")}</h3>
                <p class="text-sm text-zinc-400 mt-1">{t("components.template_modal.subtitle")}</p>
              </div>
              <Button variant="ghost" class="!p-2 rounded-full" onClick={props.onClose}>
                <X size={16} />
              </Button>
            </div>

            <div class="mt-6 space-y-4">
              <TextInput
                label={t("components.template_modal.fields.title")}
                value={props.title}
                onInput={(e) => props.onTitleChange(e.currentTarget.value)}
                placeholder={t("components.template_modal.fields.title_placeholder")}
              />

              <TextInput
                label={t("components.template_modal.fields.description")}
                value={props.description}
                onInput={(e) => props.onDescriptionChange(e.currentTarget.value)}
                placeholder={t("components.template_modal.fields.description_placeholder")}
              />

              <div class="grid grid-cols-2 gap-2">
                <button
                  class={`px-3 py-2 rounded-xl border text-sm transition-colors ${props.scope === "workspace"
                      ? "bg-white/10 text-white border-white/20"
                      : "text-zinc-400 border-zinc-800 hover:text-white"
                    }`}
                  onClick={() => props.onScopeChange("workspace")}
                  type="button"
                >
                  {t("components.template_modal.fields.scope_workspace")}
                </button>
                <button
                  class={`px-3 py-2 rounded-xl border text-sm transition-colors ${props.scope === "global"
                      ? "bg-white/10 text-white border-white/20"
                      : "text-zinc-400 border-zinc-800 hover:text-white"
                    }`}
                  onClick={() => props.onScopeChange("global")}
                  type="button"
                >
                  {t("components.template_modal.fields.scope_global")}
                </button>
              </div>

              <label class="block">
                <div class="mb-1 text-xs font-medium text-neutral-300">{t("components.template_modal.fields.prompt")}</div>
                <textarea
                  class="w-full min-h-40 rounded-xl bg-neutral-900/60 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 shadow-[0_0_0_1px_rgba(255,255,255,0.08)] focus:outline-none focus:ring-2 focus:ring-white/20"
                  value={props.prompt}
                  onInput={(e) => props.onPromptChange(e.currentTarget.value)}
                  placeholder={t("components.template_modal.fields.prompt_placeholder")}
                />
                <div class="mt-1 text-xs text-neutral-500">{t("components.template_modal.fields.prompt_help")}</div>
              </label>
            </div>

            <div class="mt-6 flex justify-end gap-2">
              <Button variant="outline" onClick={props.onClose}>
                {t("components.template_modal.actions.cancel")}
              </Button>
              <Button onClick={props.onSave}>{t("components.template_modal.actions.save")}</Button>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
