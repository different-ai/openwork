"use client"

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react"
import { Eye, EyeOff } from "lucide-react"
import { SECRET_INPUT_ATTRIBUTES, SECRET_REGION_ATTRIBUTES, useMultilineSecretSupported, useSecretReveal } from "@openwork/ui/secret-input"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, InputGroupTextarea } from "@/components/ui/input-group"
import { cn } from "@/lib/utils"

export type SecretFieldHandle = {
  take: () => string
  clear: () => void
  focus: () => void
}

export function SecretField({ id, label, labelHidden = false, labelClassName, description, error, disabled, onSubmit, onValueChange, handleRef, autoFocus = false, multiline: multilineRequested = false, placeholder, testId, className }: {
  id: string
  label: string
  labelHidden?: boolean
  labelClassName?: string
  description?: string
  error?: string | null
  disabled?: boolean
  onSubmit?: () => void
  onValueChange?: (hasValue: boolean) => void
  handleRef?: Ref<SecretFieldHandle>
  autoFocus?: boolean
  multiline?: boolean
  placeholder?: string
  testId?: string
  className?: string
}) {
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
