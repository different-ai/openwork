import {
  PlugZap,
  Rocket,
  ShieldCheck,
  Users
} from "lucide-react";
import { BookCallForm } from "./book-call-form";
import { LandingBackground } from "./landing-background";
import { SiteFooter } from "./site-footer";
import { SiteNav } from "./site-nav";

type Props = {
  stars: string;
  downloadHref: string;
  calUrl: string;
};

const deploymentModes = [
  {
    title: "Easy for every team",
    description:
      "Give nontechnical users a desktop app they can install quickly and use without learning developer tools.",
    icon: Users
  },
  {
    title: "Preconfigured environment",
    description:
      "Start with your gateway, MCP servers, skills, and internal data sources already connected.",
    icon: PlugZap
  },
  {
    title: "Guardrails built in",
    description:
      "Set permissions, tool boundaries, and approved workflows so teams can use agentic workflows safely.",
    icon: ShieldCheck
  }
];

const rolloutSteps = [
  "Start with one workflow that has a clear owner.",
  "Run it through your approved gateway with permissions in place.",
  "Package what works into shared skills for broader rollout."
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
              Secure, permissioned agentic workflows for enterprise teams.
            </h1>

            <p className="max-w-3xl text-lg leading-relaxed text-slate-600 md:text-xl">
              Run agentic workflows through your existing gateway, with
              approved tools, clear permissions, and a rollout path your
              non-technical teams can actually use, whether you self-host in
              your own infrastructure or deploy with OpenWork. Enterprise
              licensing includes Windows support.
            </p>

            <div className="mt-8 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
              <a
                href={props.calUrl || "#book"}
                target={props.calUrl ? "_blank" : undefined}
                rel={props.calUrl ? "noreferrer" : undefined}
                className="doc-button"
              >
                Book a call
              </a>

              <div className="flex items-center gap-2 opacity-80 sm:ml-4">
                <span className="text-[13px] font-medium text-gray-500">
                  Backed by
                </span>
                <div className="flex items-center gap-1.5">
                  <div className="flex h-[18px] w-[18px] items-center justify-center rounded-[4px] bg-[#ff6600] text-[11px] font-bold leading-none text-white">
                    Y
                  </div>
                  <span className="text-[13px] font-semibold tracking-tight text-gray-600">
                    Combinator
                  </span>
                </div>
              </div>
            </div>

            <div className="mt-4">
              <a href="/trust" className="text-[14px] font-medium text-[#011627] transition-colors hover:text-slate-700">
                Trust details
              </a>
            </div>
          </section>

          <section className="space-y-6">
            <div className="landing-shell rounded-[2rem] p-6 md:p-8">
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-blue-100 bg-blue-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-blue-700">
                <Rocket size={12} />
                Pilot and rollout
              </div>
              <div className="grid gap-4 md:grid-cols-[1.1fr_0.9fr]">
                <div>
                  <h3 className="mb-3 text-2xl font-medium tracking-tight text-[#011627]">
                    Start with one workflow. Expand once it works.
                  </h3>
                  <p className="text-[15px] leading-relaxed text-slate-600">
                    Most teams should begin with a focused use case, one
                    approved path to data, and clear guardrails. Once the
                    workflow works, it can be packaged and rolled out more
                    broadly.
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
            </div>

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

            <div className="grid gap-6 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <div className="landing-shell rounded-[2rem] p-6 md:p-8">
                <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-emerald-100 bg-emerald-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-700">
                  <ShieldCheck size={12} />
                  Information security
                </div>
                <h3 className="mb-3 text-2xl font-medium tracking-tight text-[#011627]">
                  Compliance-ready agentic workflows
                </h3>
                <p className="max-w-3xl text-[15px] leading-relaxed text-slate-600">
                  OpenWork helps organizations run agentic workflows with a
                  local-first, permission-aware architecture built for privacy,
                  access control, and deployment flexibility across HIPAA, SOC 2
                  Type II, ISO 27001, CCPA, and GDPR-sensitive environments.
                </p>
              </div>

              <div className="landing-shell rounded-[2rem] p-6">
                <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-blue-100 bg-blue-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-blue-700">
                  <PlugZap size={12} />
                  Deployment
                </div>
                <h3 className="mb-3 text-[1.35rem] font-medium tracking-tight text-[#011627]">
                  Self-hosted or managed
                </h3>
                <p className="text-[14px] leading-relaxed text-slate-600">
                  Deploy inside your own environment or work with us on a
                  managed rollout, with your gateway, MCP servers, skills, and
                  internal data sources connected. Windows support is included in
                  enterprise licensing.
                </p>
              </div>
            </div>

            <BookCallForm />
          </section>

          <SiteFooter />
        </main>
      </div>
    </div>
  );
}
