"use client";

import { PencilLine } from "lucide-react";
import { useState } from "react";
import { DenInput } from "./input";

export type DenAutoNameFieldProps = {
  /** The current name value (auto-derived or manually set). */
  value: string;
  /** Whether the value is still tracking the automatic name. */
  auto: boolean;
  placeholder?: string;
  testId?: string;
  /** Called with the new name; `null` reverts to the automatic name. */
  onChange: (value: string | null) => void;
};

/**
 * A name that writes itself: shows the auto-derived value with an AUTO badge
 * and a Rename affordance. Editing switches to an input; clearing it reverts
 * to the automatic name.
 */
export function DenAutoNameField({ value, auto, placeholder, testId, onChange }: DenAutoNameFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  function commit() {
    const trimmed = draft.trim();
    onChange(trimmed.length > 0 ? trimmed : null);
    setEditing(false);
  }

  if (editing) {
    return (
      <DenInput
        value={draft}
        data-testid={testId ? `${testId}-input` : undefined}
        autoFocus
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setDraft(value);
            setEditing(false);
          }
        }}
        placeholder={placeholder}
        autoComplete="off"
      />
    );
  }

  return (
    <div
      data-testid={testId}
      className="flex items-center gap-2.5 rounded-[14px] border border-dashed border-gray-200 bg-gray-50 px-4 py-3"
    >
      <span className="shrink-0 text-[13px] font-medium text-gray-500">Name</span>
      <span className="min-w-0 truncate text-[14px] font-medium text-gray-950">
        {value || <span className="text-gray-400">{placeholder ?? "Pick a provider first"}</span>}
      </span>
      {auto && value ? (
        <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-emerald-700">
          AUTO
        </span>
      ) : null}
      <span className="flex-1" />
      <button
        type="button"
        data-testid={testId ? `${testId}-rename` : undefined}
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        className="flex shrink-0 items-center gap-1.5 text-[12px] font-medium text-gray-500 transition hover:text-gray-900"
      >
        <PencilLine className="h-3.5 w-3.5" aria-hidden="true" />
        Rename
      </button>
    </div>
  );
}
