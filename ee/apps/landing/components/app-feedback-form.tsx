"use client";

import { AlertCircle, CheckCircle2, MessageSquareText, Send } from "lucide-react";
import { useMemo, useState } from "react";

export type AppFeedbackPrefill = {
  source: string;
  entrypoint: string;
  deployment: string;
  appVersion: string;
  openworkServerVersion: string;
  opencodeVersion: string;
  orchestratorVersion: string;
  opencodeRouterVersion: string;
  osName: string;
  osVersion: string;
  platform: string;
};

type Props = {
  prefill: AppFeedbackPrefill;
};

type SubmitState = "idle" | "loading" | "success" | "error";

const INITIAL_MESSAGE = "";

export function AppFeedbackForm(props: Props) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState(INITIAL_MESSAGE);
  const [website, setWebsite] = useState("");
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [state, setState] = useState<SubmitState>("idle");
  const [errorMessage, setErrorMessage] = useState("");

  const contextItems = useMemo(
    () => [
      { label: "App version", value: props.prefill.appVersion },
      { label: "OpenWork server", value: props.prefill.openworkServerVersion },
      { label: "OpenCode", value: props.prefill.opencodeVersion },
      { label: "Orchestrator", value: props.prefill.orchestratorVersion },
      { label: "Router", value: props.prefill.opencodeRouterVersion },
      {
        label: "OS",
        value: [props.prefill.osName, props.prefill.osVersion].filter(Boolean).join(" "),
      },
      { label: "Platform", value: props.prefill.platform },
      { label: "Opened from", value: props.prefill.entrypoint },
      { label: "Deployment", value: props.prefill.deployment },
    ].filter((item) => item.value),
    [props.prefill],
  );

  const reset = () => {
    setName("");
    setEmail("");
    setMessage(INITIAL_MESSAGE);
    setWebsite("");
    setStartedAt(Date.now());
    setState("idle");
    setErrorMessage("");
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
      setErrorMessage("Please describe the issue before sending feedback.");
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
          context: props.prefill,
        }),
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        setState("error");
        setErrorMessage(
          data?.error ?? "Something went wrong while sending feedback.",
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

  return (
    <section className="landing-shell rounded-[2rem] p-6 md:p-8">
      <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-[1.5rem] border border-white/70 bg-white/85 p-6 shadow-sm backdrop-blur">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-slate-200/80 bg-slate-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
            <MessageSquareText size={12} />
            app feedback
          </div>
          <h1 className="max-w-2xl text-3xl font-semibold tracking-tight text-[#011627] md:text-4xl">
            Tell us what broke, felt rough, or needs polish.
          </h1>
          <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-slate-600">
            Your note goes to the OpenWork team with your contact details, app
            version, and runtime context already attached.
          </p>

          {state === "success" ? (
            <div className="mt-6 rounded-[1.5rem] border border-emerald-200 bg-emerald-50/90 p-5 text-emerald-900">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
                <div>
                  <div className="text-[15px] font-semibold">Feedback sent</div>
                  <p className="mt-1 text-[14px] leading-relaxed text-emerald-800">
                    Thanks. We received your note and the attached diagnostics.
                  </p>
                  <button
                    type="button"
                    onClick={reset}
                    className="mt-4 inline-flex items-center rounded-full border border-emerald-300 bg-white px-4 py-2 text-[13px] font-medium text-emerald-900 transition hover:border-emerald-400 hover:bg-emerald-100"
                  >
                    Send another message
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
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
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label className="mb-2 block text-[12px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Your name
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Jane Doe"
                    className="w-full rounded-[1.2rem] border border-slate-200 bg-white px-4 py-3 text-[15px] text-[#011627] outline-none transition focus:border-slate-300 focus:ring-4 focus:ring-slate-100"
                    disabled={state === "loading"}
                    autoComplete="name"
                    required
                  />
                </div>
                <div>
                  <label className="mb-2 block text-[12px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Your email
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="jane@company.com"
                    className="w-full rounded-[1.2rem] border border-slate-200 bg-white px-4 py-3 text-[15px] text-[#011627] outline-none transition focus:border-slate-300 focus:ring-4 focus:ring-slate-100"
                    disabled={state === "loading"}
                    autoComplete="email"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="mb-2 block text-[12px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                  What happened?
                </label>
                <textarea
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder="What were you trying to do? What did you expect? What actually happened?"
                  className="min-h-[220px] w-full rounded-[1.5rem] border border-slate-200 bg-white px-4 py-4 text-[15px] leading-relaxed text-[#011627] outline-none transition focus:border-slate-300 focus:ring-4 focus:ring-slate-100"
                  disabled={state === "loading"}
                  required
                />
              </div>

              {state === "error" ? (
                <div className="flex items-start gap-3 rounded-[1.25rem] border border-red-200 bg-red-50/90 px-4 py-3 text-[13px] leading-relaxed text-red-700">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>{errorMessage}</div>
                </div>
              ) : null}

              <button
                type="submit"
                disabled={state === "loading"}
                className="doc-button inline-flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Send size={16} />
                {state === "loading" ? "Sending..." : "Send feedback"}
              </button>
            </form>
          )}
        </div>

        <aside className="rounded-[1.5rem] border border-slate-200/80 bg-[#0b1728] p-5 text-white shadow-sm">
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-200/80">
            Attached context
          </div>
          <p className="mt-3 text-[14px] leading-relaxed text-slate-300">
            These details are captured from the app link so the team can triage
            the issue faster.
          </p>

          <div className="mt-5 grid gap-3">
            {contextItems.map((item) => (
              <div
                key={item.label}
                className="rounded-[1.15rem] border border-white/10 bg-white/5 px-4 py-3"
              >
                <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
                  {item.label}
                </div>
                <div className="mt-1 break-words font-mono text-[13px] text-white">
                  {item.value}
                </div>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </section>
  );
}
