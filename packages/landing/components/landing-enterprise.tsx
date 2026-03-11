import Link from "next/link";
import {
  ArrowRight,
  Cloud,
  LockKeyhole,
  Rocket,
  Sparkles,
  Workflow
} from "lucide-react";
import { BookCallForm } from "./book-call-form";
import { LandingBackground } from "./landing-background";
import { OpenCodeLogo } from "./opencode-logo";
import { SiteFooter } from "./site-footer";
import { SiteNav } from "./site-nav";

type Props = {
  stars: string;
  downloadHref: string;
  calUrl: string;
};

const deploymentModes = [
  {
    title: "Desktop-hosted app/server",
    description:
      "Start local-first with approvals, existing skills, and the same control surface your operators already use.",
    icon: LockKeyhole
  },
  {
    title: "CLI-hosted server",
    description:
      "Run OpenWork server surfaces from a trusted machine without inventing a parallel control plane.",
    icon: Workflow
  },
  {
    title: "Hosted OpenWork Cloud",
    description:
      "Move the same workflows into hosted workers when a team needs always-on execution and managed isolation.",
    icon: Cloud
  }
];

const rolloutSteps = [
  "Map the workflows your team wants to automate first.",
  "Set clear boundaries for workers, approvals, and access levels.",
  "Pilot with one team, then expand into hosted workers or shared skills."
];

export function LandingEnterprise(props: Props) {
  return (
    <div className="relative min-h-screen overflow-hidden text-[#011627]">
      <LandingBackground />

      <div className="relative z-10 flex min-h-screen flex-col items-center pb-3 pt-1 md:pb-4 md:pt-2">
        <div className="w-full">
          <SiteNav
            stars={props.stars}
            callUrl={props.calUrl}
            downloadHref={props.downloadHref}
            active="enterprise"
          />
        </div>

        <main className="mx-auto flex w-full max-w-5xl flex-col gap-16 px-6 pb-24 md:gap-20 md:px-8 md:pb-28">
          <section className="max-w-4xl">
            <div className="landing-chip mb-4 inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500">
              OpenWork Enterprise
            </div>

            <h1 className="mb-6 text-4xl font-medium leading-[1.05] tracking-tight md:text-5xl lg:text-6xl">
              Safe, permissioned{" "}
              <span className="font-pixel mx-1 inline-block align-middle text-[1.05em] font-normal">
                AI
              </span>
              employees for real teams.
            </h1>

            <p className="max-w-3xl text-lg leading-relaxed text-slate-600 md:text-xl">
              OpenWork runs local-first and scales into hosted workers when you
              need them. We help teams deploy the same agent workflows with
              clear permissions, auditable behavior, and a rollout path that
              non-technical coworkers can actually use.
            </p>

            <div className="mt-8 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
              <Link href="#book" className="doc-button">
                Book a call
              </Link>
              <Link
                href="/den"
                className="secondary-button"
              >
                Explore Den
              </Link>
            </div>

            <div className="mt-8 flex flex-wrap items-center gap-3 text-[13px] text-slate-500">
              <div className="landing-chip inline-flex items-center gap-2 rounded-full px-3 py-2">
                <OpenCodeLogo className="h-3 w-auto" />
                <span>Built on OpenCode primitives</span>
              </div>
              <div className="landing-chip inline-flex items-center gap-2 rounded-full px-3 py-2">
                <Sparkles size={14} className="text-sky-600" />
                <span>Local-first or hosted</span>
              </div>
              <div className="landing-chip inline-flex items-center gap-2 rounded-full px-3 py-2">
                <LockKeyhole size={14} className="text-emerald-600" />
                <span>Clear approvals and boundaries</span>
              </div>
            </div>
          </section>

          <section className="space-y-6">
              <div className="grid gap-6 md:grid-cols-3">
                {deploymentModes.map(mode => {
                  const Icon = mode.icon;

                  return (
                    <div
                      key={mode.title}
                      className="landing-shell rounded-[2rem] p-6"
                    >
                      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-100 text-[#011627] shadow-inner">
                        <Icon size={18} />
                      </div>
                      <h3 className="mb-2 text-[17px] font-medium tracking-tight text-[#011627]">
                        {mode.title}
                      </h3>
                      <p className="text-[14px] leading-relaxed text-slate-600">
                        {mode.description}
                      </p>
                    </div>
                  );
                })}
              </div>

              <div className="landing-shell rounded-[2rem] p-6 md:p-8">
                <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-blue-100 bg-blue-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-blue-700">
                  <Rocket size={12} />
                  Rollout pattern
                </div>
                <div className="grid gap-4 md:grid-cols-[1.1fr_0.9fr]">
                  <div>
                    <h3 className="mb-3 text-2xl font-medium tracking-tight text-[#011627]">
                      Start with the workflows that already matter.
                    </h3>
                    <p className="text-[15px] leading-relaxed text-slate-600">
                      Most teams should begin with one approval-sensitive
                      worker, one shared skill set, and one concrete business
                      process. Once that path is safe and legible, the same
                      model extends into OpenWork Cloud and Den.
                    </p>
                  </div>
                  <div className="space-y-3">
                    {rolloutSteps.map((step, index) => (
                      <div
                        key={step}
                        className="flex gap-3 rounded-2xl border border-slate-200/70 bg-white/85 px-4 py-4 shadow-sm"
                      >
                        <div className="step-circle shrink-0">{index + 1}</div>
                        <p className="text-[14px] leading-relaxed text-slate-600">
                          {step}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="mt-6 inline-flex items-center gap-2 text-[14px] font-medium text-slate-600">
                  <Link
                    href="/den"
                    className="inline-flex items-center gap-2 transition-colors hover:text-[#011627]"
                  >
                    Hosted workers continue into Den
                    <ArrowRight size={14} />
                  </Link>
                </div>
              </div>

            <BookCallForm calUrl={props.calUrl} />
          </section>

          <SiteFooter />
        </main>
      </div>
    </div>
  );
}
