import type { JSX } from "solid-js";

type CardProps = {
  title?: string;
  children: JSX.Element;
  actions?: JSX.Element;
};

export default function Card(props: CardProps) {
  return (
    <div class="rounded-2xl bg-gray-2/50 border border-gray-6/60 backdrop-blur-xl shadow-[0_20px_80px_rgba(0,0,0,0.55)]">
      {props.title || props.actions ? (
        <div class="flex items-center justify-between gap-3 border-b border-gray-6/70 px-5 py-4">
          <div class="text-sm font-semibold text-gray-12">{props.title}</div>
          <div>{props.actions}</div>
        </div>
      ) : null}
      <div class="px-5 py-4">{props.children}</div>
    </div>
  );
}
