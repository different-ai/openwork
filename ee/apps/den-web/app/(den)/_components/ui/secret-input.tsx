"use client";

import { useEffect, useRef, useState, type FocusEventHandler, type KeyboardEventHandler } from "react";
import { Eye, EyeOff } from "lucide-react";
import {
  MASKED_SECRET,
  SECRET_INPUT_ATTRIBUTES,
  SECRET_REGION_ATTRIBUTES,
  useSecretReveal,
  useMultilineSecretSupported,
} from "@openwork/ui/secret-input";

import { DenButton } from "./button";

type DataAttributes = { [key: `data-${string}`]: string | boolean | undefined };

export type DenSecretInputProps = DataAttributes & {
  value: string;
  /** Receives the new value. Called with "" when a replacement is cancelled. */
  onChange: (value: string) => void;
  id?: string;
  name?: string;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  /** Applied to the field itself, like DenInput / DenTextarea. */
  className?: string;
  /** "new-password" keeps password managers from offering a sign-in password. */
  autoComplete?: "off" | "new-password";
  onBlur?: FocusEventHandler<HTMLInputElement | HTMLTextAreaElement>;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement | HTMLTextAreaElement>;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  "aria-required"?: boolean;
  /** Pasted JSON credentials (service-account keys): a masked textarea. */
  multiline?: boolean;
  rows?: number;
  /**
   * A value is already stored. The field shows a masked row with "Replace"
   * until the person chooses to type a new one.
   */
  saved?: boolean;
  /** Controlled replace state; omit to let the field manage it. */
  replacing?: boolean;
  onReplacingChange?: (replacing: boolean) => void;
  /** data-testid for the Replace button. */
  replaceTestId?: string;
};

const FIELD_BASE = [
  "w-full rounded-lg border border-gray-200 bg-white",
  "text-[14px] text-gray-900",
  "outline-hidden transition-all placeholder:text-gray-500",
  "focus:border-gray-300 focus:ring-2 focus:ring-gray-900/5",
];

const ICON_BUTTON = [
  "flex h-8 w-8 items-center justify-center rounded-md text-gray-500 transition-colors duration-150 ease-out",
  "hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-40",
  "outline-hidden focus-visible:ring-2 focus-visible:ring-gray-900/20",
].join(" ");

/** Margin utilities from the caller's field classes, so the saved row sits where the field would. */
function marginClasses(className: string | undefined) {
  return (className ?? "").split(/\s+/).filter((token) => /^-?m[trblxy]?-/.test(token)).join(" ");
}

