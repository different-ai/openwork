import type { JSX } from "solid-js";

type CardProps = {
  title?: string;
  children: JSX.Element;
  actions?: JSX.Element;
};

export default function Card(props: CardProps) {
  return (
    <div class="rounded-xl bg-dls-surface border border-dls-border shadow-[0_1px_2px_rgba(17,24,39,0.06)] transition-shadow hover:shadow-[0_8px_24px_rgba(17,24,39,0.08)]">
      {props.title || props.actions ? (
        <div class="flex items-center justify-between gap-3 border-b border-dls-border px-5 py-4">
          <div class="text-sm font-semibold text-dls-text">{props.title}</div>
          <div>{props.actions}</div>
        </div>
      ) : null}
      <div class="px-5 py-4">{props.children}</div>
    </div>
  );
}
