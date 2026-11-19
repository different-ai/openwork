"use client";

import { AlertCircle, ArrowLeft, Check, CheckCircle2, Copy } from "lucide-react";
import { useMemo, useState } from "react";

export type AppFeedbackPrefill = {
  source: string;
  entrypoint: string;
  deployment: string;
  appVersion: string;
  openworkServerVersion: string;
  opencodeVersion: string;
  osName: string;
  osVersion: string;
  platform: string;
};

type Props = {
  prefill: AppFeedbackPrefill;
  mode?: "feedback" | "contact";
};

type SubmitState = "idle" | "loading" | "success" | "error";

/* What the page says. "roadmap" is the feedback form opened from /roadmap:
 * it is sent as ordinary feedback, and asks what to build rather than what broke. */
type Variant = "feedback" | "roadmap" | "contact";

type Copy = {
  eyebrow: string;
  heading: string;
  intro: string;
  messageLabel: string;
  placeholder: string;
  missingMessage: string;
  submit: string;
  successTitle: string;
  successBody: string;
  again: string;
};

const COPY: Record<Variant, Copy> = {
  feedback: {
    eyebrow: "Feedback",
    heading: "Tell us what broke, felt rough, or needs polish.",
    intro: "Your note goes straight to the OpenWork team.",
    messageLabel: "What happened?",
    placeholder: "What were you trying to do? What did you expect? What actually happened?",
    missingMessage: "Please describe the issue before sending feedback.",
    submit: "Send feedback",
    successTitle: "Feedback sent",
    successBody: "Thanks. We received your note.",
    again: "Send another message",
  },
  roadmap: {
    eyebrow: "Roadmap",
    heading: "What should we build next?",
    intro:
      "Tell us what you want OpenWork to do, or which item on the roadmap matters most to you. Your note goes straight to the team.",
    messageLabel: "What would you like to see?",
    placeholder: "What are you trying to get done? What is missing today?",
    missingMessage: "Please add your note before sending.",
    submit: "Send feedback",
    successTitle: "Feedback sent",
    successBody: "Thanks. We received your note.",
    again: "Send another note",
  },
  contact: {
    eyebrow: "Contact",
    heading: "Have questions about OpenWork?",
    intro: "Send the OpenWork team a note about sales, security, support, or anything else you want to ask.",
    messageLabel: "How can we help?",
    placeholder: "Tell us what you are working on or what you would like to know.",
    missingMessage: "Please add your question before sending.",
    submit: "Send question",
    successTitle: "Message sent",
    successBody: "Thanks. We received your note and will follow up by email.",
    again: "Send another question",
  },
};

const INITIAL_MESSAGE = "";
const TEAM_EMAIL = "team@openworklabs.com";

