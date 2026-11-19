"use client"

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react"
import { Eye, EyeOff } from "lucide-react"
import { SECRET_INPUT_ATTRIBUTES, SECRET_REGION_ATTRIBUTES, useMultilineSecretSupported, useSecretReveal } from "@openwork/ui/secret-input"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, InputGroupTextarea } from "@/components/ui/input-group"
import { cn } from "@/lib/utils"

export type SecretFieldHandle = {
  /** Reads the entered value once and clears the field. The caller must not keep it. */
  take: () => string
  clear: () => void
  focus: () => void
}

/**
 * A private, host-owned input for one secret. The value never enters React
 * state, props, telemetry or the transcript: the parent takes it once to send
 * it and the field clears. It is shown only while the person is typing and
 * asks to see it; leaving the field hides it again.
 *
 * `multiline` is for pasted JSON keys (service accounts): the text stays
 * masked the same way until revealed.
 */
export function SecretField({ id, label, labelHidden = false, labelClassName, description, error, disabled, onSubmit, onValueChange, handleRef, autoFocus = false, multiline: multilineRequested = false, placeholder, testId, className }: {
  id: string
  label: string
  /** The surrounding title already names the secret; keep the label for assistive tech only. */
  labelHidden?: boolean
  /** Styles the visible label to match the surrounding form. */
  labelClassName?: string
  description?: string
  error?: string | null
  disabled?: boolean
  onSubmit?: () => void
  /** Whether the field holds anything; the value itself is never passed. */
  onValueChange?: (hasValue: boolean) => void
  handleRef?: Ref<SecretFieldHandle>
  autoFocus?: boolean
  multiline?: boolean
  placeholder?: string
  /** `data-testid` on the input itself, for journey specs. */
  testId?: string
  /** Extra classes for the input box, to match the surrounding screen's fields. */
  className?: string
}) {
  // Only where the browser can mask a textarea; otherwise a password input.
  const multiline = useMultilineSecretSupported() && multilineRequested
  const input = useRef<HTMLInputElement>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const [hasValue, setHasValue] = useState(false)
  const inputReveal = useSecretReveal({ field: input, hasValue, disabled })
  const areaReveal = useSecretReveal({ field: area, hasValue, disabled })
  const element = () => multiline ? area.current : input.current

  const clear = () => {
    const current = element()
    if (current) current.value = ""
    setHasValue(false)
    onValueChange?.(false)
  }
  useImperativeHandle(handleRef, () => ({
    take: () => {
      const value = element()?.value ?? ""
      clear()
      return value
    },
    clear,
    focus: () => element()?.focus(),
  }))
  // Unmounting never leaves a value in a detached input.
  useEffect(() => () => {
    if (input.current) input.current.value = ""
    if (area.current) area.current.value = ""
  }, [])

  const changed = (value: string) => {
    const next = value.length > 0
    setHasValue(next)
    onValueChange?.(next)
  }
  const describedBy = [description ? `${id}-description` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined
  const shared = {
    id,
    name: `${id}-private`,
    disabled,
    autoFocus,
    placeholder,
    "data-testid": testId,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
    ...SECRET_INPUT_ATTRIBUTES,
  }
  const reveal = multiline ? areaReveal : inputReveal
  const toggle = (
    <InputGroupButton size="icon-xs" aria-controls={id} {...reveal.toggleProps}>
      {reveal.revealed ? <EyeOff aria-hidden="true" strokeWidth={1.5} /> : <Eye aria-hidden="true" strokeWidth={1.5} />}
    </InputGroupButton>
  )

  return (
    <Field data-invalid={error ? true : undefined} data-disabled={disabled ? true : undefined} {...SECRET_REGION_ATTRIBUTES}>
      <FieldLabel htmlFor={id} className={labelHidden ? "sr-only" : labelClassName}>{label}</FieldLabel>
      <InputGroup className={className}>
        {multiline ? (
          <>
            <InputGroupTextarea
              ref={area}
              {...shared}
              rows={4}
              maxLength={65_536}
              // Masked like a password field until the person asks to see it.
              className={cn("font-mono", !areaReveal.revealed && "[-webkit-text-security:disc]")}
              onChange={(event) => changed(event.currentTarget.value)}
              onBlur={areaReveal.fieldProps.onBlur}
              onKeyDown={(event) => {
                areaReveal.fieldProps.onKeyDown(event)
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && onSubmit) { event.preventDefault(); onSubmit() }
              }}
            />
            <InputGroupAddon align="block-end" className="justify-end">{toggle}</InputGroupAddon>
          </>
        ) : (
          <>
            <InputGroupInput
              ref={input}
              {...shared}
              type={inputReveal.revealed ? "text" : "password"}
              maxLength={8192}
              onChange={(event) => changed(event.currentTarget.value)}
              onBlur={inputReveal.fieldProps.onBlur}
              onKeyDown={(event) => {
                inputReveal.fieldProps.onKeyDown(event)
                if (event.key === "Enter" && onSubmit) { event.preventDefault(); onSubmit() }
              }}
            />
            <InputGroupAddon align="inline-end">{toggle}</InputGroupAddon>
          </>
        )}
      </InputGroup>
      {description && !error ? <FieldDescription id={`${id}-description`}>{description}</FieldDescription> : null}
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </Field>
  )
}
