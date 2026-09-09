"use client";

import { ArrowRight, CheckCircle2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { AUTH_TOKEN_STORAGE_KEY, getErrorMessage, getToken, requestJson } from "../_lib/den-flow";

type SetupStatus = "loading" | "available" | "complete" | "unavailable";
type SetupStep = "verify" | "create";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, key: string) {
  if (!isRecord(value)) return "";
  const field = value[key];
  return typeof field === "string" ? field : "";
}

export default function SetupPage() {
  const [status, setStatus] = useState<SetupStatus>("loading");
  const [step, setStep] = useState<SetupStep>("verify");
  const [email, setEmail] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordMismatch, setPasswordMismatch] = useState(false);
  const confirmationInput = useRef<HTMLInputElement>(null);
  const [grant, setGrant] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void requestJson("/v1/auth/bootstrap/status", { method: "GET" }, 12000)
      .then(({ response, payload }) => {
        if (!active) return;
        const nextStatus = readString(payload, "status");
        setStatus(response.ok && (nextStatus === "available" || nextStatus === "complete" || nextStatus === "unavailable") ? nextStatus : "unavailable");
      })
      .catch(() => {
        if (active) setStatus("unavailable");
      });
    return () => {
      active = false;
    };
  }, []);

  async function submitVerification(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { response, payload } = await requestJson("/v1/auth/bootstrap/verify", {
        method: "POST",
        body: JSON.stringify({ email, code: setupCode }),
      });
      if (!response.ok) {
        setError(getErrorMessage(payload, "Setup could not be verified. Check the administrator email and one-time setup code."));
        return;
      }
      const nextGrant = readString(payload, "grant");
      if (!nextGrant) {
        setError("Setup could not be verified. Refresh and try again.");
        return;
      }
      setGrant(nextGrant);
      setStep("create");
    } catch (verificationError) {
      setError(verificationError instanceof Error ? verificationError.message : "Setup could not be verified. Refresh and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function submitAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setPasswordMismatch(true);
      confirmationInput.current?.focus();
      return;
    }
    setPasswordMismatch(false);
    setBusy(true);
    try {
      const { response, payload } = await requestJson("/api/auth/sign-up/email", {
        method: "POST",
        body: JSON.stringify({
          email,
          name: name.trim() || "OpenWork Administrator",
          password,
          bootstrapGrant: grant,
        }),
      });
      if (!response.ok) {
        setError(getErrorMessage(payload, `Account creation failed with ${response.status}.`));
        return;
      }
      const token = getToken(payload);
      if (token) {
        window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
      }
      window.location.assign("/install");
    } catch (creationError) {
      setError(creationError instanceof Error ? creationError.message : "Account creation failed. Refresh and try again.");
    } finally {
      setBusy(false);
    }
  }

  const complete = status === "complete";
  const unavailable = status === "unavailable";

  return (
    <section className="den-page flex min-h-[calc(100vh-2.5rem)] w-full items-center justify-center py-3 sm:py-4">
      <div className="den-frame mx-auto grid w-full max-w-[680px] gap-8 p-5 sm:p-8 md:p-10" data-testid="initial-admin-setup">
        <div className="grid gap-3">
          <p className="den-eyebrow">Private deployment setup</p>
          <h1 className="den-title-lg">{complete ? "Setup is complete" : "Set up your administrator account"}</h1>
          <p className="den-copy">
            {complete
              ? "This OpenWork deployment already has its first administrator. Continue with the normal sign-in flow."
              : "Create the first administrator for this private OpenWork deployment. Public signup remains disabled during setup."}
          </p>
        </div>

        {status === "loading" ? (
          <div className="den-frame-inset rounded-[1.5rem] px-4 py-3 text-sm text-[var(--dls-text-secondary)]" role="status">
            Checking setup availability...
          </div>
        ) : complete || unavailable ? (
          <div className="grid gap-5">
            <div className="den-frame-inset rounded-[1.5rem] px-4 py-4 text-sm text-[var(--dls-text-secondary)]" role="status" aria-live="polite">
              <div className="flex items-start gap-3">
                {complete ? <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-600" /> : null}
                <p className="m-0 leading-6">
                  {complete
                    ? "Initial administrator setup is permanently disabled for this deployment."
                    : "Initial administrator setup is not available. Ask the deployment operator to verify the bootstrap configuration."}
                </p>
              </div>
            </div>
            <button type="button" className="den-button-primary" onClick={() => window.location.assign("/")}>Sign in</button>
          </div>
        ) : step === "verify" ? (
          <form className="grid gap-5" onSubmit={submitVerification}>
            <div className="grid gap-2">
              <label className="den-label" htmlFor="setup-email">Administrator email</label>
              <input
                id="setup-email"
                name="email"
                type="email"
                autoComplete="email"
                className="den-input"
                value={email}
                onChange={(event) => setEmail(event.currentTarget.value)}
                required
              />
            </div>
            <div className="grid gap-2">
              <label className="den-label" htmlFor="setup-code">One-time setup code</label>
              <input
                id="setup-code"
                name="setupCode"
                type="password"
                autoComplete="one-time-code"
                className="den-input"
                value={setupCode}
                onChange={(event) => setSetupCode(event.currentTarget.value)}
                required
              />
              <p className="m-0 text-xs leading-5 text-[var(--dls-text-secondary)]">
                Use the code supplied by the deployment operator through your secret-management system. It is not sent by email.
              </p>
            </div>
            {error ? <p className="m-0 text-sm font-medium text-rose-600" role="alert">{error}</p> : null}
            <button type="submit" className="den-button-primary" disabled={busy}>
              {busy ? "Checking..." : "Continue"}
              <ArrowRight className="h-4 w-4" />
            </button>
          </form>
        ) : (
          <form className="grid gap-5" onSubmit={submitAccount}>
            <div className="grid gap-2">
              <p className="den-eyebrow">Create your administrator account</p>
              <p className="den-copy">Enter your name and password. OpenWork will create the first account, sign you in, and permanently close setup.</p>
            </div>
            <div className="grid gap-2">
              <label className="den-label" htmlFor="setup-name">Name</label>
              <input
                id="setup-name"
                name="name"
                type="text"
                autoComplete="name"
                className="den-input"
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                required
              />
            </div>
            <div className="grid gap-2">
              <label className="den-label" htmlFor="setup-password">Password</label>
              <input
                id="setup-password"
                name="password"
                type="password"
                autoComplete="new-password"
                className="den-input"
                value={password}
                onChange={(event) => {
                  setPassword(event.currentTarget.value);
                  setPasswordMismatch(false);
                }}
                required
              />
            </div>
            <div className="grid gap-2">
              <label className="den-label" htmlFor="setup-confirm-password">Confirm password</label>
              <input
                ref={confirmationInput}
                id="setup-confirm-password"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                className="den-input"
                value={confirmPassword}
                onChange={(event) => {
                  setConfirmPassword(event.currentTarget.value);
                  setPasswordMismatch(false);
                }}
                aria-invalid={passwordMismatch}
                aria-describedby={passwordMismatch ? "setup-password-mismatch" : undefined}
                required
              />
              {passwordMismatch ? (
                <p id="setup-password-mismatch" className="m-0 text-sm font-medium text-rose-600" role="alert">
                  Passwords do not match. Enter the same password in both fields.
                </p>
              ) : null}
            </div>
            {error ? <p className="m-0 text-sm font-medium text-rose-600" role="alert">{error}</p> : null}
            <button type="submit" className="den-button-primary" disabled={busy}>
              {busy ? "Creating..." : "Create administrator"}
              <ArrowRight className="h-4 w-4" />
            </button>
          </form>
        )}
      </div>
    </section>
  );
}
