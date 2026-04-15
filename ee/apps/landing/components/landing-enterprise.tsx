"use client";

import {
  Cloud,
  Monitor,
  PlugZap,
  ShieldCheck,
  Users
} from "lucide-react";
import { useState } from "react";
import { BookCallForm } from "./book-call-form";
import { LandingAppDemoPanel } from "./landing-app-demo-panel";
import { LandingBackground } from "./landing-background";
import {
  defaultLandingDemoFlowId,
  landingDemoFlows,
  landingDemoFlowTimes
} from "./landing-demo-flows";
import { SiteFooter } from "./site-footer";
import { SiteNav } from "./site-nav";

type Props = {
  stars: string;
  downloadHref: string;
  calUrl: string;
};

const stackItems = [
  {
    id: "desktop",
    title: "Desktop app",
    description:
      "Employees get an easy-to-use desktop app with your shared skills and plugins ready to run.",
    icon: Monitor
  },
  {
    id: "cloud",
    title: "Cloud",
    description:
      "Admins set guardrails, providers, and policy controls, then deploy workflows across the organisation.",
    icon: Cloud,
    imageSrc: "/stack-cloud-dashboard.png"
  },
  {
    id: "skill-hub",
    title: "Skill Hub",
    description:
      "Publish reusable workflows and team-specific skill packs from one place.",
    icon: PlugZap,
    imageSrc: "/stack-skill-hub.png"
  },
  {
    id: "onboarding",
    title: "Custom onboarding",
    description:
      "Roll out the right tools, context, and templates for each team from day one.",
    icon: ShieldCheck,
    imageSrc: "/stack-custom-onboarding.png"
  }
];

export function LandingEnterprise(props: Props) {
  const [activeStackDemoId, setActiveStackDemoId] = useState(defaultLandingDemoFlowId);

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
            <h1 className="mb-6 text-4xl font-medium leading-[1.05] tracking-tight md:text-5xl lg:text-6xl">
              The Open Source alternative to Claude Cowork.
            </h1>

            <p className="max-w-3xl text-lg leading-relaxed text-slate-600 md:text-xl">
              Get your entire organisation running on shared skills, plugins,
              and AI workflows. Bring your own LLM providers, choose from 50+
              supported models, and integrate with LiteLLM out of the box.
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
            <div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {stackItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <div
                      key={item.title}
                      className="flex flex-col overflow-hidden rounded-xl border border-gray-200 bg-white"
                    >
                      <div className="flex h-[220px] items-center justify-center bg-gray-50/60 p-4 md:h-[280px]">
                        {item.id === "desktop" ? (
                          <div className="h-full w-full overflow-hidden rounded-lg border border-gray-200 bg-white">
                            <div className="relative flex h-7 items-center border-b border-gray-100 bg-gradient-to-b from-white to-gray-50 px-3">
                              <div className="flex gap-1.5">
                                <div className="h-2 w-2 rounded-full bg-[#ff5f56]"></div>
                                <div className="h-2 w-2 rounded-full bg-[#ffbd2e]"></div>
                                <div className="h-2 w-2 rounded-full bg-[#27c93f]"></div>
                              </div>
                              <div className="absolute left-1/2 -translate-x-1/2 text-[10px] font-medium tracking-wide text-gray-500">
                                OpenWork
                              </div>
                            </div>
                            <div className="h-[calc(100%-1.75rem)] overflow-hidden">
                              <div className="origin-top-left scale-[0.58]">
                                <div className="w-[172.413793%] bg-white">
                                  <LandingAppDemoPanel
                                    flows={landingDemoFlows}
                                    activeFlowId={activeStackDemoId}
                                    onSelectFlow={setActiveStackDemoId}
                                    timesById={landingDemoFlowTimes}
                                  />
                                </div>
                              </div>
                            </div>
                          </div>
                        ) : item.imageSrc ? (
                          <img
                            src={item.imageSrc}
                            alt={`${item.title} interface`}
                            className={`h-full w-full rounded-md ${
                              item.id === "skill-hub" || item.id === "onboarding"
                                ? "object-cover object-center scale-[1.02]"
                                : "object-cover object-top"
                            }`}
                          />
                        ) : (
                          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-white text-[#011627]">
                            <Icon size={18} />
                          </div>
                        )}
                      </div>
                      <div className="border-t border-gray-100 p-5">
                        <h4 className="text-[16px] font-medium tracking-tight text-[#011627]">
                          {item.title}
                        </h4>
                        <p className="mt-1 text-[14px] text-gray-500">
                          {item.description}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="grid gap-6 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <div className="rounded-[2rem] border border-gray-200 bg-white p-6 md:p-8">
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

              <div className="rounded-[2rem] border border-gray-200 bg-white p-6">
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
                  internal data sources connected.
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
