import { Show } from "solid-js";
import { RotateCcw, Languages } from "lucide-solid";

import Button from "./button";
import { t, currentLocale } from "../../i18n";

export type LanguageChangeToastProps = {
  open: boolean;
  currentLanguage: string;
  busy?: boolean;
  onRestart: () => void;
  onDismiss: () => void;
};

export default function LanguageChangeToast(props: LanguageChangeToastProps) {
  const translate = (key: string) => t(key, currentLocale());
  
  return (
    <Show when={props.open}>
      <div class="fixed top-6 left-1/2 -translate-x-1/2 z-50 w-[min(480px,calc(100vw-2rem))]">
        <div 
          class="
            flex items-center gap-3 p-2 pr-3 rounded-full 
            border border-gray-6/50 bg-gray-2/95 shadow-xl backdrop-blur-md 
            animate-in fade-in slide-in-from-top-4 duration-300
          "
        >
          {/* Icon Circle */}
          <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-3 text-blue-11">
            <Languages size={16} />
          </div>

          {/* Text Content */}
          <div class="flex-1 min-w-0 flex flex-col justify-center">
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium text-gray-12 truncate">
                {translate("language.changed_title")}
              </span>
            </div>
            
            <div class="text-xs text-gray-10 leading-snug mt-0.5">
              {translate("language.changed_description")}
            </div>
          </div>

          {/* Actions */}
          <div class="flex items-center gap-2 shrink-0 pl-2 border-l border-gray-5/50">
             <button 
              onClick={() => props.onDismiss()}
              class="px-2 py-1.5 text-xs font-medium text-gray-10 hover:text-gray-12 transition-colors"
            >
              {translate("language.restart_later")}
            </button>
            <Button
              variant="primary"
              class="h-7 px-3 text-xs rounded-full font-medium"
              onClick={() => props.onRestart()}
              disabled={props.busy}
            >
              <span class="flex items-center gap-1.5">
                <RotateCcw size={12} class={props.busy ? "animate-spin" : ""} />
                {translate("language.restart_now")}
              </span>
            </Button>
          </div>
        </div>
      </div>
    </Show>
  );
}
