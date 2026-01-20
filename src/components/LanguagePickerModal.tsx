import { For, Show } from "solid-js";
import { CheckCircle2, X } from "lucide-solid";

import Button from "./Button";
import { createTranslations } from "../i18n";

export type Language = "en" | "zh" | "ja" | "ko" | "es" | "ar" | "zh-tw" | "zh-hk" | "pt";

export type LanguageOption = {
  code: Language;
  name: string;
  nativeName: string;
};

export type LanguagePickerModalProps = {
  open: boolean;
  current: Language;
  onSelect: (language: Language) => void;
  onClose: () => void;
};

const LANGUAGE_OPTIONS: LanguageOption[] = [
  { code: "en", name: "English", nativeName: "English" },
  { code: "zh", name: "Chinese (Simplified)", nativeName: "中文" },
  { code: "ja", name: "Japanese", nativeName: "日本語" },
  { code: "ko", name: "Korean", nativeName: "한국어" },
  { code: "es", name: "Spanish", nativeName: "Español" },
  { code: "ar", name: "Arabic", nativeName: "العربية" },
  { code: "zh-tw", name: "Chinese (Taiwan Traditional)", nativeName: "繁體中文（台灣）" },
  { code: "zh-hk", name: "Chinese (Hong Kong Traditional)", nativeName: "繁體中文（香港）" },
  { code: "pt", name: "Portuguese", nativeName: "Português" },
];

export default function LanguagePickerModal(props: LanguagePickerModalProps) {
  const t = createTranslations();

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="bg-zinc-900 border border-zinc-800/70 w-full max-w-sm rounded-2xl shadow-2xl overflow-hidden">
          <div class="p-6">
            <div class="flex items-start justify-between gap-4">
              <div>
                <h3 class="text-lg font-semibold text-white">{t("settings.language")}</h3>
                <p class="text-sm text-zinc-400 mt-1">{t("settings.language.description")}</p>
              </div>
              <Button variant="ghost" class="!p-2 rounded-full" onClick={props.onClose}>
                <X size={16} />
              </Button>
            </div>

            <div class="mt-5 space-y-2">
              <For each={LANGUAGE_OPTIONS}>
                {(option) => {
                  const active = () => props.current === option.code;

                  return (
                    <button
                      class={`w-full text-left rounded-2xl border px-4 py-3 transition-colors ${
                        active()
                          ? "border-white/20 bg-white/5"
                          : "border-zinc-800/70 bg-zinc-950/40 hover:bg-zinc-950/60"
                      }`}
                      onClick={() => props.onSelect(option.code)}
                    >
                      <div class="flex items-center justify-between gap-3">
                        <div class="min-w-0 flex-1">
                          <div class="text-sm font-medium text-white">{option.nativeName}</div>
                          <div class="text-xs text-zinc-500 mt-0.5">{option.name}</div>
                        </div>
                        <Show when={active()}>
                          <CheckCircle2 size={18} class="text-emerald-400 shrink-0" />
                        </Show>
                      </div>
                    </button>
                  );
                }}
              </For>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