export function AppFeedbackForm(props: Props) {
  const mode = props.mode ?? "feedback";
  const variant: Variant =
    mode === "contact" ? "contact" : props.prefill.source === "roadmap" ? "roadmap" : "feedback";
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState(INITIAL_MESSAGE);
  const [emailCopied, setEmailCopied] = useState(false);
  const [website, setWebsite] = useState("");
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [state, setState] = useState<SubmitState>("idle");
  const [errorMessage, setErrorMessage] = useState("");

  /* Only what the app link really carried: the contact page and the roadmap have nothing to show. */
  const contextItems = useMemo(
    () => variant !== "feedback" ? [] : [
      { label: "App version", value: props.prefill.appVersion },
      { label: "OpenWork server", value: props.prefill.openworkServerVersion },
      { label: "OpenCode", value: props.prefill.opencodeVersion },
      {
        label: "OS",
        value: [props.prefill.osName, props.prefill.osVersion].filter(Boolean).join(" "),
      },
      { label: "Platform", value: props.prefill.platform },
      {
        label: "Opened from",
        value: props.prefill.entrypoint === "unknown" ? "" : props.prefill.entrypoint,
      },
      { label: "Deployment", value: props.prefill.deployment },
    ].filter((item) => item.value),
    [props.prefill, variant],
  );
  const base = COPY[variant];
  const copy: Copy =
    contextItems.length > 0
      ? {
          ...base,
          intro: "Your note goes to the OpenWork team with your contact details and the app details below.",
          successBody: "Thanks. We received your note and the attached app details.",
        }
      : base;

  const reset = () => {
    setName("");
    setEmail("");
    setMessage(INITIAL_MESSAGE);
    setWebsite("");
    setStartedAt(Date.now());
    setState("idle");
    setErrorMessage("");
  };

  const copyTeamEmail = async () => {
    await navigator.clipboard.writeText(TEAM_EMAIL);
    setEmailCopied(true);
    window.setTimeout(() => setEmailCopied(false), 1800);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    const trimmed = message.trim();
    if (!trimmedName) {
      setState("error");
      setErrorMessage("Please add your name so we know who sent this.");
      return;
    }

    if (!trimmedEmail) {
      setState("error");
      setErrorMessage("Please add your email so we can follow up.");
      return;
    }

    if (!trimmed) {
      setState("error");
      setErrorMessage(copy.missingMessage);
      return;
    }

    setState("loading");
    setErrorMessage("");

    try {
      const response = await fetch("/api/app-feedback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: trimmedName,
          email: trimmedEmail,
          message: trimmed,
          website,
          startedAt,
          mode,
          context: props.prefill,
        }),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as
          | { error?: string; message?: string }
          | null;
        setState("error");
        setErrorMessage(
          data?.message ?? data?.error ?? "Something went wrong while sending feedback.",
        );
        return;
      }

      setState("success");
      setMessage(INITIAL_MESSAGE);
    } catch (error) {
      setState("error");
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Something went wrong while sending feedback.",
      );
    }
  };

  const fieldClass =
    "w-full rounded-xl border border-[var(--lp-border)] bg-white px-4 text-[16px] text-[var(--lp-ink)] outline-none transition-colors placeholder:text-[#9AA5BA] hover:border-[#CBD2DC] focus:border-[var(--lp-ink)] disabled:opacity-60";
  const labelClass = "mb-2 block text-[14px] font-medium text-[var(--lp-ink)]";

  return (
    <section className="grid gap-12 pb-8 pt-12 md:pt-20 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-24">
      <div>
        {variant === "roadmap" ? (
          <a
            href="/roadmap"
            className="inline-flex items-center gap-1.5 text-[15px] text-[var(--lp-muted)] underline-offset-4 hover:text-[var(--lp-ink)] hover:underline"
          >
            <ArrowLeft size={15} strokeWidth={2} aria-hidden="true" />
            Roadmap
          </a>
        ) : (
          <p className="text-[15px] text-[var(--lp-muted)]">{copy.eyebrow}</p>
        )}
        <h1 className="mt-5 text-[clamp(2.25rem,4vw,3.25rem)] font-medium leading-[1.08] tracking-[-0.045em]">
          {copy.heading}
        </h1>
        <p className="mt-6 max-w-[460px] text-[17px] leading-[1.6] text-[var(--lp-body)]">{copy.intro}</p>

        <p className="mt-8 flex flex-wrap items-center gap-x-3 gap-y-2 text-[15px] text-[var(--lp-muted)]">
          <span>
            Prefer email?{" "}
            <a
              className="font-medium text-[var(--lp-ink)] underline-offset-4 hover:underline"
              href={`mailto:${TEAM_EMAIL}`}
            >
              {TEAM_EMAIL}
            </a>
          </span>
          <button
            type="button"
            onClick={() => void copyTeamEmail()}
            className="inline-flex h-7 items-center gap-1.5 rounded-full border border-[var(--lp-border)] bg-white px-2.5 text-[13px] text-[var(--lp-ink)] transition-colors hover:bg-[#F8FAFC]"
          >
            {emailCopied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
            {emailCopied ? "Copied" : "Copy"}
          </button>
        </p>

        {contextItems.length > 0 ? (
          <div className="mt-10 max-w-[460px]">
            <h2 className="text-[14px] font-medium">Sent with your note</h2>
            <dl className="mt-3 border-b border-[var(--lp-border)]">
              {contextItems.map((item) => (
                <div
                  key={item.label}
                  className="flex items-baseline justify-between gap-6 border-t border-[var(--lp-border)] py-2.5"
                >
                  <dt className="shrink-0 text-[14px] text-[var(--lp-muted)]">{item.label}</dt>
                  <dd className="min-w-0 break-words text-right font-mono text-[13px] text-[var(--lp-ink)]">
                    {item.value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ) : null}
      </div>

      <div className="lg:pt-[52px]">
        {state === "success" ? (
          <div role="status" className="rounded-2xl bg-[var(--lp-tonal)] p-6 md:p-8">
            <CheckCircle2 className="h-6 w-6 text-[var(--lp-status)]" aria-hidden="true" />
            <h2 className="mt-4 text-[22px] font-medium leading-[28px] tracking-[-0.02em]">{copy.successTitle}</h2>
            <p className="mt-2 text-[16px] leading-[1.6] text-[var(--lp-body)]">{copy.successBody}</p>
            <div className="mt-6 flex flex-wrap gap-3">
              {variant === "roadmap" ? (
                <a href="/roadmap" className="lp-pill-primary lp-pill-sm">
                  Back to the roadmap
                </a>
              ) : null}
              <button type="button" onClick={reset} className="lp-pill-secondary lp-pill-sm">
                {copy.again}
              </button>
            </div>
          </div>
        ) : (
          <form className="space-y-5" onSubmit={handleSubmit} noValidate>
            <div className="hidden" aria-hidden="true">
              <label>
                Website
                <input
                  type="text"
                  value={website}
                  onChange={(event) => setWebsite(event.target.value)}
                  autoComplete="off"
                  tabIndex={-1}
                />
              </label>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <label htmlFor="feedback-name" className={labelClass}>
                  Your name
                </label>
                <input
                  id="feedback-name"
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Jane Doe"
                  className={`${fieldClass} h-12`}
                  disabled={state === "loading"}
                  autoComplete="name"
                  required
                />
              </div>
              <div>
                <label htmlFor="feedback-email" className={labelClass}>
                  Your email
                </label>
                <input
                  id="feedback-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="jane@company.com"
                  className={`${fieldClass} h-12`}
                  disabled={state === "loading"}
                  autoComplete="email"
                  required
                />
              </div>
            </div>

            <div>
              <label htmlFor="feedback-message" className={labelClass}>
                {copy.messageLabel}
              </label>
              <textarea
                id="feedback-message"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder={copy.placeholder}
                className={`${fieldClass} block min-h-[200px] py-3.5 leading-[1.6]`}
                disabled={state === "loading"}
                required
              />
            </div>

            {state === "error" ? (
              <p role="alert" className="flex items-start gap-2 text-[14px] leading-[1.5] text-red-700">
                <AlertCircle className="mt-[3px] h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{errorMessage}</span>
              </p>
            ) : null}

            <button
              type="submit"
              disabled={state === "loading"}
              className="lp-pill-primary disabled:cursor-not-allowed disabled:opacity-60"
            >
              {state === "loading" ? "Sending..." : copy.submit}
            </button>
          </form>
        )}
      </div>
    </section>
  );
}
