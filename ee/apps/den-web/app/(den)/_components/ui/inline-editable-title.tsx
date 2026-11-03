"use client";

import { Check, Pencil } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

export type DenInlineEditableTitleProps = {
  /** The editable name. */
  value: string;
  onChange: (value: string) => void;
  /** Shown in the input when the name is cleared. */
  placeholder?: string;
  /** Fixed text before the name that is not editable, e.g. "Add ". */
  prefix?: ReactNode;
  /** Heading level; the input inherits the heading's typography. */
  as?: "h1" | "h2";
  /** Heading typography, shared by the name and the input so editing doesn't shift. */
  className?: string;
  testId?: string;
};

/**
 * A title that renames in place: the name is underlined with a pencil beside
 * it. Clicking either swaps the name for an unstyled input in the same
 * typography and the pencil for a tick that finishes editing. Enter also
 * finishes; Escape restores the name from before editing.
 */
export function DenInlineEditableTitle({
  value,
  onChange,
  placeholder,
  prefix,
  as: Heading = "h1",
  className = "",
  testId,
}: DenInlineEditableTitleProps) {
  const [editing, setEditing] = useState(false);
  const valueBeforeEdit = useRef(value);

  function startEditing() {
    valueBeforeEdit.current = value;
    setEditing(true);
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Heading className={`min-w-0 ${className}`} data-testid={testId}>
        {prefix}
        {editing ? (
          <input
            type="text"
            value={value}
            autoFocus
            autoComplete="off"
            aria-label="Name"
            data-testid={testId ? `${testId}-input` : undefined}
            placeholder={placeholder}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                setEditing(false);
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onChange(valueBeforeEdit.current);
                setEditing(false);
              }
            }}
            // A field box so it reads as an input; the vertical negative
            // margin keeps the heading's height from changing while editing.
            className="-my-1 min-w-[4ch] max-w-full rounded-[8px] border-0 bg-white px-2 py-1 shadow-[inset_0_0_0_1px_var(--color-gray-300)] outline-none transition placeholder:text-gray-300 focus:shadow-[inset_0_0_0_1px_var(--color-gray-900),0_0_0_3px_var(--color-gray-200)] [field-sizing:content]"
          />
        ) : (
          <button
            type="button"
            onClick={startEditing}
            className="cursor-text text-left underline decoration-gray-300 decoration-1 underline-offset-[0.35em] transition hover:decoration-gray-500"
          >
            {value || placeholder}
          </button>
        )}
      </Heading>
      <button
        type="button"
        data-testid={testId ? `${testId}-${editing ? "done" : "rename"}` : undefined}
        aria-label={editing ? "Done renaming" : "Rename"}
        // Keep focus in the input so pressing the tick doesn't blur first.
        onMouseDown={(event) => event.preventDefault()}
        onClick={editing ? () => setEditing(false) : startEditing}
        className="flex size-7 shrink-0 items-center justify-center rounded-full text-gray-400 transition hover:bg-gray-100 hover:text-gray-900"
      >
        {editing ? <Check className="size-4" aria-hidden="true" /> : <Pencil className="size-3.5" aria-hidden="true" />}
      </button>
    </div>
  );
}
