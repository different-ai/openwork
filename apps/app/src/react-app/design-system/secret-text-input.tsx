/** @jsxImportSource react */
import type { Ref } from "react";

import { SecretField, type SecretFieldHandle } from "@/components/secret-field";
import { cn } from "@/lib/utils";

export type SecretTextInputProps = {
  id: string;
  label: string;
  hint?: string;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Read the value once with `handleRef.current.take()` when submitting. */
  handleRef: Ref<SecretFieldHandle>;
  onValueChange?: (hasValue: boolean) => void;
  onSubmit?: () => void;
  testId?: string;
  /** Classes for the input box, as TextInput's `className`. */
  className?: string;
};

/**
 * TextInput's layout (small label above, hint below) around a SecretField, so
 * a secret sits beside ordinary design-system fields without looking
 * different. The value never enters React state.
 */
export function SecretTextInput(props: SecretTextInputProps) {
  return (
    <div>
      <SecretField
        id={props.id}
        label={props.label}
        labelClassName="text-xs font-medium text-dls-secondary"
        placeholder={props.placeholder}
        disabled={props.disabled}
        autoFocus={props.autoFocus}
        handleRef={props.handleRef}
        onValueChange={props.onValueChange}
        onSubmit={props.onSubmit}
        testId={props.testId}
        className={cn(
          "rounded-lg border-dls-border bg-dls-surface shadow-sm hover:bg-dls-surface dark:bg-dls-surface dark:hover:bg-dls-surface",
          "has-[[data-slot=input-group-control]:focus-visible]:border-dls-border has-[[data-slot=input-group-control]:focus-visible]:ring-2 has-[[data-slot=input-group-control]:focus-visible]:ring-[rgba(var(--dls-accent-rgb),0.2)]",
          props.className,
        )}
      />
      {props.hint ? <div className="mt-1 text-xs text-dls-secondary">{props.hint}</div> : null}
    </div>
  );
}
