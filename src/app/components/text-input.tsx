import type { JSX } from "solid-js";

type TextInputProps = JSX.InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: string;
};

export default function TextInput(props: TextInputProps) {
  const { label, hint, class: className, ...rest } = props;

  return (
    <label class="block">
      {label ? (
        <div class="mb-1 text-xs font-medium text-neutral-300">{label}</div>
      ) : null}
      <input
        {...rest}
        class={`w-full rounded-xl bg-neutral-900/60 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 shadow-[0_0_0_1px_rgba(255,255,255,0.08)] focus:outline-none focus:ring-2 focus:ring-white/20 ${
          className ?? ""
        }`.trim()}
      />
      {hint ? <div class="mt-1 text-xs text-neutral-500">{hint}</div> : null}
    </label>
  );
}
