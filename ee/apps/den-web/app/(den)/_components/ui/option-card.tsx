import type { ReactNode } from "react";

export type DenOptionCardProps = {
  type: "radio" | "checkbox";
  /** Required for radios so the browser groups them. */
  name?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: string;
  description?: ReactNode;
  disabled?: boolean;
  testId?: string;
};

/**
 * Selectable card wrapping a native input, so keyboard, screen readers and
 * end-to-end flows keep working against a real radio or checkbox.
 */
export function DenOptionCard({
  type,
  name,
  checked,
  onChange,
  title,
  description,
  disabled = false,
  testId,
}: DenOptionCardProps) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-[22px] border px-4 py-3 transition-colors ${
        checked ? "border-gray-900 bg-white" : "border-gray-200 bg-gray-50 hover:border-gray-300"
      } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
    >
      <input
        type={type}
        name={name}
        data-testid={testId}
        className="mt-1 h-4 w-4 accent-gray-900"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        disabled={disabled}
      />
      <span className="min-w-0">
        <span className="block text-[14px] font-medium text-gray-950">{title}</span>
        {description ? <span className="mt-1 block text-[13px] leading-6 text-gray-500">{description}</span> : null}
      </span>
    </label>
  );
}
