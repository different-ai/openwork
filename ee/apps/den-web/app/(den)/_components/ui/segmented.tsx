"use client";

export type DenSegmentedOption<T extends string> = {
  value: T;
  label: string;
  disabled?: boolean;
};

export type DenSegmentedProps<T extends string> = {
  options: readonly DenSegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  "aria-label": string;
  className?: string;
  /** A test id for each option, for journeys that pick one among several groups. */
  optionTestId?: (value: T) => string;
};

/** A compact radio group for switching between related options. */
export function DenSegmented<T extends string>({
  options,
  value,
  onChange,
  "aria-label": ariaLabel,
  className = "",
  optionTestId,
}: DenSegmentedProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={["inline-flex items-center rounded-lg bg-gray-100 p-0.5", className]
        .filter(Boolean)
        .join(" ")}
    >
      {options.map((option) => {
        const active = option.value === value;

        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            data-testid={optionTestId?.(option.value)}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={[
              "rounded-md px-3 py-1 text-[12px] font-medium transition-colors",
              option.disabled
                ? "cursor-not-allowed text-gray-300"
                : active
                  ? "bg-white text-gray-900 shadow-[0_1px_2px_0_rgba(15,23,42,0.06)]"
                  : "text-gray-500 hover:text-gray-900",
            ].join(" ")}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
