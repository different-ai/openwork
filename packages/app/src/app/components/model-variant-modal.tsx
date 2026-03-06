import { For, Show } from "solid-js";
import { X, Check } from "lucide-solid";
import Button from "./button";
import { t, currentLocale } from "../../i18n";

export type ModelVariantModalProps = {
  open: boolean;
  onClose: () => void;
  value: string | null;
  onSelect: (value: string) => void;
};

export default function ModelVariantModal(props: ModelVariantModalProps) {
  const translate = (key: string) => t(key, currentLocale());

  const options = () => [
    { value: "none", label: translate("settings.model_variant_none"), description: translate("settings.model_variant_none_desc") },
    { value: "low", label: translate("settings.model_variant_low"), description: translate("settings.model_variant_low_desc") },
    { value: "medium", label: translate("settings.model_variant_medium"), description: translate("settings.model_variant_medium_desc") },
    { value: "high", label: translate("settings.model_variant_high"), description: translate("settings.model_variant_high_desc") },
    { value: "xhigh", label: translate("settings.model_variant_xhigh"), description: translate("settings.model_variant_xhigh_desc") },
  ];

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-[60] bg-gray-1/70 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="bg-gray-2 border border-gray-6/70 w-full max-w-md rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[calc(100vh-5rem)]">
          <div class="px-6 py-4 border-b border-gray-6/50 flex flex-col gap-1 items-start justify-between relative">
            <h3 class="text-base font-semibold text-gray-12">{translate("settings.model_variant_title")}</h3>
            <p class="text-xs text-gray-10">{translate("settings.model_variant_description")}</p>
            <button
              onClick={props.onClose}
              class="absolute top-4 right-4 p-1.5 rounded-lg text-gray-10 hover:text-gray-12 hover:bg-gray-4 transition-colors"
            >
              <X size={18} />
            </button>
          </div>

          <div class="p-4 overflow-y-auto">
            <div class="space-y-2">
              <For each={options()}>
                {(option) => (
                  <button
                    onClick={() => {
                      props.onSelect(option.value);
                      props.onClose();
                    }}
                    class={`w-full text-left p-4 rounded-xl border transition-all duration-200 group flex items-start justify-between gap-3 ${
                      props.value === option.value
                        ? "bg-blue-3/40 border-blue-7/50 ring-1 ring-blue-7/30"
                        : "bg-gray-1/30 border-gray-6/50 hover:bg-gray-2 hover:border-gray-7"
                    }`}
                  >
                    <div class="flex flex-col gap-1">
                      <span
                        class={`text-sm font-semibold ${
                          props.value === option.value ? "text-blue-11" : "text-gray-12"
                        }`}
                      >
                        {option.label}
                      </span>
                      <span class="text-xs text-gray-10 leading-relaxed">
                        {option.description}
                      </span>
                    </div>
                    <Show when={props.value === option.value}>
                      <div class="shrink-0 mt-0.5 text-blue-11">
                        <Check size={16} strokeWidth={3} />
                      </div>
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </div>

          <div class="px-6 py-4 border-t border-gray-6/50 flex justify-end">
            <Button variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </Show>
  );
}

