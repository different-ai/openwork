"use client";

import { CheckCircle2, Lock, Workflow, Zap } from "lucide-react";

const steps = [
  {
    title: "1. Context Setup",
    body: "Define .opencode/skills and attach data sources via MCP.",
    icon: Workflow,
    accent: "bg-[#1b29ff]/10 text-[#1b29ff]",
  },
  {
    title: "2. Event Trigger",
    body: "Cloud workers wake up on webhooks or scheduled polling intervals.",
    icon: Zap,
    accent: "bg-orange-500/10 text-orange-600",
  },
  {
    title: "3. Isolated Compute",
    body: "A sandboxed runtime spins up automatically to process the workload securely.",
    icon: Lock,
    accent: "bg-teal-500/10 text-teal-600",
  },
  {
    title: "4. Review & Merge",
    body: "The worker proposes changes via PRs or messaging platforms.",
    icon: CheckCircle2,
    accent: "bg-[linear-gradient(180deg,#eceff3,#dfe4ea)] text-[#111827] ring-1 ring-[#d7dde5]",
  },
];

export function DenHowItWorks() {
  return (
    <section className="landing-shell rounded-[2rem] p-7 md:p-8">
      <div className="mb-6 max-w-3xl">
        <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-gray-500">
          How it works
        </div>
        <h3 className="mb-4 text-[2rem] font-medium leading-tight tracking-tight text-[#011627]">
          From trigger to completion.
        </h3>
        <p className="text-[16px] leading-8 text-gray-600">
          We turn your defined skills into an automated workflow. Cloud workers operate independently in the cloud, unblocking your team.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-4">
        {steps.map(step => {
          const Icon = step.icon;

          return (
            <div
              key={step.title}
              className="rounded-2xl border border-slate-100 bg-white/40 p-5 transition-colors hover:bg-white/60"
            >
              <div className={`mb-3 flex h-9 w-9 items-center justify-center rounded-xl ${step.accent}`}>
                <Icon size={17} strokeWidth={2.4} />
              </div>
              <div className="mb-1.5 text-[14px] font-semibold text-[#011627]">
                {step.title}
              </div>
              <p className="text-[13px] leading-relaxed text-gray-500">
                {step.body}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
