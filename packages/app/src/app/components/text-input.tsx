import { splitProps, JSX } from "solid-js";

type TextInputProps = JSX.InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: string;
};

export default function TextInput(props: TextInputProps) {
  const [local, rest] = splitProps(props, ["label", "hint", "class", "ref"]);

  return (
    <label class="block">
      {local.label ? (
        <div class="mb-1 text-xs font-medium text-gray-11">{local.label}</div>
      ) : null}
      <input
        {...rest}
        ref={local.ref}
        class={`w-full rounded-xl bg-gray-2/60 px-3 py-2 text-sm text-gray-12 placeholder:text-gray-10 shadow-[0_0_0_1px_rgba(255,255,255,0.08)] focus:outline-none focus:ring-2 focus:ring-gray-6/20 ${
          local.class ?? ""
        }`.trim()}
      />
      {local.hint ? <div class="mt-1 text-xs text-gray-10">{local.hint}</div> : null}
    </label>
  );
}
