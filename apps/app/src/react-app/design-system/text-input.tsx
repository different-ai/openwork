/** @jsxImportSource react */
import { forwardRef, type InputHTMLAttributes } from "react";

export type TextInputProps = InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  hint?: string;
};

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(
  function TextInput({ label, hint, className, ...rest }, ref) {
    return (
      <label className="block">
        {label ? (
          <div className="mb-1 text-xs font-medium text-dls-secondary">
            {label}
          </div>
        ) : null}
        <input
          ref={ref}
          className={`w-full rounded-lg bg-dls-surface px-3 py-2 text-sm text-dls-text placeholder:text-dls-secondary border border-dls-border shadow-sm focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.2)] ${
            className ?? ""
          }`.trim()}
          {...rest}
        />
        {hint ? (
          <div className="mt-1 text-xs text-dls-secondary">{hint}</div>
        ) : null}
      </label>
    );
  },
);
