"use client";

import { Mail } from "lucide-react";
import { useEffect, useState } from "react";

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

export function BookCallForm() {
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
        setErrorMsg(
          data?.error ?? "Something went wrong. Please try again."
        );
        return;
      }

      setState("success");
      setFields(initialFields);
    } catch (error) {
      setState("error");
      setErrorMsg(
        error instanceof Error
          ? error.message
          : "Something went wrong. Please try again."
      );
    }
  };

  return (
    <section id="book" className="rounded-[2rem] border border-gray-200 bg-white p-6 md:p-8">
      <div className="rounded-[1.5rem] border border-slate-200/70 bg-white p-5 md:p-6">
        <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-slate-200/70 bg-slate-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          <Mail size={12} />
          Get in touch with us
        </div>
        <h3 className="mb-3 text-2xl font-medium tracking-tight text-[#011627]">
          Tell us what you need.
        </h3>
        <p className="mb-6 max-w-2xl text-[15px] leading-relaxed text-slate-600">
          Share your team context and we&apos;ll get back to you over email.
        </p>

        {state === "success" ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50/80 p-4 text-[14px] leading-relaxed text-emerald-800">
            Thanks. We&apos;ve got your note and will follow up soon.
            <button
              type="button"
              onClick={reset}
              className="mt-3 block text-[13px] font-medium text-emerald-700 transition hover:text-emerald-900"
            >
              Send another message
            </button>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="hidden" aria-hidden="true">
                <label>
                  Website
                  <input
                    value={website}
                    onChange={event => setWebsite(event.target.value)}
                    autoComplete="off"
                    tabIndex={-1}
                  />
                </label>
              </div>
              <div>
                <label className="mb-2 block text-[12px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Full name
                </label>
                <input
                  value={fields.fullName}
                  onChange={event => setField("fullName", event.target.value)}
                  placeholder="Jeff Bezos"
                  className="w-full rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 text-[14px] text-[#011627] outline-none transition focus:border-slate-300 focus:bg-white"
                  autoComplete="name"
                  required
                  type="text"
                  disabled={state === "loading"}
                />
              </div>
              <div>
                <label className="mb-2 block text-[12px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Company email
                </label>
                <input
                  value={fields.companyEmail}
                  onChange={event =>
                    setField("companyEmail", event.target.value)
                  }
                  placeholder="jeff@amazon.com"
                  className="w-full rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 text-[14px] text-[#011627] outline-none transition focus:border-slate-300 focus:bg-white"
                  autoComplete="email"
                  required
                  type="email"
                  disabled={state === "loading"}
                />
              </div>
            </div>

            <div>
              <label className="mb-2 block text-[12px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                How can we help?
              </label>
              <textarea
                value={fields.message}
                onChange={event => setField("message", event.target.value)}
                placeholder="Share more about what you want to accomplish"
                className="min-h-[160px] w-full rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 text-[14px] text-[#011627] outline-none transition focus:border-slate-300 focus:bg-white"
                required
                disabled={state === "loading"}
              />
            </div>

            {state === "error" ? (
              <div className="rounded-2xl border border-red-200 bg-red-50/80 px-4 py-3 text-[13px] leading-relaxed text-red-700">
                {errorMsg}
              </div>
            ) : null}

            <button
              type="submit"
              disabled={!hydrated || state === "loading"}
              className="doc-button w-full sm:w-auto disabled:opacity-60"
            >
              {!hydrated
                ? "Loading..."
                : state === "loading"
                  ? "Sending..."
                  : "Get in touch"}
            </button>
          </form>
        )}
      </div>
    </section>
  );
}
