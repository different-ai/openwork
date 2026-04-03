import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { Check, ChevronDown } from "lucide-solid";

export type SelectMenuOption = {
  value: string;
  label: string;
};

type SelectMenuProps = {
  options: SelectMenuOption[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
  /** For pairing with a visible `<label>` element */
  ariaLabelledBy?: string;
  /** When there is no visible label */
  ariaLabel?: string;
};

const triggerClass =
  "flex w-full items-center justify-between gap-2 rounded-xl border border-dls-border bg-dls-surface px-3.5 py-2.5 text-left text-[14px] text-dls-text shadow-none transition-[border-color,box-shadow] hover:border-dls-border focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.14)] disabled:cursor-not-allowed disabled:opacity-60";

const panelClass =
  "absolute left-0 right-0 top-[calc(100%+6px)] z-[100] max-h-56 overflow-auto rounded-xl border border-dls-border bg-dls-surface py-1 shadow-[var(--dls-shell-shadow)]";

const optionRowClass =
  "flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13px] text-dls-text transition-colors hover:bg-dls-hover";

export default function SelectMenu(props: SelectMenuProps) {
  const [open, setOpen] = createSignal(false);
  let rootEl: HTMLDivElement | undefined;

  const displayLabel = createMemo(() => {
    const match = props.options.find((o) => o.value === props.value);
    if (match) return match.label;
    return props.placeholder?.trim() || "";
  });

  const close = () => setOpen(false);

  createEffect(() => {
    if (!open()) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (rootEl && target && !rootEl.contains(target)) {
        close();
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    onCleanup(() => window.removeEventListener("pointerdown", onPointerDown, true));
  });

  createEffect(() => {
    if (!open()) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  return (
    <div ref={(el) => (rootEl = el)} class="relative w-full">
      <button
        type="button"
        id={props.id}
        class={triggerClass}
        disabled={props.disabled}
        aria-expanded={open()}
        aria-haspopup="listbox"
        aria-labelledby={props.ariaLabelledBy}
        aria-label={props.ariaLabel}
        onClick={() => {
          if (props.disabled) return;
          setOpen((o) => !o);
        }}
      >
        <span class="min-w-0 flex-1 truncate">{displayLabel()}</span>
        <ChevronDown
          size={18}
          class={`shrink-0 text-dls-secondary transition-transform duration-200 ${open() ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>

      <Show when={open() && !props.disabled}>
        <div class={panelClass} role="listbox">
          <For each={props.options}>
            {(opt) => (
              <button
                type="button"
                role="option"
                aria-selected={opt.value === props.value}
                class={`${optionRowClass} ${opt.value === props.value ? "bg-dls-hover/80" : ""}`}
                onClick={() => {
                  props.onChange(opt.value);
                  close();
                }}
              >
                <span class="min-w-0 flex-1 truncate">{opt.label}</span>
                <Show when={opt.value === props.value}>
                  <Check size={16} class="shrink-0 text-[var(--dls-accent)]" aria-hidden />
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