function joinClasses(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

/**
 * DenSecretInput
 *
 * The one field for typing a secret in Den (API keys, client secrets, tokens,
 * service-account JSON). Never a sign-in password: no autofill or password
 * manager, excluded from analytics and session replay.
 */
export function DenSecretInput({
  value,
  onChange,
  placeholder,
  disabled = false,
  className,
  autoComplete,
  multiline: multilineRequested = false,
  rows = 4,
  saved = false,
  replacing,
  onReplacingChange,
  replaceTestId,
  ...rest
}: DenSecretInputProps) {
  const multilineSupported = useMultilineSecretSupported();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const focusOnShow = useRef(false);

  const [internalReplacing, setInternalReplacing] = useState(false);
  const [previousSaved, setPreviousSaved] = useState(saved);
  if (previousSaved !== saved) {
    // A fresh save returns the field to its saved row.
    setPreviousSaved(saved);
    setInternalReplacing(false);
  }
  const isReplacing = replacing ?? internalReplacing;
  const showSavedRow = saved && !isReplacing && value === "";

  const setReplacing = (next: boolean) => {
    if (replacing === undefined) setInternalReplacing(next);
    onReplacingChange?.(next);
  };

  const inputReveal = useSecretReveal<HTMLInputElement>({ field: inputRef, hasValue: value.length > 0, disabled });
  const textareaReveal = useSecretReveal<HTMLTextAreaElement>({ field: textareaRef, hasValue: value.length > 0, disabled });
  // Only where the browser can mask a textarea; otherwise a password input.
  const multiline = multilineSupported && multilineRequested;
  const reveal = multiline ? textareaReveal : inputReveal;
  const revealed = reveal.revealed;

  useEffect(() => {
    if (showSavedRow || !focusOnShow.current) return;
    focusOnShow.current = false;
    (multiline ? textareaRef.current : inputRef.current)?.focus();
  }, [showSavedRow, multiline]);

  if (showSavedRow) {
    return (
      <span
        {...SECRET_REGION_ATTRIBUTES}
        className={joinClasses(
          SECRET_REGION_ATTRIBUTES.className,
          "flex h-[42px] w-full min-w-0 items-center gap-3 rounded-lg border border-gray-200 bg-white pl-4 pr-1",
          disabled && "opacity-60",
          marginClasses(className),
        )}
      >
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-gray-500">
          <span aria-hidden="true">{MASKED_SECRET}</span>
          <span className="sr-only">Saved</span>
        </span>
        <DenButton
          variant="ghost"
          size="xs"
          disabled={disabled}
          data-testid={replaceTestId}
          // Explicit, because callers wrap the field in a <label>.
          aria-label="Replace"
          className="outline-hidden focus-visible:ring-2 focus-visible:ring-gray-900/20"
          onClick={() => {
            focusOnShow.current = true;
            setReplacing(true);
          }}
        >
          Replace
        </DenButton>
      </span>
    );
  }

  const showCancel = saved;
  const cancelReplace = () => {
    reveal.hide();
    onChange("");
    setReplacing(false);
  };

  const sharedFieldProps = {
    ...rest,
    ...SECRET_INPUT_ATTRIBUTES,
    autoComplete: autoComplete ?? SECRET_INPUT_ATTRIBUTES.autoComplete,
    value,
    placeholder,
    disabled,
  };

  const toggle = (
    <button type="button" className={ICON_BUTTON} {...reveal.toggleProps}>
      {revealed ? <EyeOff size={16} strokeWidth={1.5} aria-hidden="true" /> : <Eye size={16} strokeWidth={1.5} aria-hidden="true" />}
    </button>
  );

  const field = multiline ? (
    <span className="relative block w-full min-w-0">
      <textarea
        {...sharedFieldProps}
        ref={textareaRef}
        rows={rows}
        onChange={(event) => onChange(event.target.value)}
        onBlur={(event) => { textareaReveal.fieldProps.onBlur(event); rest.onBlur?.(event); }}
        onKeyDown={(event) => { textareaReveal.fieldProps.onKeyDown(event); rest.onKeyDown?.(event); }}
        className={joinClasses(
          ...FIELD_BASE,
          "px-4 py-2.5 font-mono resize-none",
          !revealed && "[-webkit-text-security:disc]",
          "pr-11",
          disabled && "cursor-not-allowed opacity-60",
          className,
        )}
      />
      <span className="absolute bottom-1.5 right-1.5">{toggle}</span>
    </span>
  ) : (
    <span className="relative block w-full min-w-0">
      <input
        {...sharedFieldProps}
        ref={inputRef}
        type={revealed ? "text" : "password"}
        onChange={(event) => onChange(event.target.value)}
        onBlur={(event) => { inputReveal.fieldProps.onBlur(event); rest.onBlur?.(event); }}
        onKeyDown={(event) => { inputReveal.fieldProps.onKeyDown(event); rest.onKeyDown?.(event); }}
        className={joinClasses(
          ...FIELD_BASE,
          "h-[42px] px-4 leading-5",
          "pr-11",
          disabled && "cursor-not-allowed opacity-60",
          className,
        )}
      />
      {/* Anchored to the bottom so a caller's top margin on the field keeps it centred. */}
      <span className="absolute bottom-[5px] right-1.5">{toggle}</span>
    </span>
  );

  return (
    <span
      {...SECRET_REGION_ATTRIBUTES}
      className={joinClasses(
        SECRET_REGION_ATTRIBUTES.className,
        "flex w-full min-w-0 gap-2",
        multiline ? "flex-col items-end" : "items-center",
      )}
    >
      {field}
      {showCancel ? (
        <DenButton
          variant="ghost"
          size="xs"
          disabled={disabled}
          aria-label="Cancel"
          className="shrink-0 outline-hidden focus-visible:ring-2 focus-visible:ring-gray-900/20"
          onClick={cancelReplace}
        >
          Cancel
        </DenButton>
      ) : null}
    </span>
  );
}
