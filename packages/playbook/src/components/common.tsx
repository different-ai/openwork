import type { JSX, ParentProps } from "solid-js";
import type { LucideIcon } from "lucide-solid";

export function ToggleChip(props: { active: boolean; onClick: () => void; children: JSX.Element }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      class={`playbook-button rounded-full border px-3 py-2 text-xs font-medium ${
        props.active
          ? "border-slate-8 bg-slate-12 text-white shadow-[0_16px_28px_-22px_rgba(15,23,42,0.85)]"
          : "border-slate-6/70 bg-white/85 text-slate-11 hover:border-slate-8 hover:bg-slate-2"
      }`}
    >
      {props.children}
    </button>
  );
}

export function RecipeRow(props: ParentProps<{ title: string }>) {
  return (
    <div class="rounded-[1.2rem] border border-slate-6/60 bg-white/75 px-4 py-3">
      <div class="text-xs font-semibold uppercase tracking-[0.18em] text-slate-10">{props.title}</div>
      <div class="mt-1 text-sm leading-6 text-slate-11">{props.children}</div>
    </div>
  );
}

export function MiniInventoryCard(props: { icon: LucideIcon; title: string; note: string }) {
  const Icon = props.icon;

  return (
    <div class="rounded-[1.35rem] border border-slate-6/60 bg-white/75 p-4">
      <div class="flex items-start gap-3">
        <div class="flex h-10 w-10 items-center justify-center rounded-2xl border border-slate-6/60 bg-slate-2 text-slate-12">
          <Icon size={18} />
        </div>
        <div>
          <div class="text-sm font-semibold text-slate-12">{props.title}</div>
          <div class="mt-1 text-sm leading-6 text-slate-11">{props.note}</div>
        </div>
      </div>
    </div>
  );
}

export function SurfaceSection(props: ParentProps<{ title: string }>) {
  return (
    <div class="playbook-panel rounded-[2rem] p-5">
      <div class="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-10">{props.title}</div>
      <div class="mt-3">{props.children}</div>
    </div>
  );
}

export function StoryNavCard(props: {
  selected: boolean;
  eyebrow: string;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      class={`playbook-button w-full rounded-[1.35rem] border px-4 py-3 text-left ${
        props.selected
          ? "border-slate-8 bg-slate-12 text-white shadow-[0_20px_40px_-26px_rgba(15,23,42,0.75)]"
          : "border-slate-6/60 bg-white/70 text-slate-12 hover:border-slate-8 hover:bg-slate-2/90"
      }`}
    >
      <div class={`text-[10px] font-semibold uppercase tracking-[0.22em] ${props.selected ? "text-slate-4" : "text-slate-10"}`}>
        {props.eyebrow}
      </div>
      <div class="mt-1 text-sm font-semibold">{props.label}</div>
      <div class={`mt-1 text-xs leading-5 ${props.selected ? "text-slate-4/90" : "text-slate-10"}`}>{props.description}</div>
    </button>
  );
}
