"use client";

import { useEffect, useId, useState } from "react";

type FormState = "idle" | "loading" | "success" | "error";

type FormFields = {
  fullName: string;
  companyEmail: string;
  message: string;
};

const initialFields: FormFields = {
  fullName: "",
  companyEmail: "",
  message: ""
};

const fieldClassName =
  "min-h-11 w-full rounded-lg border border-[var(--lp-border)] bg-[var(--lp-page)] px-4 py-3 text-sm text-[var(--lp-ink)] placeholder:text-[var(--lp-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--lp-ink)] disabled:opacity-60";
const labelClassName =
  "mb-2 block text-sm font-medium text-[var(--lp-ink)]";
const failureMessage = "Your message could not be sent. Try again.";

export function BookCallForm() {
  const id = useId();
  const [fields, setFields] = useState<FormFields>(initialFields);
  const [website, setWebsite] = useState("");
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [state, setState] = useState<FormState>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  const setField = (key: keyof FormFields, value: string) => {
    setFields(current => ({ ...current, [key]: value }));
  };

  const reset = () => {
    setFields(initialFields);
    setWebsite("");
    setStartedAt(Date.now());
    setState("idle");
    setErrorMsg("");
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setState("loading");
    setErrorMsg("");

    try {
      const response = await fetch("/api/enterprise-contact", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          ...fields,
          website,
          startedAt
        })
      });

      if (!response.ok) {
        const data = await response.json().catch(() => null);
        setState("error");
        setErrorMsg(data?.message ?? data?.error ?? failureMessage);
        return;
      }

      setState("success");
      setFields(initialFields);
    } catch {
      setState("error");
      setErrorMsg(failureMessage);
    }
  };

  return (
    <section
      id="book"
      aria-labelledby={`${id}-heading`}
      className="scroll-mt-28 rounded-[14px] bg-white p-5 shadow-[0_0_0_1px_rgba(1,22,39,0.08),0_12px_24px_-16px_rgba(1,22,39,0.2)] md:p-7"
    >
      <h3
        id={`${id}-heading`}
        className="mb-5 text-[17px] font-medium tracking-[-0.015em] text-[var(--lp-ink)]"
      >
        Tell us what you need
      </h3>

      <p role="status" aria-atomic="true" className="text-sm leading-relaxed text-[var(--lp-ink)]">
        {state === "success"
          ? "Message sent. We’ll follow up by email."
          : state === "loading"
            ? "Sending your message…"
            : ""}
      </p>
      <p role="alert" aria-atomic="true" className="text-sm leading-relaxed text-[var(--lp-ink)]">
        {state === "error" ? errorMsg : ""}
      </p>

      {state === "success" ? (
        <button
          type="button"
          onClick={reset}
          className="mt-3 min-h-11 rounded-lg px-3 text-sm font-medium text-[var(--lp-ink)] underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--lp-ink)]"
        >
          Send another message
        </button>
      ) : (
        <form
          className="space-y-4"
          onSubmit={handleSubmit}
          aria-busy={state === "loading"}
        >
          <div className="grid gap-4 md:grid-cols-2">
            <div className="hidden" aria-hidden="true">
              <label htmlFor={`${id}-website`}>Website</label>
              <input
                id={`${id}-website`}
                name="website"
                value={website}
                onChange={event => setWebsite(event.target.value)}
                autoComplete="off"
                tabIndex={-1}
              />
            </div>
            <div>
              <label htmlFor={`${id}-full-name`} className={labelClassName}>
                Full name
              </label>
              <input
                id={`${id}-full-name`}
                name="fullName"
                value={fields.fullName}
                onChange={event => setField("fullName", event.target.value)}
                placeholder="Your full name"
                className={fieldClassName}
                autoComplete="name"
                required
                type="text"
                disabled={state === "loading"}
              />
            </div>
            <div>
              <label htmlFor={`${id}-company-email`} className={labelClassName}>
                Company email
              </label>
              <input
                id={`${id}-company-email`}
                name="companyEmail"
                value={fields.companyEmail}
                onChange={event =>
                  setField("companyEmail", event.target.value)
                }
                placeholder="you@example.com"
                className={fieldClassName}
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                required
                type="email"
                disabled={state === "loading"}
              />
            </div>
          </div>

          <div>
            <label htmlFor={`${id}-message`} className={labelClassName}>
              How can we help?
            </label>
            <textarea
              id={`${id}-message`}
              name="message"
              value={fields.message}
              onChange={event => setField("message", event.target.value)}
              placeholder="Share what your team wants to accomplish"
              className={`${fieldClassName} min-h-40`}
              required
              disabled={state === "loading"}
            />
          </div>

          <button
            type="submit"
            disabled={!hydrated || state === "loading"}
            className="doc-button min-h-11 w-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--lp-ink)] disabled:opacity-60 sm:w-auto"
          >
            {state === "loading" ? "Sending…" : "Send message"}
          </button>
        </form>
      )}
    </section>
  );
}
