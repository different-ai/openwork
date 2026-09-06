"use client";

export type DenSwitchSize = "md" | "sm";

export type DenSwitchProps = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  size?: DenSwitchSize;
  disabled?: boolean;
  "aria-label": string;
  testId?: string;
};

/** A compact switch control for toggling a boolean setting. */
export function DenSwitch({
  checked,
  onChange,
  size = "md",
  disabled = false,
  "aria-label": ariaLabel,
  testId,
}: DenSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      data-testid={testId}
      disabled={disabled}
      onClick={disabled ? undefined : () => onChange(!checked)}
      className={[
        "flex items-center rounded-full p-0.5 transition",
        size === "md" ? "h-6 w-10" : "h-5 w-9",
        checked ? "justify-end bg-gray-900" : "justify-start bg-gray-200",
        disabled ? "cursor-not-allowed opacity-60" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span
        aria-hidden="true"
        className={[
          size === "md" ? "h-5 w-5" : "h-4 w-4",
          "rounded-full bg-white shadow-xs",
        ].join(" ")}
      />
    </button>
  );
}
