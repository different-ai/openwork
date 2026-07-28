import Link from "next/link";
import { AppFeedbackForm, type AppFeedbackPrefill } from "../../components/app-feedback-form";
import { OpenWorkMark } from "../../components/openwork-mark";
import { SiteFooter } from "../../components/site-footer";
import { baseOpenGraph } from "../../lib/seo";

export const metadata = {
  title: "OpenWork — Contact",
  description: "Contact the OpenWork team for product, support, security, and sales questions.",
  alternates: {
    canonical: "/contact",
  },
  openGraph: {
    ...baseOpenGraph,
    url: "https://openworklabs.com/contact",
  },
};

const prefill: AppFeedbackPrefill = {
  source: "openwork-contact-page",
  entrypoint: "/contact",
  deployment: "landing",
  appVersion: "",
  openworkServerVersion: "",
  opencodeVersion: "",
  osName: "",
  osVersion: "",
  platform: "web",
};

export default function ContactPage() {
  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(72,187,255,0.14),_transparent_34%),linear-gradient(180deg,_#f7fbff_0%,_#edf4fb_100%)]">
      <div className="mx-auto max-w-5xl px-6 pb-20 pt-6 md:px-8 md:pt-8">
        <header className="mb-10 flex items-center justify-between gap-4">
          <Link href="/" className="inline-flex items-center gap-3 text-[#011627]">
            <OpenWorkMark className="h-[30px] w-[38px]" />
            <span className="text-[1.2rem] font-semibold tracking-tight lowercase">
              OpenWork
            </span>
          </Link>
          <Link
            href="/download"
            className="rounded-full border border-white/80 bg-white/80 px-4 py-2 text-[13px] font-medium text-slate-700 shadow-sm transition hover:bg-white"
          >
            Download latest app
          </Link>
        </header>

        <AppFeedbackForm prefill={prefill} mode="contact" />
        <SiteFooter />
      </div>
    </div>
  );
}
