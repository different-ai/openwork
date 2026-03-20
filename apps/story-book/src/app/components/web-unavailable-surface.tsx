import { Show, createEffect } from "solid-js";
import { ArrowUpRight } from "lucide-solid";
import type { JSX } from "solid-js";

type WebUnavailableSurfaceProps = {
  unavailable: boolean;
  children: JSX.Element;
  compact?: boolean;
  class?: string;
  contentClass?: string;
};

const MESSAGE =
  "This feature is currently unavailable in OpenWork Web, check OpenWork Desktop for full functionality.";

export default function WebUnavailableSurface(props: WebUnavailableSurfaceProps) {
  let contentRef: HTMLDivElement | undefined;

  createEffect(() => {
    if (!contentRef) return;
    if (props.unavailable) {
      contentRef.setAttribute("inert", "");
      contentRef.setAttribute("aria-disabled", "true");
      return;
    }
    contentRef.removeAttribute("inert");
    contentRef.removeAttribute("aria-disabled");
  });

  return (
    <div class={props.class}>
      <Show when={props.unavailable}>
        <div
          class={props.compact
            ? "mb-3 rounded-xl border border-amber-7/30 bg-amber-2/45 px-3 py-2 text-[11px] text-amber-12"
            : "mb-4 rounded-2xl border border-amber-7/30 bg-amber-2/45 px-4 py-3 text-[13px] text-amber-12"}
        >
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{MESSAGE}</span>
            <a
              href="https://openworklabs.com"
              target="_blank"
              rel="noreferrer"
              class="inline-flex items-center gap-1 underline underline-offset-2 hover:no-underline"
            >
              <span>Download OpenWork Desktop</span>
              <ArrowUpRight size={props.compact ? 12 : 14} />
            </a>
          </div>
        </div>
      </Show>

      <div class={`relative ${props.contentClass ?? ""}`}>
        <div ref={contentRef} classList={{ "opacity-55": props.unavailable }}>
          {props.children}
        </div>
        <Show when={props.unavailable}>
          <div class="absolute inset-0 z-10 cursor-not-allowed" aria-hidden="true" />
        </Show>
      </div>
    </div>
  );
}
