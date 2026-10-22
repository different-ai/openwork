"use client";

import { getPasswordPolicyHint, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@openwork/types/den/password-policy";

export function getSetupPasswordError(value: string): string | null {
  return value.length > MAX_PASSWORD_LENGTH ? `Password must be at most ${MAX_PASSWORD_LENGTH} characters.` : null;
}

export function SetupPasswordField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const error = getSetupPasswordError(value);
  return (
    <>
      <label className="den-label" htmlFor="setup-password">Password</label>
      <input
        id="setup-password"
        name="password"
        type="password"
        autoComplete="new-password"
        className="den-input"
        value={value}
        onChange={event => onChange(event.currentTarget.value)}
        minLength={MIN_PASSWORD_LENGTH}
        ref={input => { input?.setCustomValidity(error ?? ""); }}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? "setup-password-policy setup-password-error" : "setup-password-policy"}
        required
      />
      <p id="setup-password-policy" className="m-0 text-xs leading-5 text-[var(--dls-text-secondary)]">
        {getPasswordPolicyHint()}
      </p>
      {error ? <p id="setup-password-error" className="m-0 text-sm font-medium text-rose-600" role="alert">{error}</p> : null}
    </>
  );
}
