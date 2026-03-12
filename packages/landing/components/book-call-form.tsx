"use client";

import { Cloud, LockKeyhole, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";

type Props = {
  calUrl: string;
};

const conversationTopics = [
  {
    title: "Secure hosting model",
    icon: LockKeyhole
  },
  {
    title: "Permission boundaries",
    icon: ShieldCheck
  },
  {
    title: "Hosted worker rollout",
    icon: Cloud
  }
];

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
      <p className="mb-6 max-w-2xl text-[15px] leading-relaxed text-slate-600">
        Share your team context and we&apos;ll route you into the right rollout
        path. You&apos;ll finish the details on the booking page.
      </p>

      <div className="mb-6 rounded-[1.5rem] border border-slate-200/70 bg-white/80 p-4 shadow-sm md:p-5">
        <div className="text-[12px] font-semibold uppercase tracking-[0.2em] text-slate-400">
          Typical conversations
        </div>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {conversationTopics.map((topic) => {
            const Icon = topic.icon;

            return (
              <div
                key={topic.title}
                className="flex items-center gap-3 rounded-2xl border border-slate-200/70 bg-slate-50/80 px-4 py-3.5"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-[#011627] shadow-inner">
                  <Icon size={16} />
                </div>
                <div className="text-[13px] font-medium leading-snug text-slate-600 sm:text-[14px]">
                  {topic.title}
                </div>
              </div>
            );
          })}
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
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,0.85fr)_auto_auto] lg:items-end">
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
          {props.calUrl ? (
            <>
              <a
                href={props.calUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-[52px] items-center justify-center whitespace-nowrap px-3 text-[13px] font-medium text-slate-400 transition hover:text-[#011627] lg:self-end"
              >
                Open booking link
              </a>
              <button
                type="submit"
                className="doc-button w-full lg:w-auto lg:self-end"
              >
                Book a call
              </button>
            </>
          ) : (
            <div className="lg:col-span-2">
              <div className="rounded-2xl border border-slate-200/70 bg-slate-50/80 p-4 text-[13px] text-slate-500">
                Cal link not set yet.
              </div>
            </div>
          )}
        </div>
      </form>
    </section>
  );
}
