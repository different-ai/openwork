import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FocusEvent, type KeyboardEvent, type RefObject } from "react"

/**
 * Shared behaviour for every field where a person types a secret (API keys,
 * client secrets, tokens, service-account keys). Each app composes its own
 * styled primitives around this, so the privacy rules live in one place.
 */

/** Shown for a stored secret. Fixed, so nothing about the value leaks. */
export const MASKED_SECRET = "••••••••"

/**
 * Not a sign-in password: no browser autofill, saving or suggestions, no
 * password-manager overlays, and excluded from session replay and analytics.
 */
export const SECRET_INPUT_ATTRIBUTES = {
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "none",
  spellCheck: false,
  "data-1p-ignore": "true",
  "data-lpignore": "true",
  "data-bwignore": "true",
  "data-form-type": "other",
  "data-private": "true",
  "data-ph-no-capture": "true",
  "data-sentry-mask": "true",
} as const

/** Applied to the field's wrapper so capture tools skip the whole region. */
export const SECRET_REGION_ATTRIBUTES = {
  "data-secret-field": "true",
  "data-private": "true",
  "data-ph-no-capture": "true",
  "data-sentry-mask": "true",
  className: "ph-no-capture",
} as const

/** Printable ASCII with no spaces: what API keys and client secrets look like. */
export function isPlainSecret(value: string, maxLength = 8192): boolean {
  return value.length > 0 && value.length <= maxLength && /^[\x21-\x7e]+$/.test(value)
}

/** A pasted service-account key or other JSON credential: an object, nothing else. */
export function isJsonSecret(value: string, maxLength = 65_536): boolean {
  if (!value.trim() || value.length > maxLength) return false
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
  } catch {
    return false
  }
}

export type SecretRevealControls<T extends HTMLElement> = {
  revealed: boolean
  /** Spread on the input or textarea. */
  fieldProps: {
    onBlur: (event: FocusEvent<T>) => void
    onKeyDown: (event: KeyboardEvent<T>) => void
  }
  /** Spread on the show/hide button. */
  toggleProps: {
    ref: RefObject<HTMLButtonElement | null>
    "aria-pressed": boolean
    "aria-label": string
    disabled: boolean
    onMouseDown: (event: { preventDefault: () => void }) => void
    onClick: () => void
    onBlur: (event: FocusEvent<HTMLButtonElement>) => void
  }
  hide: () => void
}

/**
 * Reveal only while typing and only on request. Leaving the field, pressing
 * Escape, emptying it or disabling it hides the value again.
 */
export function useSecretReveal<T extends HTMLElement>(options: {
  field: RefObject<T | null>
  hasValue: boolean
  disabled?: boolean
  labels?: { show: string; hide: string }
}): SecretRevealControls<T> {
  const { field, hasValue, disabled = false } = options
  const labels = options.labels ?? { show: "Show while typing", hide: "Hide" }
  const toggle = useRef<HTMLButtonElement | null>(null)
  const [revealed, setRevealed] = useState(false)
  const hide = useCallback(() => setRevealed(false), [])
  useEffect(() => { if (disabled || !hasValue) setRevealed(false) }, [disabled, hasValue])

  return {
    revealed,
    hide,
    fieldProps: {
      onBlur: (event) => { if (event.relatedTarget !== toggle.current) setRevealed(false) },
      onKeyDown: (event) => {
        if (event.key === "Escape" && revealed) { event.preventDefault(); setRevealed(false) }
      },
    },
    toggleProps: {
      ref: toggle,
      "aria-pressed": revealed,
      "aria-label": revealed ? labels.hide : labels.show,
      disabled: disabled || !hasValue,
      // Keep focus in the field so the reveal never outlives typing.
      onMouseDown: (event) => event.preventDefault(),
      onClick: () => { setRevealed((value) => !value); field.current?.focus() },
      onBlur: (event) => { if (event.relatedTarget !== field.current) setRevealed(false) },
    },
  }
}

function textSecuritySupported(): boolean {
  return typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("-webkit-text-security", "disc")
}

/**
 * Whether a multi-line field can be masked. Where the browser can't mask a
 * textarea, use a password input instead: a pasted key file is still valid
 * JSON on one line, and it is never shown in clear text. False on the server
 * and the first render, so nothing unmasked is ever drawn.
 */
export function useMultilineSecretSupported(): boolean {
  return useSyncExternalStore(() => () => {}, textSecuritySupported, () => false)
}
