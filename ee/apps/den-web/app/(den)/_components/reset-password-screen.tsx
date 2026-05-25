"use client";

import { ArrowRight, CheckCircle2 } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { getErrorMessage, requestJson } from "../_lib/den-flow";

function getResetLinkError(error: string | null) {
  if (!error) {
    return "This reset link is missing a token. Request a new link from the sign-in page.";
  }

  if (error === "INVALID_TOKEN") {
    return "This reset link is invalid or expired. Request a new link from the sign-in page.";
  }

  return "We could not verify this reset link. Request a new link from the sign-in page.";
}

export function ResetPasswordScreen() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token")?.trim() ?? "";
  const callbackError = searchParams.get("error")?.trim() ?? null;
  const linkError = token ? null : getResetLinkError(callbackError);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(linkError);

  async function submitReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) {
      setError(getResetLinkError(callbackError));
      return;
    }
    if (password.length < 8) {
      setError("Use at least 8 characters for your new password.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const { response, payload } = await requestJson("/api/auth/reset-password", {
        method: "POST",
        body: JSON.stringify({
          newPassword: password,
          token,
        }),
      });

      if (!response.ok) {
        setError(getErrorMessage(payload, `Could not reset password (${response.status}).`));
        return;
      }

      setSuccess(true);
      setPassword("");
      setConfirmPassword("");
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : "Could not reset password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="den-page flex min-h-[calc(100vh-2.5rem)] w-full items-center justify-center py-6">
      <div className="den-frame grid w-full max-w-[520px] gap-6 p-6 md:p-8">
        <div className="grid gap-3">
          <p className="den-eyebrow">Account</p>
          <div className="grid gap-2">
            <h1 className="den-title-lg">Choose a new password.</h1>
            <p className="den-copy">Use the reset link from your email to secure your OpenWork account.</p>
          </div>
        </div>

        {success ? (
          <div className="den-frame-inset grid gap-3 rounded-[1.5rem] px-4 py-4 text-center text-[13px] text-[var(--dls-text-secondary)]" aria-live="polite">
            <div className="inline-flex items-center justify-center gap-2 text-emerald-600">
              <CheckCircle2 className="h-4 w-4" />
              <span className="font-medium">Your password has been reset.</span>
            </div>
            <p className="m-0">Sign in with your new password to continue.</p>
            <a href="/?mode=sign-in" className="den-button-primary mt-1 w-full">
              Back to sign in
              <ArrowRight className="h-4 w-4" />
            </a>
          </div>
        ) : (
          <form className="grid gap-4" onSubmit={submitReset}>
            <label className="grid gap-2">
              <span className="den-label">New password</span>
              <input
                className="den-input"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                disabled={!token || busy}
                required
              />
            </label>

            <label className="grid gap-2">
              <span className="den-label">Confirm password</span>
              <input
                className="den-input"
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                autoComplete="new-password"
                disabled={!token || busy}
                required
              />
            </label>

            <button type="submit" className="den-button-primary w-full" disabled={!token || busy}>
              {busy ? "Resetting..." : "Reset password"}
              {!busy ? <ArrowRight className="h-4 w-4" /> : null}
            </button>
          </form>
        )}

        {error ? (
          <div className="den-frame-inset rounded-[1.5rem] px-4 py-3 text-center text-[13px] font-medium text-rose-600" aria-live="polite">
            {error}
          </div>
        ) : null}

        {!success ? (
          <div className="border-t border-[var(--dls-border)] pt-4 text-center text-sm text-[var(--dls-text-secondary)]">
            <a href="/?mode=sign-in" className="font-medium text-[var(--dls-text-primary)] transition hover:opacity-70">
              Back to sign in
            </a>
          </div>
        ) : null}
      </div>
    </section>
  );
}
