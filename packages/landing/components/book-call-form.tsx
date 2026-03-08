"use client";

import { useMemo, useState } from "react";

type Props = {
  calUrl: string;
};

const buildCalUrl = (baseUrl: string, params: Record<string, string>) => {
  try {
    const url = new URL(baseUrl);
    for (const [key, value] of Object.entries(params)) {
      if (!value) continue;
      url.searchParams.set(key, value);
    }
    return url.toString();
  } catch {
    return baseUrl;
  }
};

export function BookCallForm(props: Props) {
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");

  const href = useMemo(
    () => {
      if (!props.calUrl) return "";
      return buildCalUrl(props.calUrl, {
        email,
        company
      });
    },
    [props.calUrl, email, company]
  );

  return (
    <section id="book" className="landing-shell rounded-[2rem] p-6 md:p-8">
      <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">
        Book a call
      </div>
      <h3 className="mb-3 text-2xl font-medium tracking-tight text-[#011627]">
        Let us know how we can help.
      </h3>
      <p className="mb-6 max-w-md text-[15px] leading-relaxed text-slate-600">
        Share your team context and we&apos;ll route you into the right rollout
        path. You&apos;ll finish the details on the booking page.
      </p>

      <div className="mb-6 rounded-[1.5rem] border border-slate-200/70 bg-white/80 p-4 shadow-sm">
        <div className="text-[12px] font-semibold uppercase tracking-[0.2em] text-slate-400">
          Typical conversations
        </div>
        <div className="mt-3 space-y-2 text-[14px] leading-relaxed text-slate-600">
          <p>- Secure hosting model for your team</p>
          <p>- Permission boundaries and approval design</p>
          <p>- Moving from local-first to hosted workers</p>
        </div>
      </div>

      <form
        className="space-y-4"
        onSubmit={event => {
          event.preventDefault();
          if (!href) return;
          window.open(href, "_blank", "noopener,noreferrer");
        }}
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-2 block text-[12px] font-semibold uppercase tracking-[0.16em] text-slate-500">
              Company email
            </label>
            <input
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="jeff@amazon.com"
              className="w-full rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 text-[14px] text-[#011627] outline-none transition focus:border-slate-300 focus:bg-white"
              autoComplete="email"
              type="email"
            />
          </div>
          <div>
            <label className="mb-2 block text-[12px] font-semibold uppercase tracking-[0.16em] text-slate-500">
              Company
            </label>
            <input
              value={company}
              onChange={e => setCompany(e.target.value)}
              placeholder="Amazon"
              className="w-full rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 text-[14px] text-[#011627] outline-none transition focus:border-slate-300 focus:bg-white"
              autoComplete="organization"
            />
          </div>
        </div>

        <div className="rounded-[1.5rem] border border-slate-200/70 bg-slate-50/80 p-5 text-[13px] leading-relaxed text-slate-600">
          We&apos;ll prefill what we can, and you&apos;ll answer the rest on the
          booking page.
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          {props.calUrl ? (
            <button type="submit" className="doc-button w-full sm:w-auto">
              Continue to booking
            </button>
          ) : (
            <div className="rounded-2xl border border-slate-200/70 bg-slate-50/80 p-4 text-[13px] text-slate-500">
              Cal link not set yet.
            </div>
          )}
          {props.calUrl ? (
            <a
              href={props.calUrl}
              target="_blank"
              rel="noreferrer"
              className="text-[13px] font-medium text-slate-400 transition hover:text-[#011627]"
            >
              Open booking link
            </a>
          ) : null}
        </div>
      </form>
    </section>
  );
}
