import { For, Show } from "solid-js";
import { CheckCircle2, Circle, X } from "lucide-solid";
import { LANGUAGE_OPTIONS, type Language, t, currentLocale } from "../../i18n";
import Button from "./button";

export type LanguagePickerModalProps = {
  open: boolean;
  currentLanguage: Language;
  onSelect: (language: Language) => void;
  onClose: () => void;
};

export default function LanguagePickerModal(props: LanguagePickerModalProps) {
  // Use reactive translation that updates when locale changes
  const translate = (key: string) => t(key, currentLocale());

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 bg-gray-1/60 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="bg-gray-2 border border-gray-6/70 w-full max-w-md rounded-2xl shadow-2xl overflow-hidden">
          <div class="p-6">
            <div class="flex items-start justify-between gap-4 mb-5">
              <div>
                <h3 class="text-lg font-semibold text-gray-12">{translate("settings.language")}</h3>
                <p class="text-sm text-gray-11 mt-1">{translate("settings.language.description")}</p>
              </div>
              <Button variant="ghost" class="!p-2 rounded-full" onClick={props.onClose}>
                <X size={16} />
              </Button>
            </div>

            <div class="space-y-2">
              <For each={LANGUAGE_OPTIONS}>
                {(option) => {
                  const isActive = () => props.currentLanguage === option.value;
                  
                  return (
                    <button
                      class={`w-full text-left rounded-xl border px-4 py-3 transition-colors ${
                        isActive()
                          ? "border-gray-6/20 bg-gray-12/5"
                          : "border-gray-6/70 bg-gray-1/40 hover:bg-gray-1/60"
                      }`}
                      onClick={() => {
                        props.onSelect(option.value);
                      }}
                    >
                      <div class="flex items-center justify-between gap-3">
                        <div class="flex-1 min-w-0">
                          <div class="font-medium text-sm text-gray-12">{option.nativeName}</div>
                          <Show when={option.label !== option.nativeName}>
                            <div class="text-xs text-gray-10 mt-0.5">{option.label}</div>
                          </Show>
                        </div>
                        <div class="text-gray-10 shrink-0">
                          <Show
                            when={isActive()}
                            fallback={<Circle size={14} />}
                          >
                            <CheckCircle2 size={14} class="text-green-11" />
                          </Show>
                        </div>
                      </div>
                    </button>
                  );
                }}
              </For>
            </div>

            <div class="mt-5 flex justify-end">
              <Button variant="outline" onClick={props.onClose}>
                {translate("common.cancel")}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
